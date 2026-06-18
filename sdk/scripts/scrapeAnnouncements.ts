// Announcement-post staff orchestrator (docs/announcement-sources-plan.md §A5).
//
// For each corps with a website: discover staff-announcement posts (WP REST + sitemap),
// fetch/RENDER each, extract staff (archetype-aware), derive the SEASON from the post
// title/URL (NOT the publish date), and coalesce into corps_staff — preferring the
// announcement's bio/photo (the roster grids usually lack both). Posts yielding <2 people
// are dropped (kills false-positive titles like "staff retreat"). `--apply` writes; default
// is a dry-run JSON report. Resumable per corps via scraper_progress.
//
// Usage (from sdk/):
//   npx tsx scripts/scrapeAnnouncements.ts --corps boston-crusaders --dry-run
//   npx tsx scripts/scrapeAnnouncements.ts --limit 5 --apply --concurrency 1
import { Effect, Layer, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadRepoEnv } from "./scriptEnv.js";
import { BrowserbaseService, BrowserbaseServiceLive } from "../src/browserbaseService.js";
import {
  discoverAnnouncementPosts,
  extractStaffFromAnnouncement,
  seasonFromAnnouncement,
  type ExtractedStaff,
} from "../src/staffScraper.js";
import { extractAnnouncementWithAI } from "../src/staffAiExtract.js";
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
const getOpt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const apply = hasFlag("--apply");
const force = hasFlag("--force");
const aiEnabled = hasFlag("--ai"); // A4: AI prose fallback for posts the deterministic passes under-yield (slow, token-cost)
const corpsFilter = getOpt("--corps");
const limit = getOpt("--limit") ? Number(getOpt("--limit")) : undefined;
const concurrency = Math.max(1, Math.min(getOpt("--concurrency") ? Number(getOpt("--concurrency")) : 1, 6));
const maxPosts = getOpt("--max-posts") ? Number(getOpt("--max-posts")) : 60;
const MIN_PEOPLE = 2; // a real staff announcement names ≥2 people; fewer = a false-positive title
const CURRENT_SEASON = new Date().getFullYear();

const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const TASK_TYPE = "staff-announcement";
const scrapeDate = new Date().toISOString().slice(0, 10);

const ensureProgressTable = (sql: SqlClient.SqlClient) =>
  sql`CREATE TABLE IF NOT EXISTS scraper_progress (
        task_type TEXT NOT NULL, season TEXT NOT NULL, corps_key TEXT NOT NULL,
        status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT,
        PRIMARY KEY (task_type, season, corps_key))`.pipe(Effect.asVoid);

// Agentic search-tier seeds: announcement URLs the agent harvested via WebSearch (Google/DDG
// scraping is IP-blocked from this box; the agent's WebSearch runs off-box). These supplement
// REST/sitemap/news discovery for holdout corps (Colts /news/NNN, etc.). The ingest path
// (render→extract→coalesce) is identical, so a seed is just another candidate URL.
const ensureSeedsTable = (sql: SqlClient.SqlClient) =>
  sql`CREATE TABLE IF NOT EXISTS announcement_seeds (
        corps_key TEXT NOT NULL, url TEXT NOT NULL, title TEXT, published TEXT,
        source TEXT DEFAULT 'agent-search', added_at TEXT,
        PRIMARY KEY (corps_key, url))`.pipe(Effect.asVoid);
const isCorpsDone = (sql: SqlClient.SqlClient, corpsKey: string) =>
  sql<{ status: string }>`SELECT status FROM scraper_progress WHERE task_type=${TASK_TYPE} AND season='all' AND corps_key=${corpsKey}`.pipe(
    Effect.map((r) => r[0]?.status === "done"),
  );
const markCorpsDone = (sql: SqlClient.SqlClient, corpsKey: string, payload: string) =>
  sql`INSERT INTO scraper_progress (task_type, season, corps_key, status, updated_at, payload)
        VALUES (${TASK_TYPE}, 'all', ${corpsKey}, 'done', ${new Date().toISOString()}, ${payload})
        ON CONFLICT(task_type, season, corps_key) DO UPDATE SET status='done', updated_at=excluded.updated_at, payload=excluded.payload`.pipe(Effect.asVoid);

interface PostResult { url: string; title: string; season: number; published: string | null; recs: ExtractedStaff[]; }

/** Group a corps' announcement extractions into per-person CorpsStaffMember records, one
 *  assignment per (season,title). Identity fields = most-recent-season non-null. */
const buildMembers = (corpsKey: string, name: string, posts: PostResult[]): CorpsStaffMember[] => {
  const byPerson = new Map<string, { name: string; rows: { season: number; post: PostResult; rec: ExtractedStaff }[] }>();
  for (const post of posts)
    for (const rec of post.recs) {
      const pid = makeStaffPersonId(rec.displayName);
      if (!pid) continue;
      const entry = byPerson.get(pid) ?? { name: rec.displayName, rows: [] };
      entry.rows.push({ season: post.season, post, rec });
      byPerson.set(pid, entry);
    }
  const members: CorpsStaffMember[] = [];
  for (const [pid, { name: dn, rows }] of byPerson) {
    const ordered = [...rows].sort((a, b) => b.season - a.season);
    const firstWith = <K extends keyof ExtractedStaff>(k: K) => ordered.map((r) => r.rec[k]).find((v) => v != null) ?? null;
    const seen = new Set<string>();
    const assignments = ordered
      .filter(({ season, rec }) => { const k = `${season}|${rec.title ?? ""}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(({ season, post, rec }) => ({
        assignmentId: null, corpsKey, corpsName: name, season: String(season),
        title: rec.title, roleType: rec.caption, startYear: season, endYear: season,
        startDate: post.published?.slice(0, 10) ?? `${season}-08-01`, endDate: null,
        notes: `announcement/${rec.confidence}`,
        links: [{ label: "announcement", url: post.url, kind: "announcement" }],
      }));
    members.push({
      staffId: `${corpsKey}:${pid}`,
      givenName: firstWith("givenName") as string | null,
      familyName: firstWith("familyName") as string | null,
      displayName: dn,
      defaultTitle: firstWith("title") as string | null,
      biography: firstWith("biography") as string | null,
      photoUrl: firstWith("photoUrl") as string | null,
      externalLinks: [], affiliations: [], assignments,
      metadata: { sourceUrls: posts.map((p) => p.url), source: "announcement" },
    });
  }
  return members;
};

/** Coalescing apply — PREFER the announcement's bio/photo (richer than the roster grid), but
 *  never null an existing field. Verify+cache the headshot first. */
const applyMember = (sql: SqlClient.SqlClient, m: CorpsStaffMember) =>
  Effect.gen(function* () {
    const media = yield* MediaService;
    let photoUrl = m.photoUrl;
    if (photoUrl) {
      const verdict = yield* verifyImageUrl(photoUrl);
      if (verdict.ok)
        yield* media.cache({ ownerType: "staff", ownerId: m.staffId, role: "headshot", sourceUrl: photoUrl, title: `${m.displayName} headshot`, attribution: "corps staff announcement", metadata: { contentType: verdict.contentType } })
          .pipe(Effect.catch((e) => Effect.logWarning(`headshot cache failed for ${m.displayName}: ${String(e)}`)));
      else photoUrl = null;
    }
    const existing = yield* sql<{ given_name: string | null; family_name: string | null; default_title: string | null; biography: string | null; photo_url: string | null }>`
      SELECT given_name, family_name, default_title, biography, photo_url FROM corps_staff WHERE staff_id=${m.staffId}`;
    const e = existing[0];
    yield* upsertStaffMember(sql, {
      ...m,
      givenName: m.givenName ?? e?.given_name ?? null,
      familyName: m.familyName ?? e?.family_name ?? null,
      // Announcement title/bio/photo PREFERRED (they carry the detail grids lack); fall back to existing.
      defaultTitle: m.defaultTitle ?? e?.default_title ?? null,
      biography: m.biography ?? e?.biography ?? null,
      photoUrl: photoUrl ?? e?.photo_url ?? null,
    });
  });

const processCorps = (sql: SqlClient.SqlClient, c: { corps_key: string; name: string; website: string }, idx: number, total: number) =>
  Effect.gen(function* () {
    if (!force && (yield* isCorpsDone(sql, c.corps_key)))
      return { corpsKey: c.corps_key, name: c.name, posts: 0, people: 0, skipped: true };
    const browser = yield* BrowserbaseService;
    const discovered = yield* discoverAnnouncementPosts(c.website, { max: maxPosts }).pipe(Effect.catch(() => Effect.succeed([])));
    // Merge agent-harvested seed URLs (search tier) — deduped against discovery by URL.
    const seedRows = yield* sql<{ url: string; title: string | null; published: string | null }>`
      SELECT url, title, published FROM announcement_seeds WHERE corps_key=${c.corps_key}`;
    const known = new Set(discovered.map((p) => p.url.replace(/\/+$/, "")));
    const seeds = seedRows
      .filter((s) => !known.has(s.url.replace(/\/+$/, "")))
      .map((s) => ({ url: s.url, title: s.title ?? "", publishedDate: s.published, html: null as string | null }));
    const candidates = [...discovered, ...seeds];
    const results: PostResult[] = [];
    for (const p of candidates) {
      const season = seasonFromAnnouncement(p.title, p.url, p.publishedDate ? { year: Number(p.publishedDate.slice(0, 4)), month: Number(p.publishedDate.slice(5, 7)) } : undefined, CURRENT_SEASON);
      if (!season) continue;
      // WP REST gave inline HTML; otherwise render (Wix/Squarespace posts are SPAs).
      const html = p.html ?? (yield* browser.fetchHtml(p.url).pipe(Effect.catch(() => Effect.succeed(""))));
      // A4: when --ai is set, the grounded AI extractor is AUTHORITATIVE — it parses prose AND
      // returns [] for non-staff pages, whereas the deterministic passes emit nav-menu junk on
      // custom SPAs (Colts). Without --ai, use the fast deterministic passes (great for WP/Wix).
      let recs: ExtractedStaff[];
      if (aiEnabled && html.length > 200) {
        const ai = yield* extractAnnouncementWithAI(html, p.url, c.name).pipe(Effect.catch(() => Effect.succeed({ staff: [] as ExtractedStaff[], engine: null })));
        recs = ai.staff;
      } else {
        recs = extractStaffFromAnnouncement(html, p.url, p.title);
      }
      if (recs.length >= MIN_PEOPLE) results.push({ url: p.url, title: p.title, season: season.season, published: p.publishedDate, recs });
    }
    const members = buildMembers(c.corps_key, c.name, results);
    if (apply) {
      yield* Effect.forEach(members, (m) => applyMember(sql, m), { discard: true, concurrency: 1 });
      yield* markCorpsDone(sql, c.corps_key, JSON.stringify({ posts: results.length, people: members.length, at: scrapeDate }));
    }
    const seasonsSpan = [...new Set(results.map((r) => r.season))].sort();
    yield* Effect.logInfo(`[${idx}/${total}] ${c.name} → ${discovered.length}+${seeds.length}s posts, ${results.length} staff-posts, ${members.length} people${seasonsSpan.length ? ` [${seasonsSpan[0]}–${seasonsSpan[seasonsSpan.length - 1]}]` : ""}`);
    return { corpsKey: c.corps_key, name: c.name, postsDiscovered: discovered.length, seedsUsed: seeds.length, staffPosts: results.length, people: members.length, seasons: seasonsSpan, skipped: false };
  });

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureStaffSchema;
  yield* ensureProgressTable(sql);
  yield* ensureSeedsTable(sql);
  const rows = corpsFilter
    ? yield* sql<{ corps_key: string; name: string; website: string }>`SELECT corps_key, name, website FROM corps WHERE corps_key=${corpsFilter} AND website IS NOT NULL AND TRIM(website)!=''`
    : yield* sql<{ corps_key: string; name: string; website: string }>`SELECT corps_key, name, website FROM corps WHERE website IS NOT NULL AND TRIM(website)!='' ORDER BY (division_name='World Class') DESC, name`;
  const targets = limit !== undefined ? rows.slice(0, limit) : [...rows];
  yield* Effect.logInfo(`Announcement scrape: ${targets.length} corps, concurrency=${concurrency}, ${apply ? "APPLY" : "dry-run"}, maxPosts=${maxPosts}`);
  const counter = yield* Ref.make(0);
  const summaries = yield* Effect.forEach(
    targets,
    (c) => Effect.gen(function* () { const n = yield* Ref.updateAndGet(counter, (x) => x + 1); return yield* processCorps(sql, c, n, targets.length); }),
    { concurrency },
  );
  const live = summaries.filter((s) => !s.skipped);
  yield* Effect.logInfo(`${apply ? "Applied" : "Dry-run"}: ${live.reduce((a, s) => a + (s.people ?? 0), 0)} people from ${live.reduce((a, s) => a + (s.staffPosts ?? 0), 0)} staff-posts across ${live.filter((s) => (s.people ?? 0) > 0).length} corps.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(SDK_DIR, "results", "staff-announcement");
  yield* Effect.sync(() => { mkdirSync(outDir, { recursive: true }); writeFileSync(resolve(outDir, `announce-${stamp}.json`), JSON.stringify({ scrapedAt: stamp, corps: summaries }, null, 2)); });
  yield* Effect.logInfo(`Summary → results/staff-announcement/announce-${stamp}.json`);
});

const MEDIA_CACHE_URL = process.env.MEDIA_CACHE_DB_URL ?? `file:${resolve(SDK_DIR, "media-cache.db")}`;
const SqlLayer = LibsqlClient.layer({ url: DB_URL });
const MediaLayer = makeMediaServiceLayer({ cacheDbUrl: MEDIA_CACHE_URL }).pipe(Layer.provide(SqlLayer));
const AppLayer = Layer.mergeAll(SqlLayer, BrowserbaseServiceLive, MediaLayer);
Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
