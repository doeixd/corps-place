// Backfill event records for PAST-SEASON shows that have scores but no event row.
//
// Why this exists: events are normally ingested from the DCI website schedule
// (ingestEventsFromWebsite.ts), which is only correct for the CURRENT season — its
// slug is scraped from the live /events/<slug>/ URL, and for recurring shows DCI
// repoints that URL to the latest edition. So re-scraping a finished season yields
// next-year slugs (e.g. a 2025 show comes back as "2026-march-on") that never match
// the season's competition slug. The authoritative source for a past season's
// events is the `competitions` table (DCI API): stable "<season>-<slug>" slugs +
// dates. This is also how 2022–2024 synthetic events already exist (event_id=slug).
//
// We create one event per competition that (a) is in the requested season(s),
// (b) has corps_scores, and (c) has no matching events row — plus an identity
// event_to_competition row so recaps resolve. Idempotent: only fills gaps.
//
// Usage (from sdk/):
//   npx tsx scripts/backfillEventsFromCompetitions.ts --season 2025          # dry run
//   npx tsx scripts/backfillEventsFromCompetitions.ts --season 2025 --apply
//   npx tsx scripts/backfillEventsFromCompetitions.ts --all --apply          # every season

import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const all = args.includes("--all");
const seasonArg = (() => {
  const i = args.indexOf("--season");
  return i >= 0 ? args[i + 1] : undefined;
})();

const DB_URL =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${resolve(SDK_DIR, "dci-relational.db")}`;

async function main() {
  if (!all && !seasonArg) {
    console.error("Pass --season <YYYY> or --all");
    process.exitCode = 1;
    return;
  }
  const db = createClient({ url: DB_URL });
  const seasonFilter = all ? "" : "AND c.season = ?";
  const seasonArgs = all ? [] : [seasonArg!];

  const { rows: gaps } = await db.execute({
    sql: `SELECT c.slug, c.event_name, c.date, c.season, c.location
            FROM competitions c
           WHERE c.slug IN (SELECT DISTINCT competition_slug FROM corps_scores)
             -- A competition is already covered if an event shares its slug OR a
             -- (website) event maps to it via event_to_competition. Skipping the
             -- mapping check creates duplicate events (e.g. a website event
             -- "…-southwestern-championship" already maps to the API's "…-2").
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.slug = c.slug)
             AND NOT EXISTS (SELECT 1 FROM event_to_competition m WHERE m.competition_slug = c.slug)
             -- Skip punctuation/spelling variants of an event that already exists
             -- (same day + same slug ignoring hyphens): "…-us-army-bands" vs
             -- "…-u-s-army-bands", "…-dcidca-…" vs "…-dci-dca-…", "brigadier-s" vs
             -- "brigadiers". The genuine two-night siblings ("…-eastern-classic"
             -- vs "…-eastern-classic-2") survive — different day AND the "-2" makes
             -- the normalized slugs differ.
             AND NOT EXISTS (
               SELECT 1 FROM events e
               WHERE substr(e.start_date, 1, 10) = substr(c.date, 1, 10)
                 AND replace(lower(e.slug), '-', '') = replace(lower(c.slug), '-', '')
             )
             ${seasonFilter}
           ORDER BY c.date`,
    args: seasonArgs,
  });

  console.log(
    `${gaps.length} scored competition(s) without an event record${all ? "" : ` in ${seasonArg}`}.`,
  );
  for (const g of gaps) console.log(`  ${g.slug}  (${g.event_name})`);
  if (gaps.length === 0) return;

  if (!apply) {
    console.log("\nDRY RUN — pass --apply to create these events + identity mappings.");
    return;
  }

  for (const g of gaps) {
    const slug = String(g.slug);
    // "City, ST" → city + state (correct per-season; from the API, not a stale
    // prior-year scrape).
    const loc = String(g.location ?? "");
    const ci = loc.indexOf(",");
    const city = ci >= 0 ? loc.slice(0, ci).trim() : loc.trim();
    const state = ci >= 0 ? loc.slice(ci + 1).trim() : "";
    await db.execute({
      sql: `INSERT INTO events (event_id, name, event_name, slug, season, year, start_date, location_city, location_state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [slug, g.event_name, g.event_name, slug, g.season, g.season, g.date, city, state],
    });
    await db.execute({
      sql: `INSERT OR IGNORE INTO event_to_competition (event_slug, competition_slug, match_method)
            VALUES (?, ?, 'exact-slug')`,
      args: [slug, slug],
    });
  }
  console.log(`\nCreated ${gaps.length} event(s) + identity mappings. Re-emit the read-model to publish.`);
}

main().catch((err) => {
  console.error("backfillEventsFromCompetitions failed:", err);
  process.exitCode = 1;
});
