// Fix the "encore duplicate" class of lineup bug.
//
// Root cause: an early version of the event-page scraper parsed an encore /
// exhibition / video-presentation row as its bare corps/segment name (e.g.
// "Carolina Crown", isNonPerformance:false) instead of the prefixed form
// ("Encore - Carolina Crown", isNonPerformance:true). The parser was later
// fixed, so the LATEST archived scrape (event_page_scrapes.lineup_json) is
// correct. But event_lineup_entries rows are keyed by
// `${slug}-${normalizeKey(name)}-${index}`, and the non-overwrite ingest path
// never deletes — so the corrected scrape's "Encore - X" row was inserted
// ALONGSIDE the stale bare-name "X" row at the same performance_order. Result:
// the corps shows up twice at the encore time slot.
//
// This script treats the latest scrape as the source of truth: for every event
// it flags lineup rows whose (performance_order, normalized unit_name) does NOT
// appear in the latest scrape's lineup_json, and deletes those orphans. It then
// repairs event_participants.performance_order for any affected performing corps
// (the stale row had pushed it to the encore slot) by re-deriving it from the
// surviving performing lineup entry.
//
// Dry-run by default; pass --apply to write.
//
// Usage:
//   npx tsx scripts/fixEncoreDuplicateLineups.ts            # dry-run, all events
//   npx tsx scripts/fixEncoreDuplicateLineups.ts --slug 2023-dci-central-indiana
//   npx tsx scripts/fixEncoreDuplicateLineups.ts --apply

import { createClient } from "@libsql/client";

const apply = process.argv.includes("--apply");
const argValue = (name: string) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const slugFilter = argValue("slug");

const norm = (s: string | null | undefined) =>
  (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const db = createClient({ url: "file:./dci-relational.db" });

type LineupRow = {
  entry_id: string;
  event_slug: string;
  participant_id: string | null;
  performance_order: number | null;
  unit_name: string;
  is_non_performance: number;
};

const main = async () => {
  // Events that have a performance_order collision (two rows at one slot) — the
  // only place this bug can manifest. Narrow up front so we never touch events
  // whose derived rows already match their latest scrape.
  const collisionEvents = await db.execute({
    sql: `SELECT DISTINCT event_slug FROM event_lineup_entries
          WHERE performance_order IS NOT NULL
            AND (? IS NULL OR event_slug = ?)
          GROUP BY event_slug, performance_order HAVING COUNT(*) > 1`,
    args: [slugFilter ?? null, slugFilter ?? null],
  });
  const events = [...new Set(collisionEvents.rows.map((r) => String(r.event_slug)))].sort();

  const orphans: LineupRow[] = [];
  const noScrape: string[] = [];

  for (const ev of events) {
    const scrapeRow = await db.execute({
      sql: `SELECT lineup_json FROM event_page_scrapes
            WHERE event_slug = ? AND lineup_json IS NOT NULL
            ORDER BY scraped_at DESC LIMIT 1`,
      args: [ev],
    });
    if (scrapeRow.rows.length === 0) {
      noScrape.push(ev);
      continue;
    }
    const parsed = JSON.parse(String(scrapeRow.rows[0].lineup_json));
    const arr: Array<{ order?: number; corpsName?: string }> = Array.isArray(parsed)
      ? parsed
      : parsed?.lineup ?? [];
    const scrapeSet = new Set(arr.map((e) => `${e.order}|${norm(e.corpsName)}`));

    const dbRows = await db.execute({
      sql: `SELECT entry_id, event_slug, participant_id, performance_order, unit_name, is_non_performance
            FROM event_lineup_entries WHERE event_slug = ?`,
      args: [ev],
    });
    for (const r of dbRows.rows as unknown as LineupRow[]) {
      if (!scrapeSet.has(`${r.performance_order}|${norm(r.unit_name)}`)) {
        orphans.push(r);
      }
    }
  }

  console.log(`${apply ? "APPLY" : "DRY RUN"} — encore duplicate lineup fix`);
  if (slugFilter) console.log(`  slug filter: ${slugFilter}`);
  console.log(`  collision events scanned: ${events.length}`);
  if (noScrape.length) console.log(`  events WITHOUT a scrape (skipped): ${noScrape.join(", ")}`);
  console.log(`  orphan rows to delete: ${orphans.length}`);
  for (const o of orphans) {
    console.log(`    - ${o.entry_id}  (order ${o.performance_order}, np=${o.is_non_performance})`);
  }

  if (!apply) {
    console.log("\n  (dry run — pass --apply to write)");
    return;
  }

  let deleted = 0;
  let participantsFixed = 0;
  for (const o of orphans) {
    await db.execute({
      sql: `DELETE FROM event_lineup_entries WHERE entry_id = ?`,
      args: [o.entry_id],
    });
    deleted++;
    // Repair a performing corps whose participant order was pinned to the stale
    // encore slot: re-derive from its surviving performing lineup entry.
    if (o.is_non_performance === 0 && o.participant_id) {
      const survivor = await db.execute({
        sql: `SELECT MIN(performance_order) AS po FROM event_lineup_entries
              WHERE event_slug = ? AND participant_id = ? AND is_non_performance = 0`,
        args: [o.event_slug, o.participant_id],
      });
      const po = survivor.rows[0]?.po;
      if (po != null) {
        const res = await db.execute({
          sql: `UPDATE event_participants SET performance_order = ?
                WHERE event_slug = ? AND participant_id = ? AND performance_order = ?`,
          args: [po, o.event_slug, o.participant_id, o.performance_order],
        });
        participantsFixed += res.rowsAffected;
      }
    }
  }

  console.log(`\n  deleted lineup rows: ${deleted}`);
  console.log(`  participant orders repaired: ${participantsFixed}`);
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fixEncoreDuplicateLineups failed:", e);
    process.exit(1);
  });
