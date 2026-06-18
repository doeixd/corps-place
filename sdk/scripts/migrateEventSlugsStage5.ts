// Stage 5: uniquify the remaining edge-case event slugs (multi-day events sharing
// a slug, and bare slugs that still collide). See docs/data-integrity-...md.
//
// Each event gets a unique season-prefixed slug `{season}-{base}` with a `-N`
// suffix (date-ordered: earliest keeps the base, later days get -2, -3, …). This
// is deterministic and slug-independent, which is required because
// event_to_competition is keyed by slug and was returning one shared (wrong)
// mapping for every event under a reused bare slug. After this, re-run the
// season-safe matcher (date+name, not slug) to get correct per-event mappings,
// then derive lineups.
//
// Renames the events row (by event_id) + event_venues (by event_id). No deletes.
//
// Usage (from sdk/):
//   npx tsx scripts/migrateEventSlugsStage5.ts            # dry run
//   npx tsx scripts/migrateEventSlugsStage5.ts --apply
//   then: backfillEventCompetitionMapping.ts --apply  +  deriveLineupsFromScores.ts --apply

import path from 'node:path';
import { createClient } from '@libsql/client';

const apply = process.argv.includes('--apply');
const db = createClient({ url: `file:${path.resolve(process.cwd(), 'dci-relational.db')}` });
const isPrefixed = (s: string) => /^\d{4}-/.test(s);

async function main() {
  const events = (
    await db.execute(
      `SELECT event_id, slug, season, year, start_date FROM events ORDER BY start_date, event_id`
    )
  ).rows as unknown as Array<{ event_id: string; slug: string; season: string | null; year: string | null; start_date: string | null }>;

  const slugCount = new Map<string, number>();
  for (const e of events) slugCount.set(e.slug, (slugCount.get(e.slug) ?? 0) + 1);
  const allSlugs = new Set(events.map((e) => e.slug));

  // Edge events = bare slug OR a slug shared by >1 event.
  const edge = events.filter((e) => !isPrefixed(e.slug) || (slugCount.get(e.slug) ?? 0) > 1);

  // Base prefixed slug for each edge event.
  const baseOf = (e: (typeof events)[number]) => {
    const season = e.season ?? e.year ?? ((e.start_date ?? '').slice(0, 4) || 'unknown');
    return isPrefixed(e.slug) ? e.slug : `${season}-${e.slug}`;
  };

  // Group by base, assign unique targets (date-ordered; first keeps base).
  const byBase = new Map<string, typeof events>();
  for (const e of edge) (byBase.get(baseOf(e)) ?? byBase.set(baseOf(e), []).get(baseOf(e))!).push(e);

  const taken = new Set(allSlugs); // start from all current slugs; we'll free edges as we assign
  // Free the edge slugs first so a base can be reused by its earliest member.
  for (const e of edge) taken.delete(e.slug);

  const renames: { event_id: string; from: string; to: string }[] = [];
  for (const [base, group] of byBase) {
    group.sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? '') || a.event_id.localeCompare(b.event_id));
    let n = 1;
    for (const e of group) {
      let target = n === 1 ? base : `${base}-${n}`;
      while (taken.has(target)) {
        n++;
        target = `${base}-${n}`;
      }
      taken.add(target);
      if (target !== e.slug) renames.push({ event_id: e.event_id, from: e.slug, to: target });
      n++;
    }
  }

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — Stage 5: uniquify edge-case slugs`);
  console.log(`  edge events: ${edge.length} | renames: ${renames.length}`);
  for (const r of renames) console.log(`    ${r.from}  ->  ${r.to}`);

  if (!apply) {
    console.log('\n  (dry run — pass --apply; then re-run matcher + deriveLineupsFromScores)');
    return;
  }
  const ops = [];
  for (const r of renames) {
    ops.push({ sql: `UPDATE events SET slug = ? WHERE event_id = ?`, args: [r.to, r.event_id] });
    ops.push({ sql: `UPDATE event_venues SET event_slug = ? WHERE event_id = ?`, args: [r.to, r.event_id] });
  }
  await db.batch(ops, 'write');
  const remainingNonUnique = Number(
    (await db.execute(`SELECT COUNT(*) n FROM (SELECT slug FROM events GROUP BY slug HAVING COUNT(*)>1)`)).rows[0].n
  );
  const remainingBare = Number(
    (await db.execute(`SELECT COUNT(*) n FROM events WHERE slug NOT GLOB '[0-9][0-9][0-9][0-9]-*'`)).rows[0].n
  );
  console.log(`\n  applied ${renames.length} renames. non-unique slugs now: ${remainingNonUnique} | bare slugs now: ${remainingBare}`);
}

main()
  .then(() => db.close())
  .catch((e) => {
    console.error('stage5 failed:', e);
    db.close();
    process.exit(1);
  });
