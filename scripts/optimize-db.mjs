/**
 * Idempotent DB optimization for the event-directory read path.
 *
 * - Ensures WAL journal mode (better read/write concurrency).
 * - Creates indexes on the JOIN / GROUP BY columns used by
 *   `listEventsForSeason` in app/lib/event-directory.ts that were not already
 *   covered by existing indexes.
 * - Runs ANALYZE so the query planner has fresh statistics.
 *
 * Run: `node scripts/optimize-db.mjs`
 * Target DB: $DCI_RELATIONAL_DB_URL or sdk/dci-relational.db
 */
import { createClient } from '@libsql/client';
import path from 'node:path';

const url = process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve('sdk', 'dci-relational.db')}`;
const db = createClient({ url });

const statements = [
  // WAL: persistent once set; safe to re-assert.
  'PRAGMA journal_mode=WAL',
  // judge_assignments GROUP BY competition_slug + COUNT(DISTINCT normalized_caption_name)
  'CREATE INDEX IF NOT EXISTS idx_judge_assignments_competition ON judge_assignments(competition_slug, normalized_caption_name)',
  // competitions join predicates (season + date + event_name)
  'CREATE INDEX IF NOT EXISTS idx_competitions_season ON competitions(season)',
  'CREATE INDEX IF NOT EXISTS idx_competitions_date ON competitions(date)',
  'CREATE INDEX IF NOT EXISTS idx_competitions_event_name ON competitions(event_name)',
  // prediction runs filtered by season, grouped by event_slug
  'CREATE INDEX IF NOT EXISTS idx_model_predictions_season_event ON model_event_prediction_runs(season, event_slug)',
];

for (const sql of statements) {
  const res = await db.execute(sql);
  if (sql.startsWith('PRAGMA journal_mode')) {
    console.log(`journal_mode -> ${JSON.stringify(res.rows[0])}`);
  } else {
    console.log(`ok: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
}

await db.execute('ANALYZE');
console.log('ANALYZE complete.');
