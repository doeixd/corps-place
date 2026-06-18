// scripts/runBuildSequencesV7.ts
// Test runner for V7 sequence builder
// Usage: npx tsx scripts/runBuildSequencesV7.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { buildSequencesV7 } from "../src/buildMlSequencesV7.js";

const main = Effect.gen(function* () {
  console.log("🚀 Building V7 ML sequences...\n");

  yield* (buildSequencesV7());

  console.log("\n✅ Sequence building complete!");

  // Query summary stats
  const sql = yield* (LibsqlClient.LibsqlClient);
  const countResult = yield* (sql`SELECT COUNT(*) as count FROM ml_sequence_rows_v7`);
  const count = countResult[0]?.count ?? 0;

  console.log(`\n📊 Summary:`);
  console.log(`  Total sequences: ${count}`);

  // Sample a few rows to verify
  const sampleResult = yield* (sql`
    SELECT season, competition_slug, competition_date, division_name, corps_key,
           LENGTH(x_sequence_json) as seq_len,
           LENGTH(x_static_json) as static_len,
           LENGTH(judge_indices_json) as judge_len,
           y_total
    FROM ml_sequence_rows_v7
    LIMIT 5
  `);

  console.log(`\n📋 Sample rows:`);
  for (const row of sampleResult) {
    console.log(`  ${row.season} | ${row.corps_key} @ ${row.competition_slug}`);
    console.log(`    Date: ${row.competition_date}`);
    console.log(`    Division: ${row.division_name}`);
    console.log(`    Total score: ${row.y_total}`);
    console.log(`    Sequence JSON size: ${row.seq_len} bytes`);
    console.log(`    Static JSON size: ${row.static_len} bytes`);
    console.log(`    Judge indices JSON size: ${row.judge_len} bytes`);
  }
});

// Set up layers
const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(
  Effect.provide(SqlLayer)
);

Effect.runPromise(program)
  .then(() => {
    console.log("\n✨ Done!");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n❌ Build failed:", err);
    process.exit(1);
  });
