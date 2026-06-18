// Normalize lineup classification and purge schedule-noise corps.
//
// Source of truth = the `domain_event_exclusion_patterns` table (heuristic rules
// as data). This script:
//   1. Adds a `category` column to that table (idempotent) and backfills the
//      pre-existing rows to category 'model'.
//   2. Upserts the canonical schedule_item + exhibition patterns from
//      ../src/lineupClassification.ts.
//   3. (Re)creates the `season_performing_corps` view, which reads the patterns
//      table — no embedded keyword list.
//   4. Hard-deletes bogus `corps` records that are schedule/agenda noise
//      (name matches a schedule_item pattern, with zero scores and zero model
//      prediction rows), plus their orphaned event_participants / lineup entries.
//
// Dry-run by default; pass --apply to write. Deliberately does NOT touch
// is_non_performance / is_exhibition or the model views (scored_event_lineup,
// event_lineup_exclusions) — those drive predictions and stay as-is.

import { createClient } from '@libsql/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_EXCLUSION_PATTERNS,
  SCHEDULE_ITEM_PATTERNS,
  NON_CORPS_CATEGORIES,
  isNonCorpsName,
} from '../src/lineupClassification.js';

const APPLY = process.argv.includes('--apply');
const scriptPath = fileURLToPath(import.meta.url);
const sdkDir = path.resolve(path.dirname(scriptPath), '..');
const dbUrl = `file:${path.resolve(sdkDir, 'dci-relational.db')}`;
const db = createClient({ url: dbUrl });

const exec = (sql: string, args: unknown[] = []) => db.execute({ sql, args: args as never[] });

const main = async () => {
  await exec('PRAGMA busy_timeout = 5000');

  // 1. Ensure `category` column exists.
  const cols = await exec("SELECT name FROM pragma_table_info('domain_event_exclusion_patterns')");
  const hasCategory = cols.rows.some((r) => (r as { name: string }).name === 'category');
  if (!hasCategory) {
    console.log(`${APPLY ? '' : '[dry-run] '}ALTER TABLE add column category`);
    if (APPLY) {
      await exec(
        "ALTER TABLE domain_event_exclusion_patterns ADD COLUMN category TEXT NOT NULL DEFAULT 'model'"
      );
    }
  }

  // 2. Upsert canonical patterns. Existing soundsport/showcase rows keep
  //    category 'model' (the column default), so the model layer is untouched.
  let upserts = 0;
  for (const p of ALL_EXCLUSION_PATTERNS) {
    if (APPLY) {
      await exec(
        `INSERT INTO domain_event_exclusion_patterns (pattern, reason, applies_to_model, category)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(pattern) DO UPDATE SET reason = excluded.reason, category = excluded.category`,
        [p.pattern, p.reason, p.category]
      );
    }
    upserts++;
  }
  console.log(`${APPLY ? '' : '[dry-run] '}upserted ${upserts} patterns`);

  // 3. (Re)create the performing-corps view (reads the patterns table).
  const viewSql = `CREATE VIEW season_performing_corps AS
    SELECT DISTINCT e.season AS season, ele.corps_key AS corps_key
    FROM classified_event_lineup ele
    JOIN events e ON e.slug = ele.event_slug
    JOIN corps c ON c.corps_key = ele.corps_key
    WHERE ele.participant_id IS NOT NULL
      AND ele.corps_key IS NOT NULL
      AND ele.is_non_corps = 0`;
  if (APPLY) {
    await exec('DROP VIEW IF EXISTS season_performing_corps');
    await exec(viewSql);
  }
  console.log(`${APPLY ? '' : '[dry-run] '}(re)created view season_performing_corps`);

  // 4. Identify bogus schedule-noise corps: name is a schedule item, no scores,
  //    no model prediction rows.
  const candidates = await exec(`
    SELECT c.corps_key, c.name,
      (SELECT COUNT(*) FROM corps_scores s WHERE s.corps_key = c.corps_key) AS scores,
      (SELECT COUNT(*) FROM model_event_prediction_rows r WHERE r.corps_key = c.corps_key) AS pred_rows
    FROM corps c
  `);
  const bogus = (candidates.rows as unknown as Array<{
    corps_key: string;
    name: string;
    scores: number;
    pred_rows: number;
  }>).filter((r) => isNonCorpsName(r.name) && r.scores === 0 && r.pred_rows === 0);

  console.log(`\nBogus non-corps rows to delete (${bogus.length}):`);
  for (const b of bogus) console.log(`  - ${b.corps_key}  «${b.name}»`);

  if (APPLY && bogus.length) {
    const keys = bogus.map((b) => b.corps_key);
    const placeholders = keys.map(() => '?').join(',');
    // Delete orphaned lineup entries first (they reference participants), then
    // participants, then the corps rows themselves.
    await exec(
      `DELETE FROM event_lineup_entries
       WHERE (event_slug, participant_id) IN (
         SELECT event_slug, participant_id FROM event_participants WHERE corps_key IN (${placeholders})
       )`,
      keys
    );
    await exec(`DELETE FROM event_participants WHERE corps_key IN (${placeholders})`, keys);
    await exec(`DELETE FROM corps WHERE corps_key IN (${placeholders})`, keys);
    console.log(`\nDeleted ${bogus.length} bogus corps and their lineup/participant rows.`);
  }

  console.log(`\n${APPLY ? '✅ applied' : 'Dry-run only — re-run with --apply to write.'}`);
  console.log(
    `(non-corps categories: ${NON_CORPS_CATEGORIES.join(', ')}; ` +
      `schedule_item patterns: ${SCHEDULE_ITEM_PATTERNS.length})`
  );
  db.close();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
