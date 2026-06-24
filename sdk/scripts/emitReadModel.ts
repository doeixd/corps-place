// Emit the precomputed read-model (READ_MODEL_PLAN §5).
//
// Runs every page builder ONCE against the big dci-relational.db (read-only) and
// freezes the results into a small, flat, indexed read-model.db whose every read
// is an indexed key lookup — no CTEs, no fuzzy matching, no 3.4 GB file on the
// request path. Builders are shared with the live services (sdk/src/readModel/
// builders) so the emitted rows can't drift from what the services compute.
//
// Usage:
//   npx tsx scripts/emitReadModel.ts                  # build sdk/read-model.db
//   npx tsx scripts/emitReadModel.ts --dry-run        # run builders, write nothing
//   npx tsx scripts/emitReadModel.ts --source <path> --out <path>
//   npx tsx scripts/emitReadModel.ts --only events,corps   # inspection only —
//       a partial --only emit writes <stem>.partial.db and does NOT flip the live
//       pointer (other sections would be empty). Use a full emit to publish.
//   npx tsx scripts/emitReadModel.ts --json-snapshot ../public/read-model
//       (the served public/ dir is the repo-root public/, NOT app/public/ — the
//        ingest workflow resolves ../public/read-model from sdk/.)
//
// Distribution: this writes the LOCAL read-model only. To publish to prod/dev,
// push it to R2 (`npm run push:data read-model`) — the serving container pulls it
// on boot. See scripts/pushData.ts and docs/DEPLOYMENT_REALITY.md §5.
//
// Safety: the source is opened read-only; the target is written to a temp file
// and atomically renamed, so a running server never sees a half-written DB and a
// failed emit leaves the previous read-model.db intact.

import { createClient, type Client } from "@libsql/client";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildAllEventAbouts,
  buildAllEvents,
  buildAllShowDetail,
  buildAllShowInfo,
  buildAllShowTitles,
  buildCompetitionSlugForSeasonEvent,
  buildCorpsAppearanceResults,
  buildCorpsBySlug,
  buildCorpsDirectory,
  buildCorpsSeasonScores,
  buildEventRecap,
  buildEventFullRecap,
  buildEventSchedule,
  buildEventSeasonOptions,
  buildEventSeriesCandidates,
  buildEventsForSeason,
  buildEventSlugsForCorps,
  buildJudgeDirectory,
  buildJudgeProfile,
  buildAllStaffProfiles,
  buildStaffDirectory,
  buildStaffProfile,
  buildLatestPredictionSummary,
  buildPredictedEventSlugs,
  buildHomeWeekendShows,
  buildLatestResults,
  buildSeasonStandings,
  buildMerchCatalogIndex,
  buildMerchProductDetails,
  buildMerchStores,
  buildMerchFacets,
  buildCorpsMerchTeasers,
  buildFantasyDraftPool,
  buildFantasyPriorFinals,
  buildFantasySeasonBest,
  buildFantasySeasonFinals,
  type EventDirectoryRow,
} from "../src/readModel/builders/index.js";
import {
  readAllEvents,
  readCorpsAppearanceEventIds,
  readCorpsDirectory,
  readCorpsSeasonScores,
  readEventFullRecap,
  readEventsByIds,
  readJudgeDirectory,
  readPredictionPageData,
} from "../src/readModel/readers.js";

// Bump when rm_* schema changes incompatibly. v2: + season_prediction_* columns
// on rm_events and the rm_show_titles table. v3: + rm_event_full_recap table.
// v4: rm_judges.summary_json gains captionBreakdown + photo_url.
// v5: rm_corps gains corps_logo_dark + corps_logo_dark_url (dark-mode logo source).
// v6: + rm_home_weekend_shows table (home "shows this weekend, near you" carousel).
// v7: rm_corps gains color_primary + color_secondary + color_source (per-corps
//     brand accent colors; the UI derives accents/chart colors via corpsColors.ts).
// v8: + rm_show_info table with title + repertoire JSON for lineup context.
// v9: + rm_corps_appearance_results table (per-appearance place + total on the
//     corps profile's appearance cards).
// v10: + rm_merch_meta / rm_merch_product / rm_merch_corps_teaser (merch catalog,
//      facets, store directory, product detail, corps teaser → served via Turso).
// v11: + rm_staff / rm_staff_detail (staff directory + per-person profile).
// v12: rm_staff_detail.detail_json gains performed[] (grounded corps marched in) + bioFacts
//      {education, awards, performedOther, hometown, currentPosition} mined from bio prose (S3).
// v13: + rm_fantasy_draft_pool / rm_fantasy_prior_finals / rm_fantasy_season_best /
//      rm_fantasy_season_finals — the four score-DB reads the fantasy draft needs, so the
//      serving container can run drafts without the 3.4 GB relational DB (UI/UX plan §2.1).
const SCHEMA_VERSION = 13;

type Section =
  | "events"
  | "corps"
  | "recaps"
  | "judges"
  | "staff"
  | "predictions"
  | "shows"
  | "home"
  | "merch"
  | "fantasy";
const ALL_SECTIONS: Section[] = [
  "events",
  "corps",
  "recaps",
  "judges",
  "staff",
  "predictions",
  "shows",
  "home",
  "merch",
  "fantasy",
];

interface Args {
  source: string;
  out: string;
  dryRun: boolean;
  only: Section[];
  jsonSnapshot?: string;
}

export const parseArgs = (argv: string[]): Args => {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sdkRoot = path.resolve(process.cwd());
  const defaultSource =
    process.env.DCI_RELATIONAL_DB_URL?.replace(/^file:/, "") ??
    path.resolve(sdkRoot, "dci-relational.db");
  const only =
    (get("--only")
      ?.split(",")
      .map((s) => s.trim()) as Section[]) ?? ALL_SECTIONS;
  return {
    source: get("--source") ?? defaultSource,
    out: get("--out") ?? path.resolve(sdkRoot, "read-model.db"),
    dryRun: argv.includes("--dry-run"),
    only,
    jsonSnapshot: get("--json-snapshot"),
  };
};

const log = (msg: string) => console.log(`[emit-read-model] ${msg}`);

// ── A/B slot publishing ──────────────────────────────────────────────────────
// Mirror of the resolution in app/lib/read-model-db.ts. The emit writes the new
// build into the inactive slot and flips `<stem>.active`; the server polls that
// pointer and hot-swaps. Keep the two in sync.
type Slot = "a" | "b";
interface SlotPaths {
  pointer: string;
  dir: string;
  stem: string;
}
const slotsOf = (outPath: string): SlotPaths => {
  const dir = path.dirname(outPath);
  const stem = path.basename(outPath).replace(/\.db$/i, "");
  return { dir, stem, pointer: path.join(dir, `${stem}.active`) };
};
const slotFile = (s: SlotPaths, slot: Slot) =>
  path.join(s.dir, `${s.stem}.${slot}.db`);
const readActiveSlot = (s: SlotPaths): Slot | null => {
  try {
    const v = fs.readFileSync(s.pointer, "utf8").trim();
    return v === "a" || v === "b" ? v : null;
  } catch {
    return null;
  }
};
// Remove a db file and its WAL/SHM sidecars (best-effort).
const rmDbFiles = (file: string) => {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(file + ext, { force: true });
    } catch {
      /* ignore */
    }
  }
};

const rmTreeRetry = async (target: string) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(err?.code)) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
};

// ── Schema ──────────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE rm_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE rm_events (
  event_id TEXT PRIMARY KEY, slug TEXT, season TEXT, name TEXT, event_name TEXT,
  start_date TEXT, start_time TEXT, web_start_time TEXT, edt_start_time TEXT, timezone TEXT,
  location_city TEXT, location_state TEXT, venue_name TEXT, venue_address TEXT,
  event_image TEXT, event_image_thumb TEXT, competition_slug TEXT,
  scores_released INTEGER, recap_released INTEGER, lineup_entries INTEGER,
  all_times_present INTEGER, participant_entries INTEGER, schedule_entries INTEGER,
  judge_assignments INTEGER, prediction_runs INTEGER, latest_prediction_at TEXT,
  about_text TEXT,
  -- Current-season-scoped prediction counts. buildEventsForSeason filters
  -- predictions to the season while buildAllEvents counts all seasons per slug,
  -- so the 2026 list reads these and the all-events views read the unscoped ones.
  season_prediction_runs INTEGER, season_latest_prediction_at TEXT
);
CREATE INDEX rm_events_slug ON rm_events(slug);
CREATE INDEX rm_events_season ON rm_events(season, start_date);
CREATE INDEX rm_events_compet ON rm_events(competition_slug);

CREATE TABLE rm_event_schedule (
  event_slug TEXT, performance_order INTEGER, unit_name TEXT, time TEXT,
  is_non_performance INTEGER, is_exhibition INTEGER, division_name TEXT,
  corps_key TEXT, sort_index INTEGER
);
CREATE INDEX rm_event_schedule_slug ON rm_event_schedule(event_slug, sort_index);

CREATE TABLE rm_event_season_options (
  source_slug TEXT, season TEXT, slug TEXT, competition_slug TEXT, name TEXT,
  event_name TEXT, start_date TEXT, location_city TEXT, location_state TEXT, sort_index INTEGER
);
CREATE INDEX rm_event_season_options_src ON rm_event_season_options(source_slug, sort_index);

CREATE TABLE rm_event_competition_resolution (
  season TEXT, slug TEXT, competition_slug TEXT, PRIMARY KEY (season, slug)
);

CREATE TABLE rm_corps (
  corps_key TEXT PRIMARY KEY, slug TEXT, name TEXT, division_name TEXT, display_city TEXT,
  corps_logo TEXT, corps_logo_dark INTEGER, corps_logo_dark_url TEXT,
  color_primary TEXT, color_secondary TEXT, color_source TEXT,
  active INTEGER, performing INTEGER, is_alumni INTEGER,
  aliases_json TEXT, sort_index INTEGER
);
CREATE INDEX rm_corps_slug ON rm_corps(slug);
CREATE INDEX rm_corps_sort ON rm_corps(sort_index);

CREATE TABLE rm_corps_detail (slug TEXT PRIMARY KEY, detail_json TEXT);

CREATE TABLE rm_corps_season_points (
  corps_slug TEXT, season TEXT, date TEXT, label TEXT, slug TEXT,
  predicted REAL, actual REAL, low REAL, high REAL, sort_index INTEGER
);
CREATE INDEX rm_corps_season_pts ON rm_corps_season_points(corps_slug, season, sort_index);

CREATE TABLE rm_corps_appearances (corps_slug TEXT, event_id TEXT, sort_index INTEGER);
CREATE INDEX rm_corps_appearances_k ON rm_corps_appearances(corps_slug, sort_index);

-- A corps's finalized result (total score + overall place) per appearance, for the
-- profile's appearance cards. Keyed by event_id (so it joins to rm_corps_appearances
-- / eventCardKey). Only events with released scores have a row.
CREATE TABLE rm_corps_appearance_results (
  corps_slug TEXT, event_id TEXT, total_score REAL, place INTEGER
);
CREATE INDEX rm_corps_appearance_results_k ON rm_corps_appearance_results(corps_slug);

CREATE TABLE rm_event_recap (
  competition_slug TEXT PRIMARY KEY, event_slug TEXT, meta_json TEXT, scores_json TEXT
);
CREATE INDEX rm_event_recap_evt ON rm_event_recap(event_slug);

CREATE TABLE rm_event_full_recap (
  competition_slug TEXT PRIMARY KEY, event_slug TEXT, full_json TEXT
);
CREATE INDEX rm_event_full_recap_evt ON rm_event_full_recap(event_slug);

CREATE TABLE rm_judges (judge_id TEXT PRIMARY KEY, summary_json TEXT);
CREATE TABLE rm_judge_detail (judge_id TEXT PRIMARY KEY, detail_json TEXT);

CREATE TABLE rm_staff (person_id TEXT PRIMARY KEY, summary_json TEXT);
CREATE TABLE rm_staff_detail (person_id TEXT PRIMARY KEY, detail_json TEXT);

CREATE TABLE rm_event_prediction (
  event_slug TEXT PRIMARY KEY, season TEXT, predicted_at TEXT, summary_json TEXT
);

CREATE TABLE rm_show_titles (season TEXT, corps_key TEXT, title TEXT);
CREATE INDEX rm_show_titles_season ON rm_show_titles(season);

CREATE TABLE rm_show_info (season TEXT, corps_key TEXT, info_json TEXT);
CREATE INDEX rm_show_info_season ON rm_show_info(season);

-- v9: full show detail (header + repertoire/designers/movements/media/reviews/tags)
-- for the show-detail wiki page. Keyed by the stable (season, corps_key).
CREATE TABLE rm_show_detail (season TEXT, corps_key TEXT, detail_json TEXT);
CREATE INDEX rm_show_detail_key ON rm_show_detail(season, corps_key);

-- One row per Fri–Sun weekend bucket; shows_json is the bucket's shows (each with
-- venue coords + lineup). Reader reconstructs WeekendBucket[] and picks the
-- current/next-non-empty weekend at request time (chooseWeekend), so the data is
-- not time-relative — a stale emit stays correct.
CREATE TABLE rm_home_weekend_shows (
  season TEXT, weekend_start TEXT, weekend_end TEXT, shows_json TEXT
);
CREATE INDEX rm_home_weekend_shows_season ON rm_home_weekend_shows(season, weekend_start);

-- Single-row snapshot of the most recently completed competition + top
-- placements (home centerpiece). id is a constant so the reader reads one row.
CREATE TABLE rm_home_latest_results (id INTEGER PRIMARY KEY, results_json TEXT);

-- Single-row snapshot of the latest scored season's top World Class standings.
CREATE TABLE rm_home_standings (id INTEGER PRIMARY KEY, standings_json TEXT);

-- Merch read-model (docs/MERCH_DEPLOY.md). rm_merch_meta is a single-row snapshot of
-- the catalog index + precomputed facets + the store directory (the catalog is small
-- enough to load whole into the service's Ref cache); per-product detail and per-corps
-- teaser are keyed lookups. This is what rides --push-turso into prod (the JSON shards
-- under public/read-model are a dev/local fast-path only, not in the prod image).
CREATE TABLE rm_merch_meta (id INTEGER PRIMARY KEY, index_json TEXT, facets_json TEXT, stores_json TEXT);
CREATE TABLE rm_merch_product (product_id TEXT PRIMARY KEY, detail_json TEXT);
CREATE TABLE rm_merch_corps_teaser (slug TEXT PRIMARY KEY, teaser_json TEXT);

-- Fantasy draft (UI/UX plan §2.1). The four score-DB reads the live draft needs,
-- frozen so the serving container can run drafts without the relational DB.
-- rm_fantasy_draft_pool: the eligible World/Open corps (latest competed season),
-- pre-ordered (sort_index). prior_finals / season_best are caption scores keyed by
-- season (caption_name mapped to a CaptionKey in score-db, matching the live path).
CREATE TABLE rm_fantasy_draft_pool (
  corps_key TEXT, slug TEXT, name TEXT, division_name TEXT, display_city TEXT,
  corps_logo TEXT, sort_index INTEGER
);
CREATE TABLE rm_fantasy_prior_finals (
  season TEXT, corps_key TEXT, caption_name TEXT, score REAL
);
CREATE INDEX rm_fantasy_prior_finals_season ON rm_fantasy_prior_finals(season);
CREATE TABLE rm_fantasy_season_best (
  season TEXT, corps_key TEXT, caption_name TEXT, best REAL
);
CREATE INDEX rm_fantasy_season_best_season ON rm_fantasy_season_best(season);
CREATE TABLE rm_fantasy_season_finals (
  season TEXT, slug TEXT, date TEXT, recap_present INTEGER
);
CREATE INDEX rm_fantasy_season_finals_season ON rm_fantasy_season_finals(season);
`;

const schemaStatements = () =>
  SCHEMA.replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

const quoteIdent = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe SQL identifier: ${name}`);
  }
  return `"${name}"`;
};

// Guardrail views to report on (warn, don't fail unless --strict added later).
const DQ_VIEWS = [
  "dq_caption_total_mismatches",
  "dq_duplicate_score_entries",
  "dq_invalid_caption_scores",
  "dq_missing_caption_panels",
  "dq_rank_inversions",
  "dq_showcase_rows",
  "dq_unknown_judges",
  "dq_zero_scores",
];

const ingestCommit = (): string => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

// Batched insert helper — chunks rows into multi-row INSERTs inside a transaction.
const insertRows = async (
  db: Client,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> => {
  if (rows.length === 0) return;
  const colList = columns.join(", ");
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const placeholders = chunk
      .map(() => `(${columns.map(() => "?").join(", ")})`)
      .join(", ");
    const args = chunk.flat() as any[];
    await db.execute({
      sql: `INSERT INTO ${table} (${colList}) VALUES ${placeholders}`,
      args,
    });
  }
};

// Run the emit with explicit args. Exported so the ingest pipeline
// (seasonUpdateWorkflow) can call it directly as its final step.
export const runEmit = async (args: Args) => {
  log(`source: ${args.source}`);
  log(
    `out:    ${args.out}${args.dryRun ? " (dry-run — nothing written)" : ""}`,
  );
  log(`sections: ${args.only.join(", ")}`);

  if (!fs.existsSync(args.source)) {
    throw new Error(`Source DB not found: ${args.source}`);
  }
  const sourceMtime = fs.statSync(args.source).mtime.toISOString();

  // Source: we only ever issue SELECTs against it. @libsql/client doesn't accept
  // a read-only open flag for local files, so the read-only guarantee is by
  // discipline — never run schema-ensure / DROP / DELETE here (READ_MODEL_PLAN §5).
  const src = createClient({ url: `file:${args.source}` });

  const tmpOut = `${args.out}.tmp`;
  if (fs.existsSync(tmpOut)) fs.rmSync(tmpOut);
  const dst = args.dryRun ? null : createClient({ url: `file:${tmpOut}` });

  if (dst) {
    for (const stmt of schemaStatements()) {
      await dst.execute(stmt);
    }
  }

  const rowCounts: Record<string, number> = {};
  const t0 = Date.now();

  // ── Events ─────────────────────────────────────────────────────────────────
  let allEvents: EventDirectoryRow[] = [];
  if (args.only.includes("events")) {
    log("building events…");
    allEvents = await buildAllEvents(src);
    rowCounts.rm_events = allEvents.length;
    // buildAllEvents omits venue (the all-seasons directory doesn't show it); the
    // current-season list page does. Overlay venues from the season builder so
    // rm_events can serve the 2026 list with venue intact (READ_MODEL_PLAN §4).
    // Current-season overlay: venues + season-scoped prediction counts, both of
    // which the season builder computes differently from the all-events builder.
    const seasonBySlug = new Map<
      string,
      {
        venue_name: string | null;
        venue_address: string | null;
        prediction_runs: number;
        latest_prediction_at: string | null;
      }
    >();
    {
      const seasonEvents = await buildEventsForSeason(src, "2026");
      for (const se of seasonEvents)
        seasonBySlug.set(se.slug, {
          venue_name: se.venue_name,
          venue_address: se.venue_address,
          prediction_runs: se.prediction_runs,
          latest_prediction_at: se.latest_prediction_at,
        });
    }
    // One windowed query for every event's about_text (was an N+1 over
    // event_page_scrapes — the dominant emit cost). READ_MODEL_PLAN §5.
    const aboutBySlug = await buildAllEventAbouts(src);
    if (dst) {
      const eventRows: unknown[][] = [];
      for (const e of allEvents) {
        const about = aboutBySlug.get(e.slug) ?? null;
        const s = seasonBySlug.get(e.slug);
        eventRows.push([
          e.event_id ?? e.slug,
          e.slug,
          e.season ?? null,
          e.name,
          e.event_name,
          e.start_date,
          e.start_time,
          e.web_start_time,
          e.edt_start_time,
          e.timezone,
          e.location_city,
          e.location_state,
          s?.venue_name ?? e.venue_name ?? null,
          s?.venue_address ?? e.venue_address ?? null,
          e.event_image ?? null,
          e.event_image_thumb ?? null,
          e.competition_slug,
          e.scores_released,
          e.recap_released,
          e.lineup_entries,
          e.all_times_present,
          e.participant_entries,
          e.schedule_entries,
          e.judge_assignments,
          e.prediction_runs,
          e.latest_prediction_at,
          about,
          s?.prediction_runs ?? null,
          s?.latest_prediction_at ?? null,
        ]);
      }
      await insertRows(
        dst,
        "rm_events",
        [
          "event_id",
          "slug",
          "season",
          "name",
          "event_name",
          "start_date",
          "start_time",
          "web_start_time",
          "edt_start_time",
          "timezone",
          "location_city",
          "location_state",
          "venue_name",
          "venue_address",
          "event_image",
          "event_image_thumb",
          "competition_slug",
          "scores_released",
          "recap_released",
          "lineup_entries",
          "all_times_present",
          "participant_entries",
          "schedule_entries",
          "judge_assignments",
          "prediction_runs",
          "latest_prediction_at",
          "about_text",
          "season_prediction_runs",
          "season_latest_prediction_at",
        ],
        eventRows,
      );
    }

    // Schedules (per event slug) — only events with lineup entries have schedules.
    log("building event schedules…");
    const scheduleRows: unknown[][] = [];
    // Schedules are keyed by event_slug (the builder filters by slug only), and
    // slugs repeat across seasons — dedupe so a shared slug is materialized once.
    const slugsWithLineups = [
      ...new Set(
        allEvents.filter((e) => e.lineup_entries > 0).map((e) => e.slug),
      ),
    ];
    for (const slug of slugsWithLineups) {
      const sched = await buildEventSchedule(src, slug);
      sched.forEach((r, idx) => {
        scheduleRows.push([
          slug,
          r.performance_order,
          r.unit_name,
          r.time,
          r.is_non_performance,
          r.is_exhibition,
          r.division_name,
          r.corps_key,
          idx,
        ]);
      });
    }
    rowCounts.rm_event_schedule = scheduleRows.length;
    if (dst)
      await insertRows(
        dst,
        "rm_event_schedule",
        [
          "event_slug",
          "performance_order",
          "unit_name",
          "time",
          "is_non_performance",
          "is_exhibition",
          "division_name",
          "corps_key",
          "sort_index",
        ],
        scheduleRows,
      );

    // Season options + competition resolution (per distinct slug / season+slug).
    // Fetch the cross-season candidate set ONCE and reuse it across every call —
    // the per-slug builders would otherwise re-run the full UNION scan each time.
    log("building season options + competition resolution…");
    const candidates = await buildEventSeriesCandidates(src);
    const optionRows: unknown[][] = [];
    const resolutionRows: unknown[][] = [];
    const distinctSlugs = [...new Set(allEvents.map((e) => e.slug))];
    for (const slug of distinctSlugs) {
      const options = await buildEventSeasonOptions(src, slug, candidates);
      options.forEach((o, idx) => {
        optionRows.push([
          slug,
          o.season,
          o.slug,
          o.competition_slug,
          o.name,
          o.event_name,
          o.start_date,
          o.location_city,
          o.location_state,
          idx,
        ]);
      });
    }
    rowCounts.rm_event_season_options = optionRows.length;
    // Competition resolution: one per (season, slug) event row.
    const seenResolution = new Set<string>();
    for (const e of allEvents) {
      const season = e.season ?? e.start_date?.slice(0, 4) ?? "";
      const key = `${season} ${e.slug}`;
      if (seenResolution.has(key)) continue;
      seenResolution.add(key);
      const comp = await buildCompetitionSlugForSeasonEvent(
        src,
        season,
        e.slug,
        candidates,
      );
      resolutionRows.push([season, e.slug, comp]);
    }
    rowCounts.rm_event_competition_resolution = resolutionRows.length;
    if (dst) {
      await insertRows(
        dst,
        "rm_event_season_options",
        [
          "source_slug",
          "season",
          "slug",
          "competition_slug",
          "name",
          "event_name",
          "start_date",
          "location_city",
          "location_state",
          "sort_index",
        ],
        optionRows,
      );
      await insertRows(
        dst,
        "rm_event_competition_resolution",
        ["season", "slug", "competition_slug"],
        resolutionRows,
      );
    }
  }

  // ── Corps ──────────────────────────────────────────────────────────────────
  if (args.only.includes("corps")) {
    log("building corps directory…");
    const corps = await buildCorpsDirectory(src);
    rowCounts.rm_corps = corps.length;
    if (dst) {
      const corpsRows = corps.map((c, idx) => [
        c.corps_key,
        c.slug,
        c.name,
        c.division_name,
        c.display_city,
        c.corps_logo,
        c.corps_logo_dark,
        c.corps_logo_dark_url,
        c.color_primary,
        c.color_secondary,
        c.color_source,
        c.active,
        c.performing,
        c.is_alumni,
        JSON.stringify(c.aliases),
        idx,
      ]);
      await insertRows(
        dst,
        "rm_corps",
        [
          "corps_key",
          "slug",
          "name",
          "division_name",
          "display_city",
          "corps_logo",
          "corps_logo_dark",
          "corps_logo_dark_url",
          "color_primary",
          "color_secondary",
          "color_source",
          "active",
          "performing",
          "is_alumni",
          "aliases_json",
          "sort_index",
        ],
        corpsRows,
      );
    }

    log("building corps detail / season-points / appearances…");
    const eventIdBySlug = new Map(
      allEvents.map((e) => [e.slug, e.event_id ?? e.slug]),
    );
    const detailRows: unknown[][] = [];
    const seasonPointRows: unknown[][] = [];
    const appearanceRows: unknown[][] = [];
    const appearanceResultRows: unknown[][] = [];
    const corpsWithSlug = corps.filter((c) => c.slug);
    for (const c of corpsWithSlug) {
      const slug = c.slug as string;
      const detail = await buildCorpsBySlug(src, slug);
      if (detail) detailRows.push([slug, JSON.stringify(detail)]);
      const points = await buildCorpsSeasonScores(src, slug);
      points.forEach((p, idx) =>
        seasonPointRows.push([
          slug,
          "2026",
          p.date,
          p.label,
          p.slug,
          p.predicted,
          p.actual,
          p.low,
          p.high,
          idx,
        ]),
      );
      const eventSlugs = await buildEventSlugsForCorps(
        src,
        slug.trim().toLowerCase(),
      );
      let ai = 0;
      const appearanceEventIds = new Set<string>();
      for (const es of eventSlugs) {
        const eid = eventIdBySlug.get(es);
        if (eid) {
          appearanceRows.push([slug, eid, ai++]);
          appearanceEventIds.add(eid);
        }
      }
      // Per-appearance result (place + total), keyed by event_id like appearances.
      // Some shows exist as duplicate event records cross-linked in
      // event_to_competition (e.g. "…-eastern-classic" ↔ "…-eastern-classic-2"),
      // so the mapped event_slug can resolve to a DIFFERENT event than the one the
      // corps appears at — leaving the visible card score-less. Prefer the event
      // the corps actually appears at: try the mapped slug, then the raw
      // competition slug, picking whichever lands in this corps's appearance set.
      const results = await buildCorpsAppearanceResults(src, slug);
      const resultByEid = new Map<string, { total: number | null; place: number | null }>();
      for (const r of results) {
        const mapped = eventIdBySlug.get(r.event_slug);
        const direct = eventIdBySlug.get(r.competition_slug);
        const eid =
          mapped && appearanceEventIds.has(mapped)
            ? mapped
            : direct && appearanceEventIds.has(direct)
              ? direct
              : (mapped ?? direct);
        if (!eid) continue;
        const prev = resultByEid.get(eid);
        if (!prev || (r.total ?? -Infinity) > (prev.total ?? -Infinity))
          resultByEid.set(eid, { total: r.total, place: r.place });
      }
      for (const [eid, r] of resultByEid)
        appearanceResultRows.push([slug, eid, r.total, r.place]);
    }
    rowCounts.rm_corps_detail = detailRows.length;
    rowCounts.rm_corps_season_points = seasonPointRows.length;
    rowCounts.rm_corps_appearances = appearanceRows.length;
    rowCounts.rm_corps_appearance_results = appearanceResultRows.length;
    if (dst) {
      await insertRows(
        dst,
        "rm_corps_detail",
        ["slug", "detail_json"],
        detailRows,
      );
      await insertRows(
        dst,
        "rm_corps_season_points",
        [
          "corps_slug",
          "season",
          "date",
          "label",
          "slug",
          "predicted",
          "actual",
          "low",
          "high",
          "sort_index",
        ],
        seasonPointRows,
      );
      await insertRows(
        dst,
        "rm_corps_appearances",
        ["corps_slug", "event_id", "sort_index"],
        appearanceRows,
      );
      await insertRows(
        dst,
        "rm_corps_appearance_results",
        ["corps_slug", "event_id", "total_score", "place"],
        appearanceResultRows,
      );
    }
  }

  // ── Recaps ─────────────────────────────────────────────────────────────────
  if (args.only.includes("recaps")) {
    log("building recaps…");
    // Events with released scores carry a recap worth freezing. Resolve the
    // competition season-aware: event slugs are reused across seasons (e.g.
    // "brass-impact" exists 2013–2019) and event_to_competition is keyed by the
    // bare slug, so resolving by slug alone collapses every season onto a single
    // (earliest) competition — which is why pre-2016 seasons lost most recaps.
    // Use the season-aware resolver and dedupe on the resolved competition slug
    // so each season's recap is emitted independently.
    const recapEvents = (
      allEvents.length ? allEvents : await buildAllEvents(src)
    ).filter((e) => e.scores_released);
    const candidates = await buildEventSeriesCandidates(src);
    const recapRows: unknown[][] = [];
    const fullRecapRows: unknown[][] = [];
    const seenComp = new Set<string>();
    for (const e of recapEvents) {
      const season = e.season ?? e.start_date?.slice(0, 4) ?? "";
      const compSlug = season
        ? await buildCompetitionSlugForSeasonEvent(
            src,
            season,
            e.slug,
            candidates,
          )
        : e.slug;
      if (seenComp.has(compSlug)) continue;
      const recap = await buildEventRecap(src, compSlug);
      if (!recap.meta) continue;
      const resolved = recap.meta.slug;
      if (seenComp.has(resolved)) continue;
      seenComp.add(resolved);
      seenComp.add(compSlug);
      recapRows.push([
        resolved,
        e.slug,
        JSON.stringify(recap.meta),
        JSON.stringify(recap.scores),
      ]);
      // Full DCI-style recap (per-judge + subcaption breakdown) — same resolved
      // competition, frozen alongside the compact recap.
      const full = await buildEventFullRecap(src, resolved);
      if (full.corps.length > 0)
        fullRecapRows.push([resolved, e.slug, JSON.stringify(full)]);
    }
    rowCounts.rm_event_recap = recapRows.length;
    rowCounts.rm_event_full_recap = fullRecapRows.length;
    if (dst) {
      await insertRows(
        dst,
        "rm_event_recap",
        ["competition_slug", "event_slug", "meta_json", "scores_json"],
        recapRows,
      );
      await insertRows(
        dst,
        "rm_event_full_recap",
        ["competition_slug", "event_slug", "full_json"],
        fullRecapRows,
      );
    }
  }

  // ── Judges ─────────────────────────────────────────────────────────────────
  if (args.only.includes("judges")) {
    log("building judges…");
    const judges = await buildJudgeDirectory(src);
    rowCounts.rm_judges = judges.length;
    const judgeRows = judges.map((j) => [j.judge_id, JSON.stringify(j)]);
    const detailRows: unknown[][] = [];
    for (const j of judges) {
      const profile = await buildJudgeProfile(src, j.judge_id);
      if (profile) detailRows.push([j.judge_id, JSON.stringify(profile)]);
    }
    rowCounts.rm_judge_detail = detailRows.length;
    if (dst) {
      await insertRows(
        dst,
        "rm_judges",
        ["judge_id", "summary_json"],
        judgeRows,
      );
      await insertRows(
        dst,
        "rm_judge_detail",
        ["judge_id", "detail_json"],
        detailRows,
      );
    }
  }

  // ── Staff ────────────────────────────────────────────────────────────────────
  if (args.only.includes("staff")) {
    log("building staff…");
    const [staff, profiles] = await Promise.all([
      buildStaffDirectory(src),
      buildAllStaffProfiles(src),
    ]);
    rowCounts.rm_staff = staff.length;
    rowCounts.rm_staff_detail = profiles.length;
    if (dst) {
      await insertRows(dst, "rm_staff", ["person_id", "summary_json"], staff.map((s) => [s.person_id, JSON.stringify(s)]));
      await insertRows(dst, "rm_staff_detail", ["person_id", "detail_json"], profiles.map((p) => [p.person_id, JSON.stringify(p)]));
    }
  }

  // ── Predictions (read shape of latest saved run) ─────────────────────────────
  if (args.only.includes("predictions")) {
    log("building predictions…");
    const slugs = await buildPredictedEventSlugs(src, "2026");
    const predRows: unknown[][] = [];
    for (const slug of slugs) {
      const summary = await buildLatestPredictionSummary(src, slug, "2026");
      if (summary)
        predRows.push([
          summary.event_slug,
          summary.season,
          summary.predicted_at,
          JSON.stringify(summary.summary),
        ]);
    }
    rowCounts.rm_event_prediction = predRows.length;
    if (dst)
      await insertRows(
        dst,
        "rm_event_prediction",
        ["event_slug", "season", "predicted_at", "summary_json"],
        predRows,
      );
  }

  // ── Show titles (corps_shows, placeholder titles filtered) ───────────────────
  if (args.only.includes("shows")) {
    log("building show titles/info…");
    const shows = await buildAllShowTitles(src);
    rowCounts.rm_show_titles = shows.length;
    if (dst)
      await insertRows(
        dst,
        "rm_show_titles",
        ["season", "corps_key", "title"],
        shows.map((s) => [s.season, s.corps_key, s.title]),
      );

    const showInfo = await buildAllShowInfo(src);
    rowCounts.rm_show_info = showInfo.length;
    if (dst)
      await insertRows(
        dst,
        "rm_show_info",
        ["season", "corps_key", "info_json"],
        showInfo.map((s) => [s.season, s.corps_key, JSON.stringify(s.info)]),
      );

    const showDetail = await buildAllShowDetail(src);
    rowCounts.rm_show_detail = showDetail.length;
    if (dst)
      await insertRows(
        dst,
        "rm_show_detail",
        ["season", "corps_key", "detail_json"],
        showDetail.map((s) => [s.season, s.corps_key, JSON.stringify(s.detail)]),
      );
  }

  // ── Home weekend shows (carousel: this-weekend shows + lineups + venue coords) ─
  if (args.only.includes("home")) {
    log("building home weekend shows…");
    const buckets = await buildHomeWeekendShows(src, "2026");
    rowCounts.rm_home_weekend_shows = buckets.length;
    if (dst)
      await insertRows(
        dst,
        "rm_home_weekend_shows",
        ["season", "weekend_start", "weekend_end", "shows_json"],
        buckets.map((b) => [
          "2026",
          b.weekendStart,
          b.weekendEnd,
          JSON.stringify(b.shows),
        ]),
      );

    const latestResults = await buildLatestResults(src);
    rowCounts.rm_home_latest_results = latestResults ? 1 : 0;
    if (dst && latestResults)
      await insertRows(
        dst,
        "rm_home_latest_results",
        ["id", "results_json"],
        [[1, JSON.stringify(latestResults)]],
      );

    const standings = await buildSeasonStandings(src);
    rowCounts.rm_home_standings = standings ? 1 : 0;
    if (dst && standings)
      await insertRows(
        dst,
        "rm_home_standings",
        ["id", "standings_json"],
        [[1, JSON.stringify(standings)]],
      );
  }

  // ── Merch (docs/MERCH_DEPLOY.md) ─────────────────────────────────────────────
  // Freeze the catalog index + facets + store directory into one rm_merch_meta row,
  // and per-product / per-corps-teaser detail into keyed tables, so merch rides the
  // --push-turso publish into prod (the serving container has no relational DB).
  // Builders tolerate missing merch_* tables (rowsOrEmpty) → emits empty if uningested.
  if (args.only.includes("merch")) {
    log("building merch read-model…");
    const [merchIndex, merchFacets, merchStores, merchDetails, merchTeasers] =
      await Promise.all([
        buildMerchCatalogIndex(src),
        buildMerchFacets(src),
        buildMerchStores(src),
        buildMerchProductDetails(src),
        buildCorpsMerchTeasers(src),
      ]);
    rowCounts.rm_merch_product = merchDetails.size;
    rowCounts.rm_merch_corps_teaser = merchTeasers.size;
    rowCounts.rm_merch_meta = merchIndex.length; // products in the index (meta is 1 row)
    if (dst) {
      await insertRows(
        dst,
        "rm_merch_meta",
        ["id", "index_json", "facets_json", "stores_json"],
        [
          [
            1,
            JSON.stringify(merchIndex),
            JSON.stringify(merchFacets),
            JSON.stringify(merchStores),
          ],
        ],
      );
      await insertRows(
        dst,
        "rm_merch_product",
        ["product_id", "detail_json"],
        [...merchDetails.entries()].map(([id, detail]) => [
          id,
          JSON.stringify(detail),
        ]),
      );
      await insertRows(
        dst,
        "rm_merch_corps_teaser",
        ["slug", "teaser_json"],
        [...merchTeasers.entries()].map(([slug, teaser]) => [
          slug,
          JSON.stringify(teaser),
        ]),
      );
    }
  }

  // ── Fantasy draft (UI/UX plan §2.1) ──────────────────────────────────────────
  // The four score-DB reads, frozen so prod can run drafts without the relational DB.
  if (args.only.includes("fantasy")) {
    log("building fantasy draft read-model…");
    const [pool, priorFinals, seasonBest, seasonFinals] = await Promise.all([
      buildFantasyDraftPool(src),
      buildFantasyPriorFinals(src),
      buildFantasySeasonBest(src),
      buildFantasySeasonFinals(src),
    ]);
    rowCounts.rm_fantasy_draft_pool = pool.length;
    rowCounts.rm_fantasy_prior_finals = priorFinals.length;
    rowCounts.rm_fantasy_season_best = seasonBest.length;
    rowCounts.rm_fantasy_season_finals = seasonFinals.length;
    if (dst) {
      await insertRows(
        dst,
        "rm_fantasy_draft_pool",
        ["corps_key", "slug", "name", "division_name", "display_city", "corps_logo", "sort_index"],
        pool.map((p, idx) => [
          p.corps_key,
          p.slug,
          p.name,
          p.division_name,
          p.display_city,
          p.corps_logo,
          idx,
        ]),
      );
      await insertRows(
        dst,
        "rm_fantasy_prior_finals",
        ["season", "corps_key", "caption_name", "score"],
        priorFinals.map((r) => [r.season, r.corps_key, r.caption_name, r.score]),
      );
      await insertRows(
        dst,
        "rm_fantasy_season_best",
        ["season", "corps_key", "caption_name", "best"],
        seasonBest.map((r) => [r.season, r.corps_key, r.caption_name, r.score]),
      );
      await insertRows(
        dst,
        "rm_fantasy_season_finals",
        ["season", "slug", "date", "recap_present"],
        seasonFinals.map((r) => [r.season, r.slug, r.date, r.recap_present]),
      );
    }
  }

  // ── Guardrails (dq_* views) ──────────────────────────────────────────────────
  log("reading data-quality guardrails…");
  const dqCounts: Record<string, number> = {};
  for (const view of DQ_VIEWS) {
    try {
      const r = await src.execute(`SELECT COUNT(*) AS c FROM ${view}`);
      dqCounts[view] = Number((r.rows[0] as any)?.c ?? 0);
    } catch {
      dqCounts[view] = -1; // view missing
    }
  }

  // ── Meta ───────────────────────────────────────────────────────────────────
  const resolvedCurrentSeason = await src
    .execute(
      `SELECT MAX(season) AS s FROM event_lineup_entries ele JOIN events e ON e.slug = ele.event_slug`,
    )
    .then((r) => String((r.rows[0] as any)?.s ?? ""))
    .catch(() => "");
  if (dst) {
    const meta: [string, string][] = [
      ["schema_version", String(SCHEMA_VERSION)],
      ["built_at", new Date().toISOString()],
      ["source_db_mtime", sourceMtime],
      ["ingest_commit", ingestCommit()],
      ["current_season", resolvedCurrentSeason],
      ["row_counts_json", JSON.stringify(rowCounts)],
      ["dq_counts_json", JSON.stringify(dqCounts)],
    ];
    await insertRows(dst, "rm_meta", ["key", "value"], meta);
    await dst.execute("ANALYZE");
    await dst.execute("VACUUM");
    // Checkpoint + truncate the WAL so no -wal/-shm sidecars linger to block the
    // rename on Windows (READ_MODEL_PLAN §5 atomic swap).
    await dst.execute("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {});
  }

  const dtSec = ((Date.now() - t0) / 1000).toFixed(1);

  // ── Report ─────────────────────────────────────────────────────────────────
  log("───────────── build report ─────────────");
  for (const [t, c] of Object.entries(rowCounts)) log(`  ${t}: ${c}`);
  log(`  current_season: ${resolvedCurrentSeason}`);
  log("  data-quality guardrails:");
  for (const [v, c] of Object.entries(dqCounts))
    log(`    ${v}: ${c < 0 ? "(view missing)" : c}`);
  log(`  elapsed: ${dtSec}s`);
  log("─────────────────────────────────────────");

  // JSON snapshot (tier-2 client/offline payload) — emitted from the same data.
  if (args.jsonSnapshot && !args.dryRun && dst) {
    await emitJsonSnapshot(dst, src, args.jsonSnapshot, {
      schema_version: SCHEMA_VERSION,
      built_at: new Date().toISOString(),
      current_season: resolvedCurrentSeason,
    });
  }

  if (dst) {
    await dst.close();

    // PARTIAL EMIT GUARD. The build in `tmpOut` is a FRESH db with only the
    // `--only` sections populated; every other rm_* table is empty. Publishing
    // it into a slot + flipping the pointer would blank the live read-model for
    // all the un-built sections. So a partial emit NEVER touches the slots or the
    // pointer — it writes a standalone <stem>.partial.db for inspection instead.
    // Use a full emit (no --only) for anything that should go live.
    const isPartial = new Set(args.only).size < ALL_SECTIONS.length;
    if (isPartial) {
      const partialOut = args.out.replace(/\.db$/i, ".partial.db");
      rmDbFiles(partialOut);
      fs.copyFileSync(tmpOut, partialOut);
      try {
        fs.rmSync(tmpOut, { force: true });
      } catch {
        /* harmless */
      }
      log(
        `PARTIAL emit (--only ${args.only.join(",")}) — NOT published to a live slot. ` +
          `Other sections would be empty. Wrote ${partialOut} for inspection. ` +
          `Run a full emit (no --only) to publish.`,
      );
      src.close();
      return;
    }

    // Zero-downtime swap (A/B slots). Build is in `tmpOut`; publish it into the
    // *inactive* slot and flip the pointer. The running server never holds the
    // inactive slot open, so writing it is always safe — and the pointer is a
    // tiny file nobody holds open, so its atomic temp+rename succeeds even on
    // Windows. The live server polls the pointer and reconnects within seconds.
    // See app/lib/read-model-db.ts for the read side.
    const slots = slotsOf(args.out);
    const active = readActiveSlot(slots);
    const target: Slot = active === "a" ? "b" : "a";
    const targetFile = slotFile(slots, target);

    // Clear any prior generation in the target slot (incl. WAL/SHM sidecars).
    rmDbFiles(targetFile);
    // Copy the bytes in (libsql holds tmpOut open until process exit, but SQLite
    // shared-read makes the copy safe). Retry transient AV/indexer locks.
    let copied = false;
    for (let attempt = 0; attempt < 10 && !copied; attempt++) {
      try {
        fs.copyFileSync(tmpOut, targetFile);
        copied = true;
      } catch (err: any) {
        if (err?.code !== "EBUSY" && err?.code !== "EPERM") throw err;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!copied)
      throw new Error(
        `could not write read-model slot ${targetFile} (held open)`,
      );

    // Flip the pointer atomically — this is the moment the swap goes live.
    const ptrTmp = `${slots.pointer}.tmp`;
    fs.writeFileSync(ptrTmp, target);
    fs.renameSync(ptrTmp, slots.pointer);

    try {
      fs.rmSync(tmpOut, { force: true }); // best-effort; OS releases the handle at exit
    } catch {
      /* left behind; harmless, overwritten next run */
    }
    log(
      `published read-model → slot ${target} (${targetFile}); pointer flipped (live, no restart)`,
    );
    // Distribution to prod/dev is via R2 (scripts/pushData.ts) — run that after
    // a full emit, or let the merch/season workflows push. The serving container
    // pulls it on boot. See docs/DEPLOYMENT_REALITY.md §5.
  } else {
    log("dry-run complete — no file written.");
  }
  src.close();
};

// Tier-2 JSON snapshot (READ_MODEL_PLAN §9): collection files for list pages +
// per-detail files for detail pages, the offline payload the service worker
// runtime-caches. Emitted from the read-model so it can't drift from the server.
const emitJsonSnapshot = async (
  db: Client,
  src: Client,
  dir: string,
  meta: { schema_version: number; built_at: string; current_season: string },
) => {
  log(`emitting JSON snapshot → ${dir}`);
  // Wipe + recreate so deleted entities don't linger as stale files.
  await rmTreeRetry(dir);
  fs.mkdirSync(dir, { recursive: true });
  // Returns a short content hash so callers can build immutable `?v=` URLs
  // (DATA_LAYER_DECISION §4: versioned shard URLs cache forever; a new build = a
  // new URL, so they can never go stale).
  const writeJson = (rel: string, data: unknown): string => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const body = JSON.stringify(data);
    fs.writeFileSync(full, body);
    return createHash("sha256").update(body).digest("hex").slice(0, 12);
  };

  // Collections (list/directory pages) — the eagerly-preloaded browseable index.
  // Emit through the SAME readers the services use (readers.ts), NOT raw SELECTs:
  // a raw row drifts from the loader output (rmEventRow nulls directory venues +
  // coerces flags; readCorpsDirectory parses aliases; readJudgeDirectory drops
  // excluded judges), which would change page content after hydration. Each gets
  // a per-file content hash so an unchanged shard keeps its URL across emits.
  const events = await readAllEvents(db);
  const eventsHash = writeJson("events.json", events);
  const corps = await readCorpsDirectory(db);
  const corpsHash = writeJson("corps.json", corps);
  const judges = await readJudgeDirectory(db);
  const judgesHash = writeJson("judges.json", judges);

  // Per-detail files (detail pages). Keyed the way the routes resolve them.
  let detailCount = 0;
  const corpsDetails = (
    await db.execute("SELECT slug, detail_json FROM rm_corps_detail")
  ).rows as any[];
  for (const r of corpsDetails) {
    writeJson(`corps/${r.slug}.json`, JSON.parse(r.detail_json));
    detailCount++;
    // Season-score timeline + appearances: the other two payloads the corps
    // detail route needs, emitted from the same read functions the services use
    // (readers.ts) so they can't drift. This lets corps detail go shard-only.
    const seasonScores = await readCorpsSeasonScores(db, r.slug);
    writeJson(`corps-scores/${r.slug}.json`, seasonScores);
    detailCount++;
    const appearanceIds = await readCorpsAppearanceEventIds(db, r.slug);
    const appearances =
      appearanceIds.length === 0
        ? []
        : await readEventsByIds(db, appearanceIds);
    writeJson(`corps-appearances/${r.slug}.json`, appearances);
    detailCount++;
  }
  const recaps = (
    await db.execute(
      "SELECT competition_slug, meta_json, scores_json FROM rm_event_recap",
    )
  ).rows as any[];
  for (const r of recaps) {
    writeJson(`recaps/${r.competition_slug}.json`, {
      meta: JSON.parse(r.meta_json),
      scores: JSON.parse(r.scores_json),
    });
    detailCount++;
  }
  const judgeDetails = (
    await db.execute("SELECT judge_id, detail_json FROM rm_judge_detail")
  ).rows as any[];
  for (const r of judgeDetails) {
    writeJson(`judges/${r.judge_id}.json`, JSON.parse(r.detail_json));
    detailCount++;
  }
  const staffSummaries = (
    await db.execute("SELECT summary_json FROM rm_staff")
  ).rows as any[];
  if (staffSummaries.length > 0) {
    writeJson("staff.json", staffSummaries.map((r) => JSON.parse(r.summary_json)));
  }
  const staffDetails = (
    await db.execute("SELECT person_id, detail_json FROM rm_staff_detail")
  ).rows as any[];
  for (const r of staffDetails) {
    writeJson(`staff/${r.person_id}.json`, JSON.parse(r.detail_json));
    detailCount++;
  }
  const preds = (
    await db.execute("SELECT event_slug, summary_json FROM rm_event_prediction")
  ).rows as any[];
  for (const r of preds) {
    writeJson(`predictions/${r.event_slug}.json`, JSON.parse(r.summary_json));
    detailCount++;
  }

  // Past-season prediction/recap composite pages. The route is reached with the
  // slug from event links — usually competition_slug (event-card) but sometimes
  // the event slug (season-title links) — and readPredictionPageData's output
  // depends on which slug is passed, so emit a shard for EACH reachable
  // (season, slug). 2026 is intentionally excluded: its prediction is
  // live-regenerable (reads the big DB), so that page stays dynamic. The shard is
  // {...PredictionPageData, fullRecap} to mirror the route loader's return.
  const pastEvents = (
    await db.execute(
      "SELECT season, slug, competition_slug FROM rm_events WHERE season IS NOT NULL AND season <> '2026'",
    )
  ).rows as any[];
  const emittedPredPages = new Set<string>();
  for (const e of pastEvents) {
    const season = String(e.season);
    const slugs = [e.slug, e.competition_slug].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    for (const slug of new Set(slugs)) {
      const key = `${season}/${slug}`;
      if (emittedPredPages.has(key)) continue;
      emittedPredPages.add(key);
      const data = await readPredictionPageData(db, season, slug);
      const fullRecap = await readEventFullRecap(db, slug);
      // Skip slugs that resolve to nothing — the page would be empty and the
      // route's server-fn fallback returns the same empty payload, so a shard adds
      // no value. (Any event header / recap / schedule / options ⇒ emit.)
      const isEmpty =
        !data.event &&
        data.recap?.scores.length === 0 &&
        data.schedule.length === 0 &&
        data.seasonOptions.length === 0 &&
        fullRecap.corps.length === 0;
      if (isEmpty) continue;
      writeJson(`prediction-page/${key}.json`, { ...data, fullRecap });
      detailCount++;
    }
  }

  // Show titles, one file per season: { corps_key: title }.
  const showRows = (
    await db.execute("SELECT season, corps_key, title FROM rm_show_titles")
  ).rows as any[];
  const showsBySeason: Record<string, Record<string, string>> = {};
  for (const r of showRows) {
    (showsBySeason[r.season] ??= {})[r.corps_key] = r.title;
  }
  for (const [season, map] of Object.entries(showsBySeason)) {
    writeJson(`shows/${season}.json`, map);
    detailCount++;
  }

  // Merch (MERCH_PLAN §5): catalog index (paginated) + facets + store directory
  // as preloaded collections, and per-product / per-store / per-corps detail
  // shards. Read from the SOURCE big DB (merch_stores/merch_products live there).
  const catalog = await buildMerchCatalogIndex(src);
  const MERCH_PAGE = 200;
  const pageCount = Math.max(1, Math.ceil(catalog.length / MERCH_PAGE));
  for (let i = 0; i < pageCount; i++) {
    // Same shape as the getMerchCatalogPage server-fn fallback so the route's
    // loadDetailOrServer gets identical data from shard or fallback.
    writeJson(`merch/catalog/page-${i + 1}.json`, {
      total: catalog.length,
      pageSize: MERCH_PAGE,
      pages: pageCount,
      page: i + 1,
      items: catalog.slice(i * MERCH_PAGE, (i + 1) * MERCH_PAGE),
    });
    detailCount++;
  }
  const merchCatalogHash = writeJson("merch/catalog/index.json", {
    total: catalog.length,
    pageSize: MERCH_PAGE,
    pages: pageCount,
  });
  const merchFacetsHash = writeJson(
    "merch/facets.json",
    await buildMerchFacets(src),
  );
  const merchStores = await buildMerchStores(src);
  const merchStoresHash = writeJson("merch/stores.json", merchStores);
  const productsByStore = new Map<string, string[]>();
  for (const [id, detail] of await buildMerchProductDetails(src)) {
    writeJson(`merch/products/${id}.json`, detail);
    detailCount++;
    const list = productsByStore.get(detail.storeId) ?? [];
    list.push(id);
    productsByStore.set(detail.storeId, list);
  }
  for (const store of merchStores) {
    writeJson(`merch/stores/${store.storeId}.json`, {
      store,
      productIds: productsByStore.get(store.storeId) ?? [],
    });
    detailCount++;
  }
  for (const [slug, teaser] of await buildCorpsMerchTeasers(src)) {
    writeJson(`corps-merch/${slug}.json`, teaser);
    detailCount++;
  }

  // Manifest: the single short-cached, revalidated entry point (everything else
  // is immutable). The client fetches this first, reads the versioned index-shard
  // URLs, then loads those (cached forever). On-demand detail shards
  // (corps/<slug>.json, recaps/<comp>.json, …) are cache-busted with the global
  // `version` token, which changes every emit. See DATA_LAYER_DECISION §4 + the
  // proxy.mjs cache policy that pairs with this.
  const manifest = {
    schema_version: meta.schema_version,
    built_at: meta.built_at,
    current_season: meta.current_season,
    // Global cache-bust token clients append to on-demand detail-shard URLs.
    version: meta.built_at,
    // Versioned URLs for the eagerly-preloaded index collections.
    shards: {
      events: `events.json?v=${eventsHash}`,
      corps: `corps.json?v=${corpsHash}`,
      judges: `judges.json?v=${judgesHash}`,
      merchCatalog: `merch/catalog/index.json?v=${merchCatalogHash}`,
      merchFacets: `merch/facets.json?v=${merchFacetsHash}`,
      merchStores: `merch/stores.json?v=${merchStoresHash}`,
    },
  };
  writeJson("manifest.json", manifest);
  writeJson("meta.json", meta);
  log(
    `JSON snapshot done: 3 collections + ${detailCount} per-detail files + manifest.`,
  );
};

// Auto-run only when invoked directly as a CLI (not when imported by the
// workflow, which calls runEmit with explicit args).
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).endsWith("emitReadModel.ts");
if (invokedDirectly) {
  runEmit(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error("[emit-read-model] FAILED:", err);
    process.exit(1);
  });
}
