import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DB_PATH = './dci-relational.db';
const OUT_PATH_PCT = './src/training/referenceCurvesPercent.json';

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  console.log('Computing Reference Curves (Percent-Based) from', DB_PATH);

  // 1. Fetch all valid scores with percent_through
  const rows = db.prepare(`
    SELECT 
      cs.rank, 
      cs.total_score,
      c.percent_through
    FROM corps_scores cs
    JOIN competitions c ON cs.competition_slug = c.slug
    WHERE cs.total_score IS NOT NULL 
      AND cs.rank IS NOT NULL 
      AND cs.division_name = 'World Class'
      AND c.percent_through IS NOT NULL
  `).all() as { rank: number, total_score: number, percent_through: number }[];

  // 2. Aggregate
  const curves: Record<string, { sum: number, count: number, avg: number }> = {};

  // Helper to get 5% bucket (0, 5, 10, ..., 100)
  const getPctBucket = (pct: number) => Math.floor(pct / 5) * 5;

  for (const row of rows) {
    const bucket = getPctBucket(row.percent_through);
    const key = `${row.rank}-${bucket}`;

    if (!curves[key]) {
      curves[key] = { sum: 0, count: 0, avg: 0 };
    }
    curves[key].sum += row.total_score;
    curves[key].count += 1;
  }

  // 3. Compute Averages
  const lookup: Record<string, number> = {};

  console.log('Reference Curve (Percent) Samples:');
  Object.keys(curves).sort((a, b) => {
    const [r1, p1] = a.split('-').map(Number);
    const [r2, p2] = b.split('-').map(Number);
    return r1 === r2 ? p1! - p2! : r1! - r2!;
  }).forEach(key => {
    const data = curves[key];
    data.avg = Number((data.sum / data.count).toFixed(3));
    lookup[key] = data.avg;
  });

  // 4. Save
  fs.writeFileSync(OUT_PATH_PCT, JSON.stringify(lookup, null, 2));
  console.log(`Saved ${Object.keys(lookup).length} reference points to ${OUT_PATH_PCT}`);
}

main();
