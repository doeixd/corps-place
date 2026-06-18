// S1.1 — Per-person detail-page follower (docs/staff-quality-plan.md).
//
// The roster scraper stops at the staff GRID; many corps put the real bio + a larger
// headshot one click deeper, on a per-person page (/staff/<name>, Wix /team/<name>,
// WP author/permalink). For each corps this:
//   1. loads its DB roster rows that are MISSING a bio and/or photo (the targets),
//   2. discovers the staff page (render ladder, sub-pages merged),
//   3. finds per-person detail links matching a target name (findPersonDetailLinks),
//   4. fetches+extracts each detail page and fills bio/photo FILL-IF-EMPTY on the
//      matching staff_id (verify+cache the headshot; never null an existing value),
//   5. records the detail URL as a corps_staff_links row (kind='detail-page') + appends
//      it to metadata.sourceUrls.
//
// Default is a dry-run report; --apply writes. Memory-frugal (concurrency 1 by default)
// so it can co-exist with other jobs on the 4 GB box.
//
// Usage (from sdk/):
//   npx tsx scripts/scrapeStaffDetail.ts --corps bluecoats --dry-run
//   npx tsx scripts/scrapeStaffDetail.ts --limit 10 --concurrency 1 --apply

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
  discoverDetailLinksNoRender,
  extractPersonDetail,
  fetchAndExtract,
  findPersonDetailLinks,
  seasonFromSlug,
} from "../src/staffScraper.js";
import { verifyImageUrl } from "../src/staffImage.js";
import { makeMediaServiceLayer, MediaService } from "../src/mediaService.js";
import { ensureStaffSchema } from "../src/relational.js";

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
// Default to render-FREE discovery (safe on the 4 GB box; SSR staff pages). --render opts
// into Chromium discovery for SPA sites — heavy, use only for targeted single-corps runs.
const useRender = hasFlag("--render");
const corpsFilter = getOpt("--corps");
const limit = getOpt("--limit") ? Number(getOpt("--limit")) : undefined;
const concurrency = Math.max(1, Math.min(getOpt("--concurrency") ? Number(getOpt("--concurrency")) : 1, 4));
const MAX_LINKS_PER_CORPS = Number(getOpt("--max-links") ?? 80); // bound per-corps detail fetches

const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;

/** Match a detail-page name to a roster name (lowercase, strip honorific/punct/accents). */
const nameKey = (s: string): string =>
  s.replace(/^(dr|mr|mrs|ms|miss|prof|professor|sir|dame|rev|fr|capt|sgt)\.?\s+/i, "")
    .toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

const BIO_MIN = 40; // chars below which a bio counts as "missing"
const ISO_EPOCH = "1970-01-01T00:00:00.000Z"; // legacy candidates sort oldest (never "current")
const nowIso = new Date().toISOString(); // one timestamp for this run's candidates

interface TargetRow {
  staff_id: string;
  person_id: string | null;
  display_name: string;
  family_name: string | null;
  biography: string | null;
  photo_url: string | null;
  metadata_json: string | null;
}

/** Record a bio/photo candidate (keeping any prior value as a 'legacy' candidate), then
 *  recompute the CURRENT pick (most-recent candidate) into corps_staff. Never loses data —
 *  old candidates stay for later AI merge / best-photo selection. */
const recordCandidate = (
  sql: SqlClient.SqlClient,
  row: TargetRow,
  kind: "bio" | "photo",
  value: string,
  sourceUrl: string,
  sourceKind: string,
  sourceDate: string, // the CONTENT's date/season — drives the 'current' pick
  nowIso: string,
) =>
  Effect.gen(function* () {
    // 1. Preserve the existing column value as a legacy candidate (idempotent). Its source
    //    date is unknown, so it sorts oldest and only stays current if nothing dated beats it.
    const existing = (kind === "bio" ? row.biography : row.photo_url)?.trim() ?? "";
    if (existing && existing !== value)
      yield* sql`INSERT OR IGNORE INTO staff_profile_candidates
            (staff_id, kind, source_url, person_id, value, source_kind, char_len, source_date, fetched_at, is_current)
            VALUES (${row.staff_id}, ${kind}, ${"legacy://" + row.staff_id}, ${row.person_id}, ${existing}, ${"legacy"}, ${existing.length}, ${ISO_EPOCH}, ${nowIso}, 0)`.pipe(
        Effect.orElseSucceed(() => undefined),
      );
    // 2. Upsert this candidate (re-runs refresh in place).
    yield* sql`INSERT INTO staff_profile_candidates
          (staff_id, kind, source_url, person_id, value, source_kind, char_len, source_date, fetched_at, is_current)
          VALUES (${row.staff_id}, ${kind}, ${sourceUrl}, ${row.person_id}, ${value}, ${sourceKind}, ${value.length}, ${sourceDate}, ${nowIso}, 0)
          ON CONFLICT(staff_id, kind, source_url) DO UPDATE SET
            value=excluded.value, char_len=excluded.char_len, source_date=excluded.source_date, fetched_at=excluded.fetched_at, source_kind=excluded.source_kind`.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    // 3. Current = candidate with the most-recent CONTENT date (tie-break: longer). Write it.
    const top = yield* sql<{ value: string; source_url: string }>`
          SELECT value, source_url FROM staff_profile_candidates
           WHERE staff_id=${row.staff_id} AND kind=${kind}
           ORDER BY source_date DESC, char_len DESC LIMIT 1`;
    if (top[0]) {
      yield* sql`UPDATE staff_profile_candidates SET is_current=0 WHERE staff_id=${row.staff_id} AND kind=${kind}`;
      yield* sql`UPDATE staff_profile_candidates SET is_current=1 WHERE staff_id=${row.staff_id} AND kind=${kind} AND source_url=${top[0].source_url}`;
      if (kind === "bio") yield* sql`UPDATE corps_staff SET biography=${top[0].value} WHERE staff_id=${row.staff_id}`;
      else yield* sql`UPDATE corps_staff SET photo_url=${top[0].value} WHERE staff_id=${row.staff_id}`;
    }
  });
interface CorpsFill {
  corpsKey: string;
  name: string;
  staffPageUrl: string | null;
  targets: number;
  detailLinks: number;
  biosFilled: number;
  photosFilled: number;
  fills: Array<{ name: string; url: string; bio: boolean; photo: boolean }>;
}

const needsBio = (r: TargetRow) => (r.biography ?? "").trim().length < BIO_MIN;
const needsPhoto = (r: TargetRow) => !(r.photo_url ?? "").trim();

const processCorps = (sql: SqlClient.SqlClient, c: { corps_key: string; name: string; website: string }) =>
  Effect.gen(function* () {
    const fill: CorpsFill = {
      corpsKey: c.corps_key, name: c.name, staffPageUrl: null,
      targets: 0, detailLinks: 0, biosFilled: 0, photosFilled: 0, fills: [],
    };

    // Roster rows for this corps that lack a bio and/or photo.
    const rows = yield* sql<TargetRow>`
      SELECT DISTINCT cs.staff_id, cs.person_id, cs.display_name, cs.family_name, cs.biography, cs.photo_url, cs.metadata_json
        FROM corps_staff cs
        JOIN corps_staff_assignments a ON a.staff_id = cs.staff_id
       WHERE a.corps_key = ${c.corps_key}`;
    const targets = rows.filter((r) => needsBio(r) || needsPhoto(r));
    fill.targets = targets.length;
    if (targets.length === 0) return fill;

    // nameKey → all roster rows sharing that name (same person can appear on >1 staff_id).
    const byName = new Map<string, TargetRow[]>();
    for (const r of targets) {
      const k = nameKey(r.display_name);
      (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
    }

    const names = targets.map((t) => t.display_name);
    let links: Array<{ url: string; name: string }>;
    if (useRender) {
      // Chromium discovery (catches SPA sites) — heavy; only when --render is passed.
      const discovered = yield* discoverStaffPage(c.website).pipe(Effect.orElseSucceed(() => null));
      if (!discovered) return fill;
      fill.staffPageUrl = discovered.url;
      links = findPersonDetailLinks(discovered.html, discovered.url, names);
    } else {
      // Render-FREE discovery (default) — safe on the 4 GB box; SSR staff pages only.
      const d = yield* discoverDetailLinksNoRender(c.website, names).pipe(
        Effect.orElseSucceed(() => ({ staffPageUrl: null, links: [] as Array<{ url: string; name: string }> })),
      );
      fill.staffPageUrl = d.staffPageUrl;
      links = d.links;
    }
    links = links.filter((l) => byName.has(nameKey(l.name))).slice(0, MAX_LINKS_PER_CORPS);
    fill.detailLinks = links.length;

    for (const link of links) {
      const matchRows = byName.get(nameKey(link.name));
      if (!matchRows || matchRows.length === 0) continue;
      // Only fetch if at least one matching row still needs something.
      if (!matchRows.some((r) => needsBio(r) || needsPhoto(r))) continue;

      const r = yield* fetchAndExtract(link.url, { noRender: !useRender }).pipe(
        Effect.orElseSucceed(() => ({ url: link.url, html: "", staff: [], rendered: false })),
      );
      // Detail pages are single-person prose, NOT roster grids — use the dedicated parser
      // (name-grounded: rejects a generic corps blurb that doesn't mention the person).
      const det = extractPersonDetail(r.html, link.url, link.name);
      // Guard: the page's own name (if found) must match the roster name we followed.
      if (det.displayName && nameKey(det.displayName) !== nameKey(link.name)) continue;

      const newBio = (det.biography ?? "").trim().length >= BIO_MIN ? det.biography!.trim() : null;
      let newPhoto: string | null = det.photoUrl;

      // Verify the headshot ONCE (the same URL is recorded for every matching row).
      if (newPhoto) {
        const verdict = yield* verifyImageUrl(newPhoto);
        newPhoto = verdict.ok ? newPhoto : null;
      }
      if (!newBio && !newPhoto) continue;

      // Source date drives the 'current' pick: a season-stamped slug ("/2025-greg-power")
      // dates the content to that year; an undated live page reflects the current roster.
      const slugYear = seasonFromSlug(link.url);
      const srcDate = slugYear ? `${slugYear}-12-31T00:00:00.000Z` : nowIso;

      let didBio = false, didPhoto = false;
      for (const row of matchRows) {
        if (apply && newBio) {
          yield* recordCandidate(sql, row, "bio", newBio, link.url, "detail-page", srcDate, nowIso);
          didBio = true;
        }
        if (apply && newPhoto) {
          const media = yield* MediaService;
          yield* media
            .cache({
              ownerType: "staff", ownerId: row.staff_id, role: "headshot",
              sourceUrl: newPhoto, title: `${row.display_name} headshot`,
              attribution: "corps staff detail page",
              metadata: { detailUrl: link.url },
            })
            .pipe(Effect.orElseSucceed(() => undefined));
          yield* recordCandidate(sql, row, "photo", newPhoto, link.url, "detail-page", srcDate, nowIso);
          didPhoto = true;
        }
        if (apply) {
          yield* sql`INSERT OR IGNORE INTO corps_staff_links (staff_id, url, label, kind)
                       VALUES (${row.staff_id}, ${link.url}, ${"detail page"}, ${"detail-page"})`.pipe(
            Effect.orElseSucceed(() => undefined),
          );
          const meta = ((): { sourceUrls?: string[] } => {
            try { return JSON.parse(row.metadata_json ?? "{}"); } catch { return {}; }
          })();
          const srcs = new Set(meta.sourceUrls ?? []);
          srcs.add(link.url);
          yield* sql`UPDATE corps_staff SET metadata_json=${JSON.stringify({ ...meta, sourceUrls: [...srcs] })} WHERE staff_id=${row.staff_id}`;
        }
      }
      // Dry-run: report what we WOULD record for this detail link.
      if (!apply) { didBio = !!newBio; didPhoto = !!newPhoto; }
      if (didBio) fill.biosFilled++;
      if (didPhoto) fill.photosFilled++;
      if (didBio || didPhoto) fill.fills.push({ name: link.name, url: link.url, bio: didBio, photo: didPhoto });
    }
    return fill;
  });

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureStaffSchema; // additive: staff_profile_candidates table (idempotent)
  if (apply) yield* sql`PRAGMA busy_timeout=15000`; // shared DB — other jobs may be writing
  const rows = corpsFilter
    ? yield* sql<{ corps_key: string; name: string; website: string }>`
        SELECT corps_key, name, website FROM corps WHERE corps_key=${corpsFilter} AND website IS NOT NULL AND TRIM(website)!=''`
    : yield* sql<{ corps_key: string; name: string; website: string }>`
        SELECT corps_key, name, website FROM corps
         WHERE website IS NOT NULL AND TRIM(website)!=''
         ORDER BY (division_name='World Class') DESC, name`;
  const targets = limit !== undefined ? rows.slice(0, limit) : [...rows];
  yield* Effect.logInfo(
    `Staff detail-page enrichment: ${targets.length} corps, concurrency=${concurrency}, ` +
      `${apply ? "APPLY" : "dry-run"}, browserbase=${Boolean(process.env.BROWSERBASE_API_KEY)}`,
  );

  const done = yield* Ref.make(0);
  const run = (c: { corps_key: string; name: string; website: string }) =>
    Effect.gen(function* () {
      const fill = yield* processCorps(sql, c).pipe(
        Effect.catch((e) => Effect.logWarning(`[${c.corps_key}] ${String(e)}`).pipe(Effect.as(null))),
      );
      const n = yield* Ref.updateAndGet(done, (x) => x + 1);
      if (fill)
        yield* Effect.logInfo(
          `[${n}/${targets.length}] ${fill.name}: ${fill.targets} need-enrich, ${fill.detailLinks} detail links → ` +
            `${apply ? "filled" : "would fill"} ${fill.biosFilled} bios, ${fill.photosFilled} photos`,
        );
      return fill;
    });

  const summaries = (yield* Effect.forEach(targets, run, { concurrency })).filter(Boolean) as CorpsFill[];
  const totBio = summaries.reduce((s, r) => s + r.biosFilled, 0);
  const totPhoto = summaries.reduce((s, r) => s + r.photosFilled, 0);
  yield* Effect.logInfo(
    apply
      ? `Applied: ${totBio} bios, ${totPhoto} photos across ${summaries.length} corps.`
      : `Dry run: would fill ${totBio} bios, ${totPhoto} photos across ${summaries.length} corps.`,
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(SDK_DIR, "results", "staff-detail");
  yield* Effect.sync(() => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, `staff-detail-${stamp}.json`),
      JSON.stringify({ scrapedAt: stamp, apply, totBio, totPhoto, corps: summaries }, null, 2),
    );
  });
  yield* Effect.logInfo(`Report written to results/staff-detail/staff-detail-${stamp}.json`);
});

const MEDIA_CACHE_URL = process.env.MEDIA_CACHE_DB_URL ?? `file:${resolve(SDK_DIR, "media-cache.db")}`;
const SqlLayer = LibsqlClient.layer({ url: DB_URL });
const MediaLayer = makeMediaServiceLayer({ cacheDbUrl: MEDIA_CACHE_URL }).pipe(Layer.provide(SqlLayer));
const AppLayer = Layer.mergeAll(SqlLayer, BrowserbaseServiceLive, MediaLayer);

Effect.runPromise(program.pipe(Effect.provide(AppLayer)))
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
