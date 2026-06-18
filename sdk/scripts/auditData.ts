import Database from 'better-sqlite3';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DB_PATH = './dci-relational.db';

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  const db = new Database(DB_PATH, { readonly: true });
  console.log('🔍 Starting Data Integrity Audit on', DB_PATH);

  // 1. Completeness Check
  console.log('\n--- 1. Completeness Check ---');

  const nullScores = db.prepare(`
    SELECT COUNT(*) as count 
    FROM corps_scores 
    WHERE total_score IS NULL
  `).get() as { count: number };
  console.log(`Missing Total Scores: ${nullScores.count} (Should be 0)`);

  const nullRanks = db.prepare(`
    SELECT COUNT(*) as count 
    FROM corps_scores 
    WHERE rank IS NULL AND division_name = 'World Class'
  `).get() as { count: number };
  console.log(`Missing Ranks (World Class): ${nullRanks.count}`);

  const nullDates = db.prepare(`
    SELECT COUNT(*) as count 
    FROM competitions 
    WHERE date IS NULL
  `).get() as { count: number };
  console.log(`Missing Competition Dates: ${nullDates.count}`);

  // 2. Outlier Check
  console.log('\n--- 2. Outlier Check ---');

  const invalidScores = db.prepare(`
    SELECT COUNT(*) as count, MIN(total_score) as minScore, MAX(total_score) as maxScore
    FROM corps_scores 
    WHERE total_score < 0 OR total_score > 100
  `).get() as { count: number, minScore: number, maxScore: number };

  if (invalidScores.count > 0) {
    console.error(`❌ Found ${invalidScores.count} invalid scores! Range: [${invalidScores.minScore}, ${invalidScores.maxScore}]`);
  } else {
    console.log('✅ All scores within [0, 100]');
  }

  // 3. Logic Check (Rank Monotonicity)
  console.log('\n--- 3. Logic Check (Avg Score by Rank) ---');
  // Check if Avg Score decreases as Rank increases (for World Class)
  const rankStats = db.prepare(`
    SELECT rank, AVG(total_score) as avgScore, COUNT(*) as count
    FROM corps_scores
    WHERE division_name = 'World Class' AND rank <= 12
    GROUP BY rank
    ORDER BY rank ASC
  `).all() as { rank: number, avgScore: number, count: number }[];

  let monotonicityViolation = false;
  let prevScore = 101;

  console.log('Rank | Avg Score | N');
  console.log('-----|-----------|---');
  for (const row of rankStats) {
    console.log(`${row.rank.toString().padEnd(4)} | ${row.avgScore.toFixed(2).padEnd(9)} | ${row.count}`);
    if (row.avgScore > prevScore) {
      monotonicityViolation = true;
      console.warn(`  ⚠️ Violation: Rank ${row.rank} avg > Rank ${row.rank - 1}`);
    }
    prevScore = row.avgScore;
  }

  if (monotonicityViolation) {
    console.warn('⚠️ Monotonicity Warning: Higher ranks (worse) should have lower average scores. Small violations might be due to early season noise.');
  } else {
    console.log('✅ Rank Monotonicity Holds (Rank 1 > Rank 2 ... > Rank 12)');
  }

  // 4. Reference Curve Coverage
  console.log('\n--- 4. Data Volume by Season ---');
  const seasonCounts = db.prepare(`
    SELECT s.season, COUNT(*) as count
    FROM corps_scores cs
    JOIN competitions c ON cs.competition_slug = c.slug
    JOIN (SELECT DISTINCT season FROM competitions) s ON c.season = s.season
    GROUP BY s.season
    ORDER BY s.season
  `).all() as { season: string, count: number }[];

  seasonCounts.forEach(r => console.log(`${r.season}: ${r.count} scores`));

}

main();
