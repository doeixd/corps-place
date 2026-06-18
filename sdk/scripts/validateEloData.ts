// scripts/validateEloData.ts
// Validate Elo computation results
// Usage: npx tsx scripts/validateEloData.ts

import { createClient } from "@libsql/client";

async function validateEloData() {
  const client = createClient({ url: "file:./dci-relational.db" });

  console.log("🔍 Validating Elo computation results...\n");

  // Check judge Elo ratings
  const judgeEloCount = await client.execute({
    sql: "SELECT COUNT(*) as count FROM judge_elo_ratings"
  });
  console.log(`✓ Judge Elo ratings: ${judgeEloCount.rows[0].count} records`);

  // Check corps Elo ratings
  const corpsEloCount = await client.execute({
    sql: "SELECT COUNT(*) as count FROM corps_elo_ratings"
  });
  console.log(`✓ Corps Elo ratings: ${corpsEloCount.rows[0].count} records`);

  // Check judge Elo history
  const judgeHistoryCount = await client.execute({
    sql: "SELECT COUNT(*) as count FROM judge_elo_history"
  });
  console.log(`✓ Judge Elo history: ${judgeHistoryCount.rows[0].count} records`);

  // Check corps Elo history
  const corpsHistoryCount = await client.execute({
    sql: "SELECT COUNT(*) as count FROM corps_elo_history"
  });
  console.log(`✓ Corps Elo history: ${corpsHistoryCount.rows[0].count} records\n`);

  // Check for NaN or invalid values
  const invalidJudgeElo = await client.execute({
    sql: "SELECT COUNT(*) as count FROM judge_elo_ratings WHERE elo_rating IS NULL OR elo_rating != elo_rating"
  });
  console.log(`✓ Invalid judge Elo values: ${invalidJudgeElo.rows[0].count} (should be 0)`);

  const invalidCorpsElo = await client.execute({
    sql: "SELECT COUNT(*) as count FROM corps_elo_ratings WHERE elo_rating IS NULL OR elo_rating != elo_rating"
  });
  console.log(`✓ Invalid corps Elo values: ${invalidCorpsElo.rows[0].count} (should be 0)\n`);

  // Sample some judge Elo ratings
  console.log("📊 Sample Judge Elo Ratings (2024):");
  const sampleJudges = await client.execute({
    sql: `SELECT judge_id, caption_name, elo_rating, confidence, num_scores
          FROM judge_elo_ratings
          WHERE season = '2024'
          ORDER BY num_scores DESC
          LIMIT 10`
  });
  for (const row of sampleJudges.rows) {
    console.log(`  ${row.judge_id} (${row.caption_name}): Elo=${row.elo_rating?.toFixed(1)}, Confidence=${row.confidence?.toFixed(1)}, Scores=${row.num_scores}`);
  }

  // Sample some corps Elo ratings
  console.log("\n📊 Sample Corps Elo Ratings (2024, General Effect 1):");
  const sampleCorps = await client.execute({
    sql: `SELECT corps_key, caption_name, elo_rating, confidence, num_shows
          FROM corps_elo_ratings
          WHERE season = '2024' AND caption_name = 'General Effect 1'
          ORDER BY elo_rating DESC
          LIMIT 10`
  });
  for (const row of sampleCorps.rows) {
    console.log(`  ${row.corps_key}: Elo=${row.elo_rating?.toFixed(1)}, Confidence=${row.confidence?.toFixed(1)}, Shows=${row.num_shows}`);
  }

  // Check Elo distribution
  console.log("\n📈 Judge Elo Distribution:");
  const eloStats = await client.execute({
    sql: `SELECT
            AVG(elo_rating) as mean,
            MIN(elo_rating) as min,
            MAX(elo_rating) as max
          FROM judge_elo_ratings`
  });
  const stats = eloStats.rows[0];
  console.log(`  Mean: ${stats.mean?.toFixed(1)}`);
  console.log(`  Min:  ${stats.min?.toFixed(1)}`);
  console.log(`  Max:  ${stats.max?.toFixed(1)}`);

  // Check confidence distribution
  console.log("\n🎯 Confidence Distribution:");
  const confStats = await client.execute({
    sql: `SELECT
            AVG(confidence) as mean,
            MIN(confidence) as min,
            MAX(confidence) as max
          FROM judge_elo_ratings`
  });
  const confStatsRow = confStats.rows[0];
  console.log(`  Mean: ${confStatsRow.mean?.toFixed(1)}`);
  console.log(`  Min:  ${confStatsRow.min?.toFixed(1)}`);
  console.log(`  Max:  ${confStatsRow.max?.toFixed(1)}`);

  // Check if per-caption Elo makes sense
  console.log("\n📊 Per-Caption Judge Elo Variation:");
  const captionVariation = await client.execute({
    sql: `SELECT caption_name,
                 AVG(elo_rating) as mean_elo,
                 COUNT(*) as num_judges
          FROM judge_elo_ratings
          WHERE season = '2024'
          GROUP BY caption_name
          ORDER BY caption_name`
  });
  for (const row of captionVariation.rows) {
    console.log(`  ${row.caption_name}: Mean=${row.mean_elo?.toFixed(1)}, Judges=${row.num_judges}`);
  }

  client.close();
  console.log("\n✅ Validation complete!");
}

validateEloData().catch(err => {
  console.error("❌ Validation failed:", err);
  process.exit(1);
});
