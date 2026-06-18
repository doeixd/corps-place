// Stage 1 of the event-slug migration: rename bare event slugs to their unique
// season-prefixed canonical. See docs/data-integrity-slugs-lineups-aliases.md.
//
// SCOPE (deliberately minimal & low-risk): only the `events` row (by event_id)
// and the event_id-keyed `event_venues.event_slug`. NO slug-keyed child moves,
// NO deletes. The dry-run REPORTS the deferred child-row impact (which moves in
// Stage 2 for unique slugs, which is discarded+rebuilt in Stage 3 for reused/
// ambiguous slugs) so nothing is hidden.
//
// Driven by event-migration-plan.json (action='rename' rows). Pre-apply guards
// assert the rename set is collision-free before touching anything.
//
// Usage (from sdk/):
//   npx tsx scripts/migrateEventSlugsStage1.ts            # dry run
//   npx tsx scripts/migrateEventSlugsStage1.ts --apply

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const apply = process.argv.includes('--apply');
const db = createClient({ url: `file:${path.resolve(process.cwd(), 'dci-relational.db')}` });

const SLUG_ONLY_CHILD = [
  'event_lineup_entries',
  'event_participants',
  'event_page_scrapes',
  'event_group_types',
  'event_wayback_availability',
  'event_to_competition',
] as const;

async function main() {
  const plan = JSON.parse(readFileSync(path.resolve(process.cwd(), 'event-migration-plan.json'), 'utf8'));
  const renames = (plan.rows as any[]).filter((r) => r.action === 'rename') as Array<{
    event_id: string;
    slug: string;
    canonical: string;
  }>;

  // --- Pre-apply guards (fail closed) ---
  const targets = renames.map((r) => r.canonical);
  const dupTargets = targets.filter((t, i) => targets.indexOf(t) !== i);
  if (dupTargets.length) throw new Error(`rename targets not unique: ${[...new Set(dupTargets)].slice(0, 5)}`);
  // No target may already be in use by an event that is NOT being renamed to it.
  const existing = new Set(
    (await db.execute(`SELECT slug FROM events`)).rows.map((r) => String(r.slug))
  );
  const renamingFrom = new Set(renames.map((r) => `${r.event_id}`));
  const idBySlug = new Map<string, string[]>();
  for (const r of (await db.execute(`SELECT event_id, slug FROM events`)).rows as any[]) {
    (idBySlug.get(r.slug) ?? idBySlug.set(r.slug, []).get(r.slug)!).push(r.event_id);
  }
  for (const r of renames) {
    const holders = idBySlug.get(r.canonical) ?? [];
    const conflict = holders.filter((id) => id !== r.event_id && !renamingFrom.has(id));
    if (conflict.length) throw new Error(`target ${r.canonical} already held by event ${conflict[0]}`);
  }

  // --- Uniqueness of each source slug (drives Stage-2/3 routing of child rows) ---
  const slugCount = new Map<string, number>();
  for (const r of (await db.execute(`SELECT slug, COUNT(*) n FROM events GROUP BY slug`)).rows as any[])
    slugCount.set(String(r.slug), Number(r.n));

  // --- Deferred child-row impact report (read-only counts) ---
  const childImpact: Record<string, { onUnique: number; onReused: number }> = {};
  for (const t of SLUG_ONLY_CHILD) {
    const uniqueSlugs = renames.filter((r) => (slugCount.get(r.slug) ?? 0) === 1).map((r) => r.slug);
    const reusedSlugs = renames.filter((r) => (slugCount.get(r.slug) ?? 0) > 1).map((r) => r.slug);
    const countFor = async (slugs: string[]) => {
      if (slugs.length === 0) return 0;
      let total = 0;
      for (let i = 0; i < slugs.length; i += 400) {
        const chunk = slugs.slice(i, i + 400);
        const ph = chunk.map(() => '?').join(',');
        const r = await db.execute({ sql: `SELECT COUNT(*) n FROM ${t} WHERE event_slug IN (${ph})`, args: chunk });
        total += Number((r.rows[0] as any).n);
      }
      return total;
    };
    childImpact[t] = { onUnique: await countFor(uniqueSlugs), onReused: await countFor(reusedSlugs) };
  }

  const venueRows = renames.length
    ? Number(
        (
          await (async () => {
            const ids = renames.map((r) => r.event_id);
            let total = 0;
            for (let i = 0; i < ids.length; i += 400) {
              const chunk = ids.slice(i, i + 400);
              const ph = chunk.map(() => '?').join(',');
              const r = await db.execute({ sql: `SELECT COUNT(*) n FROM event_venues WHERE event_id IN (${ph})`, args: chunk });
              total += Number((r.rows[0] as any).n);
            }
            return { rows: [{ n: total }] };
          })()
        ).rows[0].n
      )
    : 0;

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — Stage 1: rename event slugs (by event_id)`);
  console.log(`  events to rename: ${renames.length}`);
  console.log(`  event_venues rows re-keyed (by event_id): ${venueRows}`);
  console.log('\n  DEFERRED slug-only child rows (NOT touched in Stage 1):');
  for (const t of SLUG_ONLY_CHILD)
    console.log(
      `    ${t}: ${childImpact[t].onUnique} on unique slugs (→ Stage 2 move) | ${childImpact[t].onReused} on reused slugs (→ Stage 3 discard+rebuild)`
    );
  console.log('\n  sample renames:');
  for (const r of renames.slice(0, 8)) console.log(`    ${r.slug}  →  ${r.canonical}`);

  if (!apply) {
    console.log('\n  (dry run — pass --apply to write; backup exists; only events+event_venues change)');
    return;
  }

  const batch = [];
  for (const r of renames) {
    batch.push({ sql: `UPDATE events SET slug = ? WHERE event_id = ?`, args: [r.canonical, r.event_id] });
    batch.push({ sql: `UPDATE event_venues SET event_slug = ? WHERE event_id = ?`, args: [r.canonical, r.event_id] });
  }
  await db.batch(batch, 'write'); // single transaction
  const stillBare = Number(
    (await db.execute(`SELECT COUNT(*) n FROM events WHERE slug NOT GLOB '[0-9][0-9][0-9][0-9]-*'`)).rows[0].n
  );
  console.log(`\n  applied. events still bare-slug (expect dedupe+review remainder): ${stillBare}`);
}

main()
  .then(() => db.close())
  .catch((e) => {
    console.error('stage1 failed:', e);
    db.close();
    process.exit(1);
  });
