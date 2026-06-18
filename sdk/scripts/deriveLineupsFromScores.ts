// Derive a performing lineup from cached competition scores for events that have
// no scraped lineup. See sdk/docs/data-integrity-slugs-lineups-aliases.md (Phase 4).
//
// Source of truth: corps_scores (per-competition per-corps name, division/class,
// rank, total_score), reached from the event via event_to_competition. This is
// already-ingested, Cloudflare-free cache — no scraping.
//
// Additive & coalescing: only touches events with ZERO event_lineup_entries.
// Writes both event_lineup_entries AND event_participants (the schedule resolves
// class + logo through participants). Every row is tagged
// source_url='derived:corps_scores' so it is fully reversible:
//   DELETE FROM event_lineup_entries WHERE source_url='derived:corps_scores';
//   DELETE FROM event_participants    WHERE participant_slug='derived:corps_scores';
//
// Performing corps only (total_score>0 — excludes DNS/exhibition placeholders).
// No times/ceremonies/exhibition rows (those exist only on scraped lineup pages).
// Performance order is approximate: ascending total_score (lowest performs first,
// the usual DCI running order).
//
// Usage (from sdk/):
//   npx tsx scripts/deriveLineupsFromScores.ts            # dry run
//   npx tsx scripts/deriveLineupsFromScores.ts --slug 2016-dci-minnesota
//   npx tsx scripts/deriveLineupsFromScores.ts --apply

import path from 'node:path';
import { createClient } from '@libsql/client';

const DERIVED_TAG = 'derived:corps_scores';
const apply = process.argv.includes('--apply');
const slugArg = (() => {
  const i = process.argv.indexOf('--slug');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

const db = createClient({ url: `file:${path.resolve(process.cwd(), 'dci-relational.db')}` });

type ScoreRow = {
  corps_key: string;
  corps_name: string;
  division_name: string | null;
  rank: number | null;
  total_score: number | null;
};

async function main() {
  // Events lacking any lineup row. (Optionally restricted to one slug.)
  const events = (
    await db.execute({
      sql: `SELECT e.slug, e.season, e.year, e.start_date
            FROM events e
            WHERE NOT EXISTS (SELECT 1 FROM event_lineup_entries l WHERE l.event_slug = e.slug)
              AND (? IS NULL OR e.slug = ?)`,
      args: [slugArg ?? null, slugArg ?? null],
    })
  ).rows as unknown as Array<{ slug: string; season: string | null; year: string | null; start_date: string | null }>;

  // events.slug is NOT unique (PK is event_id; bare slugs repeat across seasons).
  // Keying derived rows by an ambiguous slug would attach one season's corps to
  // every event sharing that slug. Only operate on unambiguous (unique) slugs —
  // i.e. prefixed slugs. Bare/reused slugs must be migrated to their unique
  // prefixed form first (see docs §CORRECTION).
  const ambiguousSlugs = new Set(
    (
      await db.execute(`SELECT slug FROM events GROUP BY slug HAVING COUNT(*) > 1`)
    ).rows.map((r) => String(r.slug))
  );

  let eventsWithLineup = 0;
  let totalRows = 0;
  let noRoster = 0;
  let skippedAmbiguous = 0;
  const samples: string[] = [];

  for (const e of events) {
    if (ambiguousSlugs.has(e.slug)) {
      skippedAmbiguous++;
      continue;
    }
    const season = e.season ?? e.year ?? ((e.start_date ?? '').slice(0, 4) || null);
    const canonical = /^\d{4}-/.test(e.slug) ? e.slug : season ? `${season}-${e.slug}` : e.slug;

    // Resolve the competition: explicit mapping first, else the canonical slug.
    const compRow = (
      await db.execute({
        sql: `SELECT competition_slug FROM event_to_competition WHERE event_slug IN (?, ?) LIMIT 1`,
        args: [e.slug, canonical],
      })
    ).rows[0] as { competition_slug: string } | undefined;
    const comp = compRow?.competition_slug ?? canonical;

    // One row per corps (best/highest-scoring round), performing only.
    const scores = (
      await db.execute({
        sql: `SELECT corps_key, corps_name, division_name, rank, total_score
              FROM corps_scores
              WHERE competition_slug = ? AND total_score > 0
              GROUP BY corps_key
              HAVING total_score = MAX(total_score)
              ORDER BY total_score ASC`,
        args: [comp],
      })
    ).rows as unknown as ScoreRow[];

    // Fallback: some competitions have a bare competition_corps roster (who
    // competed) but no corps_scores. Derive a class-grouped lineup from it —
    // names/class from the corps table, no placement order (ordered by class+name).
    if (scores.length === 0) {
      const roster = (
        await db.execute({
          sql: `SELECT cc.corps_key,
                       COALESCE(c.name, cc.corps_key) AS corps_name,
                       c.division_name, NULL AS rank, NULL AS total_score
                FROM competition_corps cc
                LEFT JOIN corps c ON c.corps_key = cc.corps_key
                WHERE cc.competition_slug = ?
                ORDER BY c.division_name, c.name`,
          args: [comp],
        })
      ).rows as unknown as ScoreRow[];
      scores.push(...roster);
    }

    if (scores.length === 0) {
      noRoster++;
      continue;
    }

    eventsWithLineup++;
    totalRows += scores.length;
    if (samples.length < 8) {
      samples.push(
        `  ${e.slug}  (${scores.length} corps via ${comp})  e.g. ${scores
          .slice(0, 3)
          .map((s) => s.corps_name)
          .join(', ')}`
      );
    }

    if (apply) {
      let order = 1;
      for (const s of scores) {
        const entryId = `${e.slug}-scores-${order}`;
        await db.execute({
          sql: `INSERT INTO event_participants
                  (event_slug, participant_id, corps_key, participant_slug, participant_name, performance_order)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT DO NOTHING`,
          args: [e.slug, s.corps_key, s.corps_key, DERIVED_TAG, s.corps_name, order],
        });
        await db.execute({
          sql: `INSERT INTO event_lineup_entries
                  (entry_id, event_slug, participant_id, unit_name, display_city, time,
                   performance_order, is_non_performance, is_exhibition, source_scraped_at, source_url, lineup_index)
                VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, 0, ?, ?, ?)
                ON CONFLICT(entry_id) DO NOTHING`,
          args: [
            entryId,
            e.slug,
            s.corps_key,
            s.corps_name,
            order,
            new Date().toISOString(),
            DERIVED_TAG,
            order - 1,
          ],
        });
        order++;
      }
    }
  }

  console.log(`${apply ? 'APPLY' : 'DRY RUN'} — derive lineups from corps_scores`);
  if (slugArg) console.log(`  slug filter: ${slugArg}`);
  console.log(`  events missing a lineup scanned: ${events.length}`);
  console.log(`  → would populate: ${eventsWithLineup} events, ${totalRows} lineup rows`);
  console.log(`  → no roster available (skip): ${noRoster}`);
  console.log(`  → skipped (ambiguous/reused slug — migrate to prefixed first): ${skippedAmbiguous}`);
  console.log('\n  samples:');
  for (const s of samples) console.log(s);
  if (!apply) console.log('\n  (dry run — pass --apply to write; reversible via source_url tag)');
  else console.log('\n  done.');
}

main()
  .then(() => db.close())
  .catch((e) => {
    console.error('derive failed:', e);
    db.close();
    process.exit(1);
  });
