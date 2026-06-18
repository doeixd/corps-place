// Stage 3 (parts a+b) of the event-slug migration: reconcile the derived lineup
// tables to the post-rename event slugs. See docs/data-integrity-...md.
//
//  3a. Re-key orphaned event_page_scrapes (event_slug no longer a real event) to
//      the prefixed slug parsed from their source_url — but ONLY when that target
//      is a current event. This preserves real scraped lineup data that was
//      stranded under an old bare slug. Authoritative (source_url = the DCI URL),
//      so it disambiguates even formerly-reused slugs.
//  3b. Delete orphaned event_lineup_entries / event_participants (event_slug not a
//      current event). These are legacy, provenance-less (source_url NULL),
//      ambiguous derived rows — rebuilt next by ingestLineupsFromScrapes (3c) and
//      deriveLineupsFromScores (3d).
//
// Dry-run by default. After --apply, run:  ingestLineupsFromScrapes.ts  then
// deriveLineupsFromScores.ts --apply.
//
// Usage (from sdk/):  npx tsx scripts/migrateEventSlugsStage3.ts [--apply]

import path from 'node:path';
import { createClient } from '@libsql/client';

const apply = process.argv.includes('--apply');
const db = createClient({ url: `file:${path.resolve(process.cwd(), 'dci-relational.db')}` });
const prefixedFromUrl = (url: string | null) => url?.match(/\/events\/(\d{4}-[a-z0-9-]+)/i)?.[1] ?? null;

async function main() {
  const events = new Set((await db.execute(`SELECT slug FROM events`)).rows.map((r) => String(r.slug)));

  // --- 3a: orphan scrapes re-keyable via source_url ---
  const orphanScrapes = (
    await db.execute(
      `SELECT event_slug, scraped_at, source_url,
              (lineup_json IS NOT NULL AND json_array_length(lineup_json) > 0) AS has_lineup
       FROM event_page_scrapes WHERE event_slug NOT IN (SELECT slug FROM events)`
    )
  ).rows as unknown as Array<{ event_slug: string; scraped_at: string; source_url: string | null; has_lineup: number }>;

  const rekeys: { from: string; at: string; to: string }[] = [];
  let strandedNoTarget = 0;
  let strandedWithLineup = 0;
  for (const s of orphanScrapes) {
    const target = prefixedFromUrl(s.source_url);
    if (target && events.has(target)) rekeys.push({ from: s.event_slug, at: s.scraped_at, to: target });
    else {
      strandedNoTarget++;
      if (s.has_lineup) strandedWithLineup++;
    }
  }
  const rekeyWithLineup = orphanScrapes.filter(
    (s) => s.has_lineup && events.has(prefixedFromUrl(s.source_url) ?? '')
  ).length;

  // --- 3b: orphan derived rows to delete ---
  const orphanLineup = Number(
    (await db.execute(`SELECT COUNT(*) n FROM event_lineup_entries WHERE event_slug NOT IN (SELECT slug FROM events)`)).rows[0].n
  );
  const orphanParticipants = Number(
    (await db.execute(`SELECT COUNT(*) n FROM event_participants WHERE event_slug NOT IN (SELECT slug FROM events)`)).rows[0].n
  );

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — Stage 3a/3b: reconcile derived lineup tables`);
  console.log(`  3a. orphan scrapes: ${orphanScrapes.length}`);
  console.log(`      re-key to a real event via source_url: ${rekeys.length} (with lineup: ${rekeyWithLineup})`);
  console.log(`      stranded (no usable target): ${strandedNoTarget} (with lineup: ${strandedWithLineup})`);
  console.log(`  3b. orphan lineup rows to delete: ${orphanLineup}`);
  console.log(`      orphan participant rows to delete: ${orphanParticipants}`);

  if (!apply) {
    console.log('\n  (dry run — pass --apply; then run ingestLineupsFromScrapes.ts + deriveLineupsFromScores.ts --apply)');
    return;
  }

  const ops: { sql: string; args: any[] }[] = [];
  for (const r of rekeys)
    ops.push({
      // OR IGNORE: skip if a scrape already exists at (target, scraped_at) — keep the existing.
      sql: `UPDATE OR IGNORE event_page_scrapes SET event_slug = ? WHERE event_slug = ? AND scraped_at = ?`,
      args: [r.to, r.from, r.at],
    });
  ops.push({ sql: `DELETE FROM event_lineup_entries WHERE event_slug NOT IN (SELECT slug FROM events)`, args: [] });
  ops.push({ sql: `DELETE FROM event_participants WHERE event_slug NOT IN (SELECT slug FROM events)`, args: [] });
  await db.batch(ops, 'write');

  const remOrphanLineup = Number(
    (await db.execute(`SELECT COUNT(*) n FROM event_lineup_entries WHERE event_slug NOT IN (SELECT slug FROM events)`)).rows[0].n
  );
  const eventsWithScrape = Number(
    (await db.execute(`SELECT COUNT(DISTINCT s.event_slug) n FROM event_page_scrapes s JOIN events e ON e.slug=s.event_slug WHERE s.lineup_json IS NOT NULL AND json_array_length(s.lineup_json)>0`)).rows[0].n
  );
  console.log(`\n  applied. re-keyed ${rekeys.length} scrapes; orphan lineup rows now ${remOrphanLineup} (expect 0).`);
  console.log(`  events with a matching nonempty scrape now: ${eventsWithScrape}`);
  console.log('  NEXT: npx tsx scripts/ingestLineupsFromScrapes.ts   then   npx tsx scripts/deriveLineupsFromScores.ts --apply');
}

main()
  .then(() => db.close())
  .catch((e) => {
    console.error('stage3 failed:', e);
    db.close();
    process.exit(1);
  });
