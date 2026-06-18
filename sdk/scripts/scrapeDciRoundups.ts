// DCI multi-corps roundup ingestor (docs/announcement-sources-plan.md §A4).
//
// DCI publishes "corps news and announcements" roundups (dci.org/news/...-YYYYMMDD) that name
// staff for MANY corps in one page. We discover roundups (WP post-sitemaps), AI-extract
// (corps, name, title) tuples, MAP each corps name → our corps_key, derive the season from the
// roundup DATE (fall → next season), and coalesce per corps. Cross-corps attribution is the
// risk, so extraction is grounded (name+corps must appear in the page) and unmapped corps are
// skipped. `--apply` writes; default dry-run.
//
// Usage (from sdk/):
//   npx tsx scripts/scrapeDciRoundups.ts --limit 5 --dry-run
//   npx tsx scripts/scrapeDciRoundups.ts --url https://www.dci.org/news/corps-news-and-announcements-20181026/ --apply
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadRepoEnv } from "./scriptEnv.js";
import { BrowserbaseService, BrowserbaseServiceLive } from "../src/browserbaseService.js";
import { extractDciRoundupWithAI, closeOpencode, type RoundupItem } from "../src/staffAiExtract.js";
import { verifyImageUrl } from "../src/staffImage.js";
import { makeMediaServiceLayer, MediaService } from "../src/mediaService.js";
import { ensureStaffSchema, makeStaffPersonId, normalizeCaption, upsertStaffMember, type CorpsStaffMember } from "../src/relational.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const getOpt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const apply = hasFlag("--apply");
const oneUrl = getOpt("--url");
const limit = getOpt("--limit") ? Number(getOpt("--limit")) : 8;
const sinceYear = getOpt("--since-year") ? Number(getOpt("--since-year")) : 2013;
const CURRENT_SEASON = new Date().getFullYear();
const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const DCI_ORIGIN = "https://www.dci.org";

/** Season a roundup refers to: the date in the URL (YYYYMMDD); fall (Sep–Dec) announces next season. */
const seasonOfRoundup = (url: string): { season: number; date: string } | null => {
  const m = url.match(/(\d{4})(\d{2})(\d{2})/);
  if (!m) return null;
  const [y, mo] = [Number(m[1]), Number(m[2])];
  const season = mo >= 9 ? y + 1 : y;
  return season >= sinceYear && season <= CURRENT_SEASON + 1 ? { season, date: `${m[1]}-${m[2]}-${m[3]}` } : null;
};

const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureStaffSchema;
  const browser = yield* BrowserbaseService;
  const media = yield* MediaService;

  // corps name → key map (normalized; also strip a leading "the").
  const corpsRows = yield* sql<{ corps_key: string; name: string }>`SELECT corps_key, name FROM corps WHERE name IS NOT NULL`;
  const byName = new Map<string, string>();
  for (const c of corpsRows) if (!byName.has(norm(c.name))) byName.set(norm(c.name), c.corps_key);
  const matchCorps = (corps: string): string | null => {
    const n = norm(corps);
    if (byName.has(n)) return byName.get(n)!;
    // contains-match either direction (e.g. "Music City" ↔ "Music City Mystique").
    for (const [k, key] of byName) if (k.length > 4 && (k.includes(n) || n.includes(k))) return key;
    return null;
  };

  // Discover roundup URLs (unless a single --url was given): WP post-sitemaps → slugs containing
  // "corps-news-and-announcements", newest first.
  let urls: string[] = [];
  if (oneUrl) urls = [oneUrl];
  else {
    const idx = yield* browser.fetchHtml(`${DCI_ORIGIN}/sitemap.xml`).pipe(Effect.catch(() => Effect.succeed("")));
    const maps = [...idx.matchAll(/<loc>\s*([^<]+post-sitemap[^<]*)<\/loc>/gi)].map((m) => m[1]!.trim());
    const all = new Set<string>();
    for (const map of maps.slice(0, 14)) {
      const sm = yield* browser.fetchHtml(map).pipe(Effect.catch(() => Effect.succeed("")));
      for (const m of sm.matchAll(/<loc>\s*([^<]*corps-news-and-announcements[^<]*)<\/loc>/gi)) all.add(m[1]!.trim().replace(/\/+$/, ""));
    }
    urls = [...all].filter((u) => seasonOfRoundup(u)).sort().reverse().slice(0, limit);
  }
  yield* Effect.logInfo(`DCI roundups: ${urls.length} pages, ${apply ? "APPLY" : "dry-run"}`);

  const summary: any[] = [];
  let appliedPeople = 0;
  for (const url of urls) {
    const meta = seasonOfRoundup(url);
    if (!meta) continue;
    const html = yield* browser.fetchHtml(url).pipe(Effect.catch(() => Effect.succeed("")));
    if (html.length < 200) continue;
    const { items, engine } = yield* extractDciRoundupWithAI(html, url).pipe(Effect.catch(() => Effect.succeed({ items: [] as RoundupItem[], engine: null })));
    // group tuples by mapped corps_key
    const byCorps = new Map<string, RoundupItem[]>();
    let unmapped = 0;
    for (const it of items) { const key = matchCorps(it.corps); if (!key) { unmapped++; continue; } (byCorps.get(key) ?? byCorps.set(key, []).get(key)!).push(it); }
    let people = 0;
    for (const [corpsKey, group] of byCorps) {
      for (const it of group) {
        const pid = makeStaffPersonId(it.name);
        if (!pid) continue;
        const staffId = `${corpsKey}:${pid}`;
        const member: CorpsStaffMember = {
          staffId, givenName: null, familyName: null, displayName: it.name,
          defaultTitle: it.title, biography: it.bio, photoUrl: null, externalLinks: [], affiliations: [],
          assignments: [{ assignmentId: null, corpsKey, corpsName: it.corps, season: String(meta.season), title: it.title, roleType: normalizeCaption(it.title), startYear: meta.season, endYear: meta.season, startDate: meta.date, endDate: null, notes: `dci-roundup/${engine}`, links: [{ label: "dci-roundup", url, kind: "announcement" }] }],
          metadata: { sourceUrls: [url], source: "dci-roundup" },
        };
        people++;
        if (apply) {
          const ex = yield* sql<{ biography: string | null; default_title: string | null }>`SELECT biography, default_title FROM corps_staff WHERE staff_id=${staffId}`;
          yield* upsertStaffMember(sql, { ...member, biography: member.biography ?? ex[0]?.biography ?? null, defaultTitle: member.defaultTitle ?? ex[0]?.default_title ?? null });
        }
      }
    }
    appliedPeople += people;
    summary.push({ url, season: meta.season, engine, tuples: items.length, mappedPeople: people, unmappedCorps: unmapped });
    yield* Effect.logInfo(`  ${url.replace(DCI_ORIGIN, "")} [${meta.season}] → ${items.length} tuples, ${people} mapped, ${unmapped} unmapped-corps`);
  }
  yield* Effect.logInfo(`${apply ? "Applied" : "Dry-run"}: ${appliedPeople} roundup people across ${summary.length} roundups.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(SDK_DIR, "results", "staff-announcement");
  yield* Effect.sync(() => { mkdirSync(outDir, { recursive: true }); writeFileSync(resolve(outDir, `dci-roundup-${stamp}.json`), JSON.stringify({ scrapedAt: stamp, roundups: summary }, null, 2)); });
  closeOpencode();
});

const MEDIA_CACHE_URL = process.env.MEDIA_CACHE_DB_URL ?? `file:${resolve(SDK_DIR, "media-cache.db")}`;
const SqlLayer = LibsqlClient.layer({ url: DB_URL });
const MediaLayer = makeMediaServiceLayer({ cacheDbUrl: MEDIA_CACHE_URL }).pipe(Layer.provide(SqlLayer));
const AppLayer = Layer.mergeAll(SqlLayer, BrowserbaseServiceLive, MediaLayer);
Effect.runPromise(program.pipe(Effect.provide(AppLayer))).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
