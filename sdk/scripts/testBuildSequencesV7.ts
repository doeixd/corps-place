// scripts/testBuildSequencesV7.ts
// Test V7 sequence builder on a single season
// Usage: npx tsx scripts/testBuildSequencesV7.ts

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import * as fs from "node:fs";

const REFERENCE_CURVES = JSON.parse(fs.readFileSync("./src/training/referenceCurvesV4.json", "utf-8"));
const JUDGE_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync("./src/training/judgeIndexMap.json", "utf-8"));

const TEST_SEASON = "2023"; // Test with 2023 season

const testBuild = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log(`🧪 Testing V7 sequence builder with ${TEST_SEASON} season...\n`);

  // Clear existing V7 data for test season
  yield* (sql`DELETE FROM ml_sequence_rows_v7 WHERE season = ${TEST_SEASON}`);
  console.log(`Cleared existing ${TEST_SEASON} data\n`);

  // Import the actual build function dynamically
  const { buildSequencesV7 } = await import("../src/buildMlSequencesV7.js");

  // Run the builder (it processes all seasons, but we'll filter later)
  console.log("Building sequences...\n");
  yield* (buildSequencesV7);

  // Check results
  const countResult = yield* (sql`SELECT COUNT(*) as count FROM ml_sequence_rows_v7 WHERE season = ${TEST_SEASON}`);
  const count = countResult[0]?.count ?? 0;

  console.log(`\n✅ Built ${count} sequences for ${TEST_SEASON}`);

  // Validate dimensions
  const sampleResult = yield* (sql`
    SELECT x_sequence_json, x_static_json, judge_indices_json, season, corps_key, competition_slug
    FROM ml_sequence_rows_v7
    WHERE season = ${TEST_SEASON}
    LIMIT 1
  `);

  if (sampleResult.length > 0) {
    const sample = sampleResult[0];
    const xSeq = JSON.parse(sample.x_sequence_json as string);
    const xStatic = JSON.parse(sample.x_static_json as string);
    const judgeIndices = JSON.parse(sample.judge_indices_json as string);

    console.log(`\n🔍 Dimension validation (sample: ${sample.corps_key} @ ${sample.competition_slug}):`);
    console.log(`  Sequence length: ${xSeq.length} timesteps`);
    console.log(`  Features per timestep: ${xSeq[0]?.length ?? 0} (expected: 67)`);
    console.log(`  Static features: ${xStatic.length} (expected: 73)`);
    console.log(`  Judge indices: ${judgeIndices.length} judges`);

    // Validate expected dimensions
    const timestepFeats = xSeq[0]?.length ?? 0;
    const staticFeats = xStatic.length;

    if (timestepFeats === 67 && staticFeats === 73) {
      console.log(`\n  ✅ All dimensions correct!`);
    } else {
      console.error(`\n  ❌ Dimension mismatch!`);
      console.error(`     Timestep features: expected 67, got ${timestepFeats}`);
      console.error(`     Static features: expected 73, got ${staticFeats}`);
      throw new Error("Dimension validation failed");
    }

    // Validate judge indices
    const validIndices = judgeIndices.every((idx: number) => idx >= 0 && idx <= 302);
    if (validIndices) {
      console.log(`  ✅ Judge indices valid (range 0-302)`);
    } else {
      console.error(`  ❌ Invalid judge indices found`);
      throw new Error("Judge index validation failed");
    }
  } else {
    console.error(`\n❌ No sequences generated for ${TEST_SEASON}`);
    throw new Error("No sequences generated");
  }

  // Show breakdown by season
  console.log(`\n📊 Sequences by season:`);
  const seasonCounts = yield* (sql`
    SELECT season, COUNT(*) as count
    FROM ml_sequence_rows_v7
    GROUP BY season
    ORDER BY season
  `);

  for (const row of seasonCounts) {
    console.log(`  ${row.season}: ${row.count} sequences`);
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = testBuild.pipe(Effect.provide(SqlLayer));

Effect.runPromise(program)
  .then(() => {
    console.log("\n✨ Test passed!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ Test failed:", err);
    process.exit(1);
  });
