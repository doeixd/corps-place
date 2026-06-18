// DCI Yearbook staff ingestion (docs/announcement-sources-plan.md / show-detail-wiki-plan.md).
//
// DCI's official season yearbooks (data/yearbook/*.pdf) are the AUTHORITATIVE source for a
// season's staff: each corps has a profile page printing its full roster under section headings,
// with the corps WEBSITE on the page (the exact join key to corps_key). 2013–2017 carry embedded
// text (no OCR); the 2019 export is image-only (vision path, not here).
//
// Pipeline: yearbook → profile pages → extractProfile (AI, de-spaces "Executive D irector") →
// map website→corps_key → coalesce into corps_staff. Because the yearbook is authoritative, its
// TITLE/CAPTION WINS over web/announcement values; bio/photo (which the yearbook lacks) are
// preserved. `--apply` writes; default dry-run. Resumable per (season).
//
// Usage (from sdk/):
//   npx tsx scripts/scrapeYearbooks.ts --seasons 2013-2017 --dry-run
//   npx tsx scripts/scrapeYearbooks.ts --season 2017 --apply
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve, basename } from "node:path";
import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { loadRepoEnv } from "./scriptEnv.js";
import { extractYearbook, hasEmbeddedText } from "../src/yearbook/yearbookText.js";
import { isProfilePage, isStaffRosterPage, extractProfile, extractShow } from "../src/yearbook/yearbookExtract.js";
import { buildCorpsResolver } from "../src/yearbook/mapCorps.js";
import { ensureYearbookProvenance, ingestYearbookSpread } from "../src/yearbook/ingest.js";
import { ensureStaffSchema, makeStaffPersonId, normalizeCaption, upsertStaffMember, type CorpsStaffMember } from "../src/relational.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const YB_DIR = resolve(SDK_DIR, "..", "public", "yearbook");

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const getOpt = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const apply = hasFlag("--apply");
const force = hasFlag("--force");
// Backfill ONLY the show/repertoire tables (skip the staff path entirely, preserving the
// consolidated person_ids). Re-extracts empty shows (those left 0-rep by the claude outage).
const showsOnly = hasFlag("--shows-only");
const limitPages = getOpt("--limit") ? Number(getOpt("--limit")) : undefined;
const CURRENT_SEASON = new Date().getFullYear();
const parseSeasons = (): number[] => {
  const one = getOpt("--season");
  if (one) return [Number(one)];
  const r = getOpt("--seasons")?.match(/^(\d{4})-(\d{4})$/);
  if (r) { const [a, b] = [Number(r[1]), Number(r[2])]; return Array.from({ length: b - a + 1 }, (_, i) => a + i); }
  return [2013, 2014, 2015, 2016, 2017];
};
const seasons = parseSeasons().filter((s) => s <= CURRENT_SEASON);
const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const TASK_TYPE = "staff-yearbook";

/** Yearbook files for a season: the ORIGINAL PDF and any OCR'd sidecar. We prefer the original —
 *  books with clean embedded text (2012-2017/2022/2023) parse BETTER from it; OCR adds noise and
 *  bloats pages (2013.ocr detected 7 profiles vs 12 in the original). The `.ocr.pdf` is only the
 *  fallback for image-only books (the 2019 flipbook). Skips `.partNNN` split files. */
const yearbookFiles = (season: number): { primary: string | null; ocr: string | null } => {
  if (!existsSync(YB_DIR)) return { primary: null, ocr: null };
  const pdfs = readdirSync(YB_DIR).filter((n) => n.toLowerCase().endsWith(".pdf") && n.includes(String(season))).sort();
  const ocr = pdfs.find((n) => /\.ocr\.pdf$/i.test(n));
  const orig = pdfs.find((n) => !/\.ocr\.pdf$/i.test(n));
  return { primary: orig ? resolve(YB_DIR, orig) : ocr ? resolve(YB_DIR, ocr) : null, ocr: ocr ? resolve(YB_DIR, ocr) : null };
};

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureStaffSchema;
  yield* sql`CREATE TABLE IF NOT EXISTS scraper_progress (task_type TEXT NOT NULL, season TEXT NOT NULL, corps_key TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT, PRIMARY KEY (task_type, season, corps_key))`.pipe(Effect.asVoid);

  // corps resolver (domain-primary) from a read-only raw client; writes go via Effect SqlClient.
  const rawDb = createClient({ url: DB_URL });
  const resolver = yield* Effect.promise(() => buildCorpsResolver(rawDb));
  if (apply) yield* Effect.promise(() => ensureYearbookProvenance(rawDb));

  const summary: any[] = [];
  for (const season of seasons) {
    const files = yearbookFiles(season);
    if (!files.primary) { yield* Effect.logInfo(`[${season}] no yearbook PDF — skip`); continue; }
    const isDone = !force && ((yield* sql<{ status: string }>`SELECT status FROM scraper_progress WHERE task_type=${TASK_TYPE} AND season=${String(season)} AND corps_key='all'`)[0]?.status === "done");
    if (isDone) { yield* Effect.logInfo(`[${season}] already done — skip (use --force)`); continue; }

    let pdf = files.primary;
    let extract = yield* Effect.promise(() => extractYearbook(pdf, String(season)));
    // Original is image-only (2019 flipbook) → use the OCR'd sidecar instead.
    if (!hasEmbeddedText(extract) && files.ocr && files.ocr !== pdf) {
      yield* Effect.logInfo(`[${season}] original image-only (${extract.textPages}/${extract.totalPages}) → using OCR sidecar`);
      pdf = files.ocr;
      extract = yield* Effect.promise(() => extractYearbook(pdf, String(season)));
    }
    if (!hasEmbeddedText(extract)) { yield* Effect.logInfo(`[${season}] image-only PDF (${extract.textPages}/${extract.totalPages} text) — needs vision, skip`); continue; }
    let profiles = extract.pages.filter(isStaffRosterPage);
    if (limitPages) profiles = profiles.slice(0, limitPages);
    yield* Effect.logInfo(`[${season}] ${basename(pdf)} — ${extract.textPages}/${extract.totalPages} text pages, ${profiles.length} corps profiles`);

    let corpsMatched = 0, people = 0, unmatched = 0, shows = 0, reps = 0;
    for (const page of profiles) {
      const { profile } = yield* Effect.promise(() => extractProfile(page.text));
      if (!profile || profile.staff.length === 0) continue;
      // Split-layout books (2013/2014): the roster page has no domain — it's on the facing
      // show page. Pull the website from the adjacent page (N-1 = show page, then N+1).
      let website = profile.website;
      if (!website) {
        for (const off of [-1, 1]) {
          const adj = extract.pages.find((pp) => pp.pageNumber === page.pageNumber + off);
          const d = adj?.text.match(/\b([a-z0-9][a-z0-9-]*\.(org|com|net))\b/i)?.[1]?.toLowerCase();
          if (d && !d.startsWith("dci.")) { website = d; break; }
        }
      }
      const match = resolver({ website, location: profile.location });
      if (!match) { unmatched++; yield* Effect.logInfo(`    unmatched: ${website ?? "?"} (${profile.location ?? "?"}, ${profile.staff.length} staff)`); continue; }
      corpsMatched++;
      const corpsKey = match.corpsKey;

      // Show page = the even page facing this staff page: title/concept/repertoire →
      // the SHOW tables (corps_shows/repertoire/designers) that feed the show-detail
      // page, with source='dci-yearbook', source_authority=100. Distinct from the
      // corps_staff person directory written below.
      const showPage = extract.pages.find((pp) => pp.pageNumber === page.pageNumber - 1);
      if (showPage && apply) {
        // Shows-only backfill: skip spreads whose show already has repertoire (don't waste AI).
        const already = showsOnly
          ? Number((yield* sql<{ c: number }>`SELECT count(*) c FROM corps_show_repertoire r JOIN corps_shows s ON s.show_id=r.show_id WHERE s.corps_key=${corpsKey} AND s.season=${String(season)}`)[0]?.c ?? 0)
          : 0;
        if (already === 0) {
          const { show } = yield* Effect.promise(() => extractShow(showPage.text));
          if (show) {
            const res = yield* Effect.promise(() =>
              ingestYearbookSpread(rawDb, {
                corpsKey, corpsName: null, season: String(season), show, profile,
                citation: `DCI ${season} Yearbook, p.${showPage.pageNumber}`,
              }),
            );
            shows++; reps += res.repertoire;
            yield* Effect.logInfo(`    show: "${show.showTitle ?? "?"}" (${res.repertoire} rep) → ${res.showId}`);
          }
        }
      }
      // Staff path — skipped in shows-only backfill (preserves the consolidated person_ids).
      for (const m of (showsOnly ? [] : profile.staff)) {
        const name = (m.name ?? "").trim();
        const pid = makeStaffPersonId(name);
        if (!pid || name.length < 3) continue;
        const title = (m.roles && m.roles.length ? m.roles.join(" / ") : m.section) ?? null;
        // Caption comes from the SECTION first (Brass→brass, Percussion→percussion); the role
        // ("Consultant", "Tech") is usually caption-agnostic and collapses to 'other'. Falling
        // back to the role only when the section yields nothing meaningful.
        const capFromSection = normalizeCaption(m.section);
        const roleType = capFromSection !== "other" ? capFromSection : normalizeCaption(m.roles?.[0] ?? title);
        const member: CorpsStaffMember = {
          staffId: `${corpsKey}:${pid}`, givenName: null, familyName: null, displayName: name,
          defaultTitle: title, biography: null, photoUrl: null, externalLinks: [], affiliations: [],
          assignments: [{ assignmentId: null, corpsKey, corpsName: match.corpsKey, season: String(season), title, roleType, startYear: season, endYear: season, startDate: `${season}-08-01`, endDate: null, notes: "yearbook/authoritative", links: [{ label: "yearbook", url: `dci-yearbook-${season}`, kind: "yearbook" }] }],
          metadata: { source: "yearbook", authoritative: true, yearbookFile: basename(pdf) },
        };
        people++;
        if (apply) {
          // Authoritative: yearbook TITLE wins; bio/photo preserved from prior sources.
          const ex = yield* sql<{ biography: string | null; photo_url: string | null; given_name: string | null; family_name: string | null }>`SELECT biography, photo_url, given_name, family_name FROM corps_staff WHERE staff_id=${member.staffId}`;
          yield* upsertStaffMember(sql, { ...member, biography: ex[0]?.biography ?? null, photoUrl: ex[0]?.photo_url ?? null, givenName: ex[0]?.given_name ?? null, familyName: ex[0]?.family_name ?? null });
        }
      }
    }
    if (apply) yield* sql`INSERT INTO scraper_progress (task_type, season, corps_key, status, updated_at, payload) VALUES (${TASK_TYPE}, ${String(season)}, 'all', 'done', ${new Date().toISOString()}, ${JSON.stringify({ corpsMatched, people, unmatched })}) ON CONFLICT(task_type, season, corps_key) DO UPDATE SET status='done', updated_at=excluded.updated_at, payload=excluded.payload`.pipe(Effect.asVoid);
    summary.push({ season, profiles: profiles.length, corpsMatched, unmatched, people });
    yield* Effect.logInfo(`[${season}] → ${corpsMatched} corps matched, ${unmatched} unmatched, ${people} staff rows`);
  }
  yield* Effect.logInfo(`${apply ? "Applied" : "Dry-run"}: ${summary.reduce((a, s) => a + s.people, 0)} authoritative yearbook staff across ${summary.length} seasons.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(SDK_DIR, "results", "staff-yearbook");
  yield* Effect.sync(() => { mkdirSync(outDir, { recursive: true }); writeFileSync(resolve(outDir, `yearbook-${stamp}.json`), JSON.stringify({ scrapedAt: stamp, seasons: summary }, null, 2)); });
});

const SqlLayer = LibsqlClient.layer({ url: DB_URL });
Effect.runPromise(program.pipe(Effect.provide(SqlLayer))).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
