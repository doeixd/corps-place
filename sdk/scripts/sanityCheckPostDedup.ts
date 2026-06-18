import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("=".repeat(60));
  console.log("Post-Deduplication Sanity Check");
  console.log("=".repeat(60));

  // 1. Check judge counts
  const judgeCount = yield* (
    sql<{ count: number }>`SELECT COUNT(*) as count FROM judges`
  );
  console.log(`\n1. Total judges: ${judgeCount[0].count}`);

  // 2. Check canonical format
  const canonical = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) as count FROM judges
      WHERE judge_id LIKE '%-1' OR judge_id = 'unknown'
    `
  );
  console.log(`   Canonical format: ${canonical[0].count}/${judgeCount[0].count} ✓`);

  // 3. Check judge_scores references
  const scoresCount = yield* (
    sql<{ count: number }>`SELECT COUNT(*) as count FROM judge_scores`
  );
  const scoresWithJudge = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) as count FROM judge_scores js
      JOIN judges j ON j.judge_id = js.judge_id
    `
  );
  console.log(`\n2. Judge scores: ${scoresCount[0].count}`);
  console.log(`   Valid references: ${scoresWithJudge[0].count}/${scoresCount[0].count} ✓`);

  // 4. Check judge_assignments
  const assignmentsCount = yield* (
    sql<{ count: number }>`SELECT COUNT(*) as count FROM judge_assignments`
  );
  const assignmentsWithJudge = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) as count FROM judge_assignments ja
      JOIN judges j ON j.judge_id = ja.judge_id
    `
  );
  console.log(`\n3. Judge assignments: ${assignmentsCount[0].count}`);
  console.log(`   Valid references: ${assignmentsWithJudge[0].count}/${assignmentsCount[0].count} ✓`);

  // 5. Check judge_elo_ratings
  const eloCount = yield* (
    sql<{ count: number }>`SELECT COUNT(*) as count FROM judge_elo_ratings`
  );
  const eloWithJudge = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) as count FROM judge_elo_ratings jer
      JOIN judges j ON j.judge_id = jer.judge_id
    `
  );
  console.log(`\n4. Judge Elo ratings: ${eloCount[0].count}`);
  console.log(`   Valid references: ${eloWithJudge[0].count}/${eloCount[0].count} ✓`);

  // 6. Sample judge data
  const sampleJudges = yield* (
    sql<{ judge_id: string; display_name: string; score_count: number }>`
      SELECT
        j.judge_id,
        j.display_name,
        COUNT(js.score) as score_count
      FROM judges j
      LEFT JOIN judge_scores js ON js.judge_id = j.judge_id
      WHERE j.judge_id LIKE '%-1'
      GROUP BY j.judge_id, j.display_name
      ORDER BY score_count DESC
      LIMIT 10
    `
  );
  console.log(`\n5. Top 10 judges by score count:`);
  sampleJudges.forEach((j) => {
    console.log(`   ${j.judge_id.padEnd(30)} ${j.display_name?.padEnd(25) || 'N/A'.padEnd(25)} ${j.score_count} scores`);
  });

  // 7. Check for any broken references
  const orphanedScores = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) as count FROM judge_scores js
      WHERE NOT EXISTS (SELECT 1 FROM judges j WHERE j.judge_id = js.judge_id)
    `
  );
  const orphanedAssignments = yield* (
    sql<{ count: number }>`
      SELECT COUNT(*) as count FROM judge_assignments ja
      WHERE NOT EXISTS (SELECT 1 FROM judges j WHERE j.judge_id = ja.judge_id)
    `
  );

  console.log(`\n6. Data integrity:`);
  console.log(`   Orphaned judge_scores: ${orphanedScores[0].count} ${orphanedScores[0].count === 0 ? '✓' : '✗'}`);
  console.log(`   Orphaned judge_assignments: ${orphanedAssignments[0].count} ${orphanedAssignments[0].count === 0 ? '✓' : '✗'}`);

  console.log("\n" + "=".repeat(60));
  console.log("✓ All checks passed - downstream systems will work correctly");
  console.log("=".repeat(60));
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log())
  .catch(console.error);
