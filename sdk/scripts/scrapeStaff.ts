// Staff scraper orchestrator (docs/staff-scraping-plan.md M3).
//
// For each corps with a website, discover its staff page, extract the current-season
// roster, then walk Wayback for prior seasons (year-bounded). Groups extracted people
// into per-person records with one season-scoped assignment each, and writes a
// reviewable JSON report. `--apply` coalesces into corps_staff (non-null-wins, never
// nulls an existing field — the upsert overwrites, so we merge BEFORE calling it).
//
// Usage (from sdk/):
//   npx tsx scripts/scrapeStaff.ts --corps boston-crusaders --seasons 2013-2026 --dry-run
//   npx tsx scripts/scrapeStaff.ts --limit 5 --concurrency 2            # dry-run report
//   npx tsx scripts/scrapeStaff.ts --corps bluecoats --seasons 2024-2026 --apply

import { Effect, Layer, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadRepoEnv } from "./scriptEnv.js";
import { BrowserbaseServiceLive } from "../src/browserbaseService.js";
import {
  discoverStaffPage,
  fetchAndExtract,
  waybackSnapshot,
  type ExtractedStaff,
} from "../src/staffScraper.js";
import { extractStaffWithAI } from "../src/staffAiExtract.js";
import { verifyImageUrl } from "../src/staffImage.js";
import { makeMediaServiceLayer, MediaService } from "../src/mediaService.js";
import {
  ensureStaffSchema,
  makeStaffPersonId,
  upsertStaffMember,
  type CorpsStaffMember,
} from "../src/relational.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const getOpt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = hasFlag("--apply");
const dryRun = !apply; // default is dry-run
const aiEnabled = hasFlag("--ai"); // Pattern B fallback for pages Pattern A can't parse (slow, token-cost)
const corpsFilter = getOpt("--corps");
const limit = getOpt("--limit") ? Number(getOpt("--limit")) : undefined;
const concurrency = Math.max(1, Math.min(getOpt("--concurrency") ? Number(getOpt("--concurrency")) : 2, 8));
const CURRENT_SEASON = Number(getOpt("--current-season") ?? new Date().getFullYear());

const parseSeasons = (spec: string | undefined): number[] => {
  if (!spec) return [CURRENT_SEASON];
  const m = spec.match(/^(\d{4})-(\d{4})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }
  return spec.split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
};
// Clamp to ≤ current season — future years have no roster yet and would otherwise
// mislabel the live page as e.g. 2030 (#4).
const requestedSeasons = parseSeasons(getOpt("--seasons"));
const seasons = requestedSeasons.filter((s) => s <= CURRENT_SEASON);
const droppedFutureSeasons = requestedSeasons.filter((s) => s > CURRENT_SEASON);

const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const TASK_TYPE = "staff-2013";

interface SeasonStaffRow {
  readonly season: string;
  readonly sourceUrl: string;
  readonly rendered: boolean;
  readonly fromWayback: boolean;
  readonly staff: ExtractedStaff[];
}
interface CorpsReport {
  readonly corpsKey: string;
  readonly name: string;
  readonly website: string;
  staffPageUrl: string | null;
  readonly seasons: SeasonStaffRow[];
  /** Requested seasons actually handled this run (not skipped/errored) — these get
   *  marked done AFTER the corps's rows are written (crash-safe incremental progress). */
  readonly processedSeasons: number[];
  note?: string;
}

/** Inline scraper_progress gating (helpers in scraperClaude are private). */
const ensureProgressTable = (sql: SqlClient.SqlClient) =>
  sql`CREATE TABLE IF NOT EXISTS scraper_progress (
        task_type TEXT NOT NULL, season TEXT NOT NULL, corps_key TEXT NOT NULL,
        status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT,
        PRIMARY KEY (task_type, season, corps_key))`.pipe(Effect.asVoid);

const isDone = (sql: SqlClient.SqlClient, season: string, corpsKey: string) =>
  sql<{ status: string }>`SELECT status FROM scraper_progress
      WHERE task_type=${TASK_TYPE} AND season=${season} AND corps_key=${corpsKey}`.pipe(
    Effect.map((rows) => rows[0]?.status === "done"),
  );

const markProgress = (sql: SqlClient.SqlClient, season: string, corpsKey: string, status: string) =>
  sql`INSERT INTO scraper_progress (task_type, season, corps_key, status, updated_at)
      VALUES (${TASK_TYPE}, ${season}, ${corpsKey}, ${status}, ${new Date().toISOString()})
      ON CONFLICT(task_type, season, corps_key) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`.pipe(
    Effect.asVoid,
  );

/** Date a role was observed: the Wayback capture date (from the snapshot URL), or null
 *  for a live page (caller falls back to the scrape date). */
const captureDateOf = (url: string): string | null => {
  const m = url.match(/web\.archive\.org\/web\/(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const scrapeDate = new Date().toISOString().slice(0, 10);

/** Group a corps' per-season extractions into per-person CorpsStaffMember records.
 *  Within one corps, same name → one staff_id with one assignment per season. */
const buildMembers = (corpsKey: string, report: CorpsReport): CorpsStaffMember[] => {
  const byPerson = new Map<string, { name: string; rows: { season: string; rec: ExtractedStaff }[] }>();
  for (const sr of report.seasons) {
    for (const rec of sr.staff) {
      const pid = makeStaffPersonId(rec.displayName);
      if (!pid) continue;
      const entry = byPerson.get(pid) ?? { name: rec.displayName, rows: [] };
      entry.rows.push({ season: sr.season, rec });
      byPerson.set(pid, entry);
    }
  }
  const members: CorpsStaffMember[] = [];
  for (const [pid, { name, rows }] of byPerson) {
    // Best identity fields = highest-confidence, most-recent non-null.
    const ordered = [...rows].sort((a, b) => Number(b.season) - Number(a.season));
    const firstWith = <K extends keyof ExtractedStaff>(k: K) =>
      ordered.map((r) => r.rec[k]).find((v) => v != null) ?? null;
    // One assignment per (season,title) — collapse same-season dupes.
    const assignSeen = new Set<string>();
    const assignments = ordered
      .map(({ season, rec }) => ({ season, rec }))
      .filter(({ season, rec }) => {
        const key = `${season}|${rec.title ?? ""}`;
        if (assignSeen.has(key)) return false;
        assignSeen.add(key);
        return true;
      })
      .map(({ season, rec }) => ({
        assignmentId: null,
        corpsKey,
        corpsName: report.name,
        season,
        title: rec.title,
        roleType: rec.caption,
        startYear: Number(season),
        endYear: Number(season),
        // Provenance: the date this role was OBSERVED — the Wayback capture date for an
        // archived season (parsed from the snapshot URL), else the scrape date for a live
        // page. So a career query can show "as of <date>, <role> at <corps>".
        startDate: captureDateOf(rec.sourceUrl) ?? scrapeDate,
        endDate: null,
        notes: `${rec.via}/${rec.confidence}`,
        // The exact source per role-year (which snapshot, live vs archived) — auditable.
        links: [
          {
            label: "source",
            url: rec.sourceUrl,
            kind: /web\.archive\.org/.test(rec.sourceUrl) ? "wayback" : "live",
          },
        ],
      }));
    // Detect a likely within-corps name collision (#6): two DIFFERENT same-named
    // people collapse into this one staff_id. Signal = the same season shows
    // conflicting headshots, or distinct headshots across overlapping roles. We
    // can't safely split them here, so flag for review rather than silently merge.
    const photosBySeason = new Map<string, Set<string>>();
    for (const { season, rec } of rows) {
      if (!rec.photoUrl) continue;
      (photosBySeason.get(season) ?? photosBySeason.set(season, new Set()).get(season)!).add(rec.photoUrl);
    }
    const possibleNameCollision = [...photosBySeason.values()].some((s) => s.size > 1);

    members.push({
      staffId: `${corpsKey}:${pid}`,
      givenName: firstWith("givenName") as string | null,
      familyName: firstWith("familyName") as string | null,
      displayName: name,
      defaultTitle: firstWith("title") as string | null,
      biography: firstWith("biography") as string | null,
      photoUrl: firstWith("photoUrl") as string | null,
      externalLinks: [],
      affiliations: [],
      assignments,
      metadata: {
        sourceUrls: report.seasons.map((s) => s.sourceUrl),
        ...(possibleNameCollision ? { possibleNameCollision: true } : {}),
      },
    });
  }
  return members;
};

const scrapeCorps = (
  sql: SqlClient.SqlClient,
  corps: { corps_key: string; name: string; website: string },
): Effect.Effect<CorpsReport> =>
  Effect.gen(function* () {
    const report: CorpsReport = {
      corpsKey: corps.corps_key,
      name: corps.name,
      website: corps.website,
      staffPageUrl: null,
      seasons: [],
      processedSeasons: [],
    };
    // Resume fast-path: if EVERY requested season is already done, skip discovery
    // entirely — avoids re-rendering finished corps (the slow part) on a resumed run.
    let anyPending = false;
    for (const s of seasons) {
      if (!(yield* isDone(sql, String(s), corps.corps_key))) {
        anyPending = true;
        break;
      }
    }
    if (!anyPending) {
      report.note = "all seasons already done (skipped)";
      return report;
    }

    // 1. Discover the current staff page once (gives the canonical URL to time-travel).
    const discovered = yield* discoverStaffPage(corps.website);
    if (!discovered) {
      report.note = "no staff page discovered";
      return report;
    }
    report.staffPageUrl = discovered.url;
    // Capture URLs already attributed to a season this run, so one capture shared by
    // adjacent seasons (±1yr tolerance) isn't double-counted.
    const usedSnapshots = new Set<string>();

    for (const seasonNum of seasons) {
      const season = String(seasonNum);
      if (yield* isDone(sql, season, corps.corps_key)) continue;
      if (seasonNum >= CURRENT_SEASON) {
        // Current season = the live discovered page. If Pattern A found nothing and
        // --ai is on, fall back to the LLM extractor on the rendered HTML (M4).
        let staff = discovered.staff;
        if (staff.length < 2 && aiEnabled && discovered.html) {
          const ai = yield* extractStaffWithAI(discovered.html, discovered.url);
          if (ai.staff.length > staff.length) staff = ai.staff;
        }
        report.seasons.push({ season, sourceUrl: discovered.url, rendered: discovered.rendered, fromWayback: false, staff });
      } else {
        // Past season = the closest in-tolerance 200-status Wayback capture.
        const snap = yield* waybackSnapshot(discovered.url, season);
        if (snap.status === "error") {
          // Transient (network/rate-limit) — do NOT mark done; retry on a later run.
          yield* Effect.logWarning(`wayback fetch failed for ${corps.name} ${season} — will retry`);
          continue;
        }
        if (snap.status === "absent") {
          report.seasons.push({ season, sourceUrl: discovered.url, rendered: false, fromWayback: true, staff: [] }); // genuine gap
        } else if (usedSnapshots.has(snap.snapshotUrl)) {
          report.seasons.push({ season, sourceUrl: snap.snapshotUrl, rendered: false, fromWayback: true, staff: [] });
        } else {
          usedSnapshots.add(snap.snapshotUrl);
          const r = yield* fetchAndExtract(snap.snapshotUrl, { noRender: true });
          // Label by the capture's ACTUAL year, not the requested season.
          report.seasons.push({ season: String(snap.snapshotYear), sourceUrl: snap.snapshotUrl, rendered: r.rendered, fromWayback: true, staff: r.staff });
        }
      }
      // Track the season as processed; it's marked done AFTER this corps's rows are
      // written (in the caller), so a crash never marks progress without persisting data.
      report.processedSeasons.push(seasonNum);
    }
    return report;
  });

/** Coalescing apply: never nulls an existing field. Verify+cache the headshot, merge
 *  scraped non-null over the existing row, then upsert (which overwrites). */
const applyMember = (sql: SqlClient.SqlClient, m: CorpsStaffMember) =>
  Effect.gen(function* () {
    const media = yield* MediaService;

    // Verify the photo (Content-Type image/*, not placeholder) before trusting it.
    // A verified photo is cached; an unverified one is dropped (we never write a bad
    // photo_url, and never null an existing good one).
    let photoUrl = m.photoUrl;
    if (photoUrl) {
      const verdict = yield* verifyImageUrl(photoUrl);
      if (verdict.ok) {
        yield* media
          .cache({
            ownerType: "staff",
            ownerId: m.staffId,
            role: "headshot",
            sourceUrl: photoUrl,
            title: `${m.displayName} headshot`,
            attribution: "corps staff page",
            metadata: { contentType: verdict.contentType },
          })
          .pipe(Effect.catch((e) => Effect.logWarning(`headshot cache failed for ${m.displayName}: ${String(e)}`)));
      } else {
        photoUrl = null; // failed verification — drop it
      }
    }

    const existing = yield* sql<{
      given_name: string | null;
      family_name: string | null;
      default_title: string | null;
      biography: string | null;
      photo_url: string | null;
    }>`SELECT given_name, family_name, default_title, biography, photo_url
         FROM corps_staff WHERE staff_id=${m.staffId}`;
    const e = existing[0];
    const merged: CorpsStaffMember = {
      ...m,
      givenName: m.givenName ?? e?.given_name ?? null,
      familyName: m.familyName ?? e?.family_name ?? null,
      defaultTitle: m.defaultTitle ?? e?.default_title ?? null,
      biography: m.biography ?? e?.biography ?? null,
      // Coalesce: verified new photo wins; else keep an existing one; never write a bad one.
      photoUrl: photoUrl ?? e?.photo_url ?? null,
    };
    yield* upsertStaffMember(sql, merged);
  });

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureStaffSchema; // additive: person_id column + corps_staff_review (idempotent)
  yield* ensureProgressTable(sql);

  const rows = corpsFilter
    ? yield* sql<{ corps_key: string; name: string; website: string }>`
        SELECT corps_key, name, website FROM corps WHERE corps_key=${corpsFilter} AND website IS NOT NULL AND TRIM(website)!=''`
    : yield* sql<{ corps_key: string; name: string; website: string }>`
        SELECT corps_key, name, website FROM corps
         WHERE website IS NOT NULL AND TRIM(website)!=''
         ORDER BY (division_name='World Class') DESC, name`;
  const targets = limit !== undefined ? rows.slice(0, limit) : [...rows];

  if (droppedFutureSeasons.length > 0)
    yield* Effect.logWarning(`Ignoring future seasons (no roster yet): ${droppedFutureSeasons.join(", ")}`);
  if (seasons.length === 0) {
    yield* Effect.logWarning("No seasons in range after clamping to the current season — nothing to do.");
    return;
  }
  yield* Effect.logInfo(
    `Staff scrape: ${targets.length} corps × seasons [${seasons[0]}..${seasons[seasons.length - 1]}], ` +
      `concurrency=${concurrency}, ${apply ? "APPLY" : "dry-run"}, browserbase=${Boolean(process.env.BROWSERBASE_API_KEY)}`,
  );

  // Process each corps end-to-end — scrape → APPLY its rows → mark its seasons done —
  // BEFORE moving on. This is crash-safe (a crash never marks progress without writing
  // data) and memory-light (we don't hold all 139 reports). Returns a lightweight summary.
  const done = yield* Ref.make(0);
  const processCorps = (c: { corps_key: string; name: string; website: string }) =>
    Effect.gen(function* () {
      const rep = yield* scrapeCorps(sql, c);
      const members = buildMembers(rep.corpsKey, rep);
      if (apply) {
        yield* Effect.forEach(members, (m) => applyMember(sql, m), { discard: true, concurrency: 1 });
        // Mark done ONLY after the rows are written.
        for (const s of rep.processedSeasons) yield* markProgress(sql, String(s), c.corps_key, "done");
      }
      const n = yield* Ref.updateAndGet(done, (x) => x + 1);
      const total = rep.seasons.reduce((s, r) => s + r.staff.length, 0);
      yield* Effect.logInfo(
        `[${n}/${targets.length}] ${rep.name} → ${rep.staffPageUrl ?? "NO STAFF PAGE"} (${members.length} people, ${total} role-rows across ${rep.seasons.length} seasons)`,
      );
      return {
        corpsKey: rep.corpsKey,
        name: rep.name,
        staffPageUrl: rep.staffPageUrl,
        note: rep.note,
        members: members.length,
        seasons: rep.seasons.length,
      };
    });

  const summaries = yield* Effect.forEach(targets, processCorps, { concurrency });
  yield* Effect.logInfo(
    apply
      ? `Applied ${summaries.reduce((s, r) => s + r.members, 0)} staff members across ${summaries.length} corps.`
      : "Dry run — no DB writes (summary only).",
  );

  // Lightweight summary report (no per-person detail held in memory).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(SDK_DIR, "results", "staff-scan");
  yield* Effect.sync(() => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, `staff-scan-${stamp}.json`),
      JSON.stringify({ scrapedAt: stamp, seasons, count: summaries.length, corps: summaries }, null, 2),
    );
  });
  yield* Effect.logInfo(`Summary written to results/staff-scan/staff-scan-${stamp}.json`);
});

const MEDIA_CACHE_URL = process.env.MEDIA_CACHE_DB_URL ?? `file:${resolve(SDK_DIR, "media-cache.db")}`;
const SqlLayer = LibsqlClient.layer({ url: DB_URL });
const MediaLayer = makeMediaServiceLayer({ cacheDbUrl: MEDIA_CACHE_URL }).pipe(Layer.provide(SqlLayer));
const AppLayer = Layer.mergeAll(SqlLayer, BrowserbaseServiceLive, MediaLayer);

Effect.runPromise(program.pipe(Effect.provide(AppLayer)))
  .then(() => {
    console.log("Done.");
    // The shared render browser is held open by the service layer (no scope finalizer),
    // which keeps the event loop alive; exit explicitly so the CLI terminates.
    process.exit(0);
  })
  .catch((err) => {
    console.error("scrapeStaff failed:", err);
    process.exit(1);
  });
