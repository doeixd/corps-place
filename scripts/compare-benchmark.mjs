#!/usr/bin/env node
// Private side-by-side grading: OUR served last-pre-show prediction vs Field Read's, on the
// SAME ground-truth actuals (our corps_scores), for shows where BOTH have pre-show predictions
// and the show has scored. Matches corps by corps_key.
//
// Usage: node scripts/compare-benchmark.mjs
//   env: DCI_RELATIONAL_DB_URL (optional) overrides the DB file url.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('@libsql/client');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function dbUrl() {
  if (process.env.DCI_RELATIONAL_DB_URL) return process.env.DCI_RELATIONAL_DB_URL;
  return 'file:' + path.join(REPO_ROOT, 'sdk', 'dci-relational.db');
}
const db = createClient({ url: dbUrl() });

const DIVS = "('World Class','Open Class')";

async function main() {
  // OUR last pre-show run per (event, division) -> predicted totals by corps_key
  const ours = await db.execute(`
    WITH last_run AS (
      SELECT run.prediction_id, run.event_slug, run.division,
             ROW_NUMBER() OVER (PARTITION BY run.event_slug, run.division
                                ORDER BY run.predicted_at DESC) AS rn
      FROM model_event_prediction_runs run
      JOIN events e ON e.slug = run.event_slug
      WHERE run.predicted_at < e.start_date
    )
    SELECT lr.event_slug, r.corps_key, r.predicted_total
    FROM last_run lr
    JOIN model_event_prediction_rows r ON r.prediction_id = lr.prediction_id
    WHERE lr.rn = 1 AND r.corps_key IS NOT NULL AND r.predicted_total IS NOT NULL
  `);

  // THEIR predictions (record page = day-of, graded), matched to our events + corps
  const theirs = await db.execute(`
    SELECT event_slug, corps_key, predicted_total
    FROM external_benchmark_predictions
    WHERE source='field-read' AND page_source='record'
      AND event_slug IS NOT NULL AND corps_key IS NOT NULL AND predicted_total IS NOT NULL
  `);

  // ground-truth actuals
  const actuals = await db.execute(`
    SELECT cs.competition_slug AS event_slug, cs.corps_key, cs.corps_name, cs.total_score
    FROM corps_scores cs
    JOIN competitions c ON c.slug = cs.competition_slug AND c.scores_released = 1
    WHERE cs.division_name IN ${DIVS} AND cs.total_score IS NOT NULL AND cs.corps_key IS NOT NULL
  `);

  const oursMap = new Map(); // event -> corps_key -> pred
  for (const r of ours.rows) {
    if (!oursMap.has(r.event_slug)) oursMap.set(r.event_slug, new Map());
    oursMap.get(r.event_slug).set(r.corps_key, r.predicted_total);
  }
  const theirsMap = new Map();
  for (const r of theirs.rows) {
    if (!theirsMap.has(r.event_slug)) theirsMap.set(r.event_slug, new Map());
    theirsMap.get(r.event_slug).set(r.corps_key, r.predicted_total);
  }
  const actMap = new Map(); // event -> corps_key -> {name,total}
  const eventNames = new Map();
  for (const r of actuals.rows) {
    if (!actMap.has(r.event_slug)) actMap.set(r.event_slug, new Map());
    actMap.get(r.event_slug).set(r.corps_key, { name: r.corps_name, total: r.total_score });
  }

  const events = [...actMap.keys()].filter((e) => oursMap.has(e) && theirsMap.has(e)).sort();

  const perShow = [];
  const pool = { ours: [], theirs: [] };
  let winOurs = 0, winTheirs = 0, winBoth = 0, winShows = 0;

  for (const ev of events) {
    const A = actMap.get(ev), O = oursMap.get(ev), T = theirsMap.get(ev);
    const rows = [];
    for (const [ck, a] of A) {
      if (O.has(ck) && T.has(ck)) {
        rows.push({ ck, name: a.name, actual: a.total, ours: O.get(ck), theirs: T.get(ck) });
      }
    }
    if (rows.length < 2) continue; // need >=2 to score a winner
    const oErr = rows.map((r) => Math.abs(r.ours - r.actual));
    const tErr = rows.map((r) => Math.abs(r.theirs - r.actual));
    const mae = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    pool.ours.push(...oErr);
    pool.theirs.push(...tErr);

    const actualWin = rows.slice().sort((a, b) => b.actual - a.actual)[0].ck;
    const ourWin = rows.slice().sort((a, b) => b.ours - a.ours)[0].ck;
    const theirWin = rows.slice().sort((a, b) => b.theirs - a.theirs)[0].ck;
    const oW = ourWin === actualWin, tW = theirWin === actualWin;
    if (oW) winOurs++;
    if (tW) winTheirs++;
    if (oW && tW) winBoth++;
    winShows++;

    perShow.push({
      ev, n: rows.length, maeOurs: mae(oErr), maeTheirs: mae(tErr), oW, tW,
    });
  }

  // ---- report ----
  const pmae = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const f = (x) => (Number.isFinite(x) ? x.toFixed(3) : ' n/a ');
  console.log('\nUS vs FIELD READ  —  matched shows (both have pre-show preds + actuals)\n');
  console.log(
    'SHOW'.padEnd(34) + 'N'.padStart(4) + 'MAE_ours'.padStart(10) +
      'MAE_them'.padStart(10) + '  win_ours win_them',
  );
  console.log('-'.repeat(80));
  for (const s of perShow) {
    console.log(
      s.ev.slice(0, 33).padEnd(34) + String(s.n).padStart(4) +
        f(s.maeOurs).padStart(10) + f(s.maeTheirs).padStart(10) +
        '     ' + (s.oW ? '  ✓' : '  ✗') + '       ' + (s.tW ? '✓' : '✗'),
    );
  }
  console.log('-'.repeat(80));
  console.log(
    `POOLED  shows=${perShow.length}  preds=${pool.ours.length}  ` +
      `MAE_ours=${f(pmae(pool.ours))}  MAE_them=${f(pmae(pool.theirs))}`,
  );
  console.log(
    `WINNER  ours=${winOurs}/${winShows}  them=${winTheirs}/${winShows}  bothRight=${winBoth}/${winShows}`,
  );
  const better = pmae(pool.ours) < pmae(pool.theirs) ? 'OURS' : 'FIELD READ';
  console.log(`\nPooled MAE leader: ${better}\n`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
