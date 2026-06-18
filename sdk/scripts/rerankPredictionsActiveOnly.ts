// Correct season prediction rows to include only corps actually competing that
// season, then recompute predicted_rank.
//
// Usage:
//   npx tsx scripts/rerankPredictionsActiveOnly.ts            # dry-run (default)
//   npx tsx scripts/rerankPredictionsActiveOnly.ts --apply    # delete + re-rank
//   npx tsx scripts/rerankPredictionsActiveOnly.ts --season 2026
//
// Why: championship forecasts seed their field from the prior season's finalists
// (the real lineup isn't known until the season plays out). A corps on hiatus —
// e.g. the Mandarins in 2026 — was a prior-season finalist but isn't on the field,
// so it leaked into the 2026 Finals/Semifinals forecast at rank 7, shifting every
// corps below it. predicted_total is per-corps (participant-independent) and
// predicted_rank is purely its global order within a run, so removing non-competing
// corps and re-numbering by predicted_total DESC yields exactly what a clean
// regeneration would, without re-running the model. (predictEventRecap.ts is also
// fixed so future runs apply this filter at the source.)
//
// "Competing this season" = appears in scored_event_lineup for the season (the same
// lineup-derived definition the directory uses for "active"). Rows with a null or
// non-competing corps_key are dropped; remaining rows are re-ranked per run.

import Database from 'better-sqlite3';
import { activeSeasonCorpsKeys } from '../src/scriptSupport.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const seasonIdx = args.indexOf('--season');
const SEASON = seasonIdx >= 0 ? args[seasonIdx + 1] : '2026';
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 ? args[dbIdx + 1] : './dci-relational.db';

const db = new Database(DB_PATH);

const active = activeSeasonCorpsKeys(db, SEASON);

const runs = db
  .prepare(`SELECT prediction_id, event_slug FROM model_event_prediction_runs WHERE season = ?`)
  .all(SEASON) as Array<{ prediction_id: string; event_slug: string }>;

type Row = {
  corps_name: string;
  corps_key: string | null;
  predicted_total: number | null;
  predicted_rank: number | null;
};

const rowsStmt = db.prepare(
  `SELECT corps_name, corps_key, predicted_total, predicted_rank
   FROM model_event_prediction_rows WHERE prediction_id = ?`
);
const delStmt = db.prepare(
  `DELETE FROM model_event_prediction_rows WHERE prediction_id = ? AND corps_name = ?`
);
const rankStmt = db.prepare(
  `UPDATE model_event_prediction_rows SET predicted_rank = ? WHERE prediction_id = ? AND corps_name = ?`
);

let totalDeleted = 0;
let totalReranked = 0;
const perEventDeletes = new Map<string, Set<string>>(); // event_slug -> corps names removed
const sampleRankChanges: string[] = [];

const apply = db.transaction(() => {
  for (const run of runs) {
    const rows = rowsStmt.all(run.prediction_id) as Row[];
    const remove = rows.filter((r) => !r.corps_key || !active.has(r.corps_key));
    const keep = rows.filter((r) => r.corps_key && active.has(r.corps_key));

    if (remove.length) {
      const set = perEventDeletes.get(run.event_slug) ?? new Set<string>();
      for (const r of remove) {
        set.add(r.corps_name);
        if (APPLY) delStmt.run(run.prediction_id, r.corps_name);
      }
      perEventDeletes.set(run.event_slug, set);
      totalDeleted += remove.length;
    }

    // Re-rank survivors by predicted_total DESC (nulls last), stable on name.
    keep.sort((a, b) => {
      const ta = a.predicted_total ?? -Infinity;
      const tb = b.predicted_total ?? -Infinity;
      return tb - ta || a.corps_name.localeCompare(b.corps_name);
    });
    keep.forEach((r, i) => {
      const newRank = i + 1;
      if (r.predicted_rank !== newRank) {
        totalReranked += 1;
        if (
          remove.length &&
          /world-championship-(finals|semifinals)/.test(run.event_slug) &&
          sampleRankChanges.length < 14
        ) {
          sampleRankChanges.push(
            `   ${run.event_slug.replace('2026-dci-', '')}: ${r.corps_name} ${r.predicted_rank} → ${newRank}`
          );
        }
        if (APPLY) rankStmt.run(newRank, run.prediction_id, r.corps_name);
      }
    });
  }
});

apply();

console.log(`\nRe-rank predictions (active-only) ${APPLY ? '(APPLY)' : '(dry-run)'} — season ${SEASON}`);
console.log(`Active corps this season: ${active.size}`);
console.log(`Runs scanned: ${runs.length}`);
console.log(`Rows removed (non-competing / null): ${totalDeleted}`);
console.log(`Rows re-ranked: ${totalReranked}\n`);
console.log('Events with removed corps:');
for (const [ev, names] of [...perEventDeletes.entries()].sort()) {
  const real = [...names].filter((n) => n && n !== 'null');
  console.log(`  ${ev}: ${real.length} removed — ${real.slice(0, 6).join(', ')}${real.length > 6 ? '…' : ''}`);
}
if (sampleRankChanges.length) {
  console.log('\nSample championship rank shifts:');
  for (const s of sampleRankChanges) console.log(s);
}
if (!APPLY) console.log('\nDry-run only — re-run with --apply to write.');

db.close();
