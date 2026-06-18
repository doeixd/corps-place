// Stage 2 of the event-slug migration: dedupe duplicate event rows.
// See docs/data-integrity-slugs-lineups-aliases.md.
//
// For each plan row action='dedupe' (dupe event_id → survivor event_id, validated
// same name+date), the survivor is the canonical keeper. This stage:
//   - preserves a venue: if the survivor has no event_venues row but the dupe
//     does, move the dupe's venue to the survivor;
//   - deletes the dupe's event_id-keyed children (event_venues, event_schedules);
//   - deletes the dupe's events row.
// Slug-only child rows are intentionally NOT moved: where the dupe shared the
// survivor's slug they already associate with the survivor once the dupe is gone;
// where the dupe's slug was a (now-orphaned) bare slug, those rows are ambiguous
// and get discarded+rebuilt in Stage 3. FK cascade is off, so children are
// removed explicitly.
//
// Guards fail closed: every survivor must exist and must not itself be a dupe.
//
// Usage (from sdk/):
//   npx tsx scripts/migrateEventSlugsStage2.ts            # dry run
//   npx tsx scripts/migrateEventSlugsStage2.ts --apply

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const apply = process.argv.includes('--apply');
const db = createClient({ url: `file:${path.resolve(process.cwd(), 'dci-relational.db')}` });

async function main() {
  const plan = JSON.parse(readFileSync(path.resolve(process.cwd(), 'event-migration-plan.json'), 'utf8'));
  const dupes = (plan.rows as any[]).filter((r) => r.action === 'dedupe') as Array<{
    event_id: string;
    slug: string;
    canonical: string;
    survivorEventId: string;
  }>;

  // --- Guards ---
  const allIds = new Set((await db.execute(`SELECT event_id FROM events`)).rows.map((r) => String(r.event_id)));
  const slugById = new Map(
    (await db.execute(`SELECT event_id, slug FROM events`)).rows.map((r: any) => [String(r.event_id), String(r.slug)])
  );
  const dupeIds = new Set(dupes.map((d) => d.event_id));
  for (const d of dupes) {
    if (!d.survivorEventId) throw new Error(`dedupe row ${d.event_id} has no survivor`);
    if (!allIds.has(d.event_id)) throw new Error(`dupe ${d.event_id} not in events (already gone?)`);
    if (!allIds.has(d.survivorEventId)) throw new Error(`survivor ${d.survivorEventId} missing`);
    if (d.survivorEventId === d.event_id) throw new Error(`dupe == survivor ${d.event_id}`);
    if (dupeIds.has(d.survivorEventId)) throw new Error(`survivor ${d.survivorEventId} is itself a dupe`);
  }

  // --- Venue preservation: which survivors lack a venue the dupe could supply ---
  const hasVenue = new Set(
    (await db.execute(`SELECT DISTINCT event_id FROM event_venues`)).rows.map((r) => String(r.event_id))
  );
  let venueMoves = 0;
  let venueDeletes = 0;
  let scheduleDeletes = 0;
  const ops: { sql: string; args: any[] }[] = [];
  for (const d of dupes) {
    const survivorHasVenue = hasVenue.has(d.survivorEventId);
    const dupeHasVenue = hasVenue.has(d.event_id);
    if (!survivorHasVenue && dupeHasVenue) {
      ops.push({
        sql: `UPDATE event_venues SET event_id = ?, event_slug = ? WHERE event_id = ?`,
        args: [d.survivorEventId, slugById.get(d.survivorEventId), d.event_id],
      });
      hasVenue.add(d.survivorEventId); // a later dupe in the same group won't double-move
      venueMoves++;
    } else if (dupeHasVenue) {
      ops.push({ sql: `DELETE FROM event_venues WHERE event_id = ?`, args: [d.event_id] });
      venueDeletes++;
    }
    ops.push({ sql: `DELETE FROM event_schedules WHERE event_id = ?`, args: [d.event_id] });
    scheduleDeletes++;
    ops.push({ sql: `DELETE FROM events WHERE event_id = ?`, args: [d.event_id] });
  }

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — Stage 2: dedupe duplicate event rows`);
  console.log(`  dupe events to delete: ${dupes.length}`);
  console.log(`  venues moved to survivor (survivor had none): ${venueMoves}`);
  console.log(`  dupe venues deleted: ${venueDeletes}`);
  console.log(`  dupe schedule-row deletes issued for: ${scheduleDeletes} events`);
  console.log('\n  sample merges (dupe → survivor):');
  for (const d of dupes.slice(0, 8))
    console.log(`    ${d.event_id.slice(0, 12)} (${slugById.get(d.event_id)})  →  ${d.survivorEventId.slice(0, 12)} (${d.canonical})`);

  if (!apply) {
    console.log(`\n  (dry run — pass --apply; ${ops.length} statements in one transaction; backup exists)`);
    return;
  }

  const before = Number((await db.execute(`SELECT COUNT(*) n FROM events`)).rows[0].n);
  await db.batch(ops, 'write');
  const after = Number((await db.execute(`SELECT COUNT(*) n FROM events`)).rows[0].n);
  console.log(`\n  applied. events ${before} → ${after} (expected −${dupes.length} = ${before - dupes.length})`);
  if (after !== before - dupes.length) console.log('  ⚠️  unexpected delta — investigate.');
}

main()
  .then(() => db.close())
  .catch((e) => {
    console.error('stage2 failed:', e);
    db.close();
    process.exit(1);
  });
