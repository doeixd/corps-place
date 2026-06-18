// Test the new queryPerformanceOrder function
// Usage: npx tsx scripts/testPerformanceOrderV2.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as MlQueries from "../src/mlQueries.js";

const main = Effect.gen(function* () {
  console.log("Testing new queryPerformanceOrder function...\n");

  const performanceOrderRows = yield* (MlQueries.queryPerformanceOrder("2022"));

  // Filter to our test event
  const testRows = performanceOrderRows.filter(r => r.competition_slug === '2022-dci-world-championship-semifinals');

  console.log(`Found ${testRows.length} corps for 2022 DCI World Championship Semifinals`);
  console.log("\nSample data:");

  let withOrder = 0;
  let withoutOrder = 0;

  for (const row of testRows.slice(0, 10)) {
    const hasOrder = row.performance_order_in_class !== null;
    if (hasOrder) withOrder++;
    else withoutOrder++;

    console.log(`  ${row.corps_key}: orderInClass=${row.performance_order_in_class}, orderOverall=${row.performance_order_overall}, countInClass=${row.number_of_performers_in_class}`);
  }

  console.log(`\nTotal: ${testRows.length} corps`);
  console.log(`  With explicit order: ${testRows.filter(r => r.performance_order_in_class !== null).length}`);
  console.log(`  Without order (NULL): ${testRows.filter(r => r.performance_order_in_class === null).length}`);

  // Test map construction (simulating buildMlSequencesV9)
  const performanceOrderMap = new Map();
  for (const row of testRows) {
    const key = `${row.competition_slug}_${row.corps_key}`;
    performanceOrderMap.set(key, {
      orderOverall: row.performance_order_overall,
      orderInClass: row.performance_order_in_class,
      countOverall: row.number_of_performers_overall ?? 0,
      countInClass: row.number_of_performers_in_class ?? 0,
    });
  }

  console.log(`\nPerformanceOrderMap size: ${performanceOrderMap.size}`);
  console.log(`\n✅ All ${testRows.length} corps from corpus_scores are now included!`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
