// Test performance order feature extraction
// Usage: npx tsx scripts/testPerformanceOrderFeatures.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Testing performance order data flow...\n");

  // Test 1: Check appearances data
  const appearanceRows = yield* (sql<{
    competition_slug: string | null;
    corps_key: string | null;
    performance_order_overall: number | null;
    performance_order_in_class: number | null;
    number_of_performers_in_class: number | null;
    number_of_performers_overall: number | null;
  }>`
    SELECT
      competition_slug,
      corps_key,
      performance_order_overall,
      performance_order_in_class,
      number_of_performers_in_class,
      COUNT(*) OVER (PARTITION BY event_slug) AS number_of_performers_overall
    FROM appearances
    WHERE season = '2022'
      AND competition_slug = '2022-dci-world-championship-semifinals'
      AND corps_key IS NOT NULL
    LIMIT 10
  `);

  console.log("Appearances data sample:");
  console.log(`Found ${appearanceRows.length} rows`);
  for (const row of appearanceRows.slice(0, 5)) {
    console.log(`  ${row.competition_slug}_${row.corps_key}: orderInClass=${row.performance_order_in_class}, orderOverall=${row.performance_order_overall}`);
  }

  // Test 2: Build performanceOrderMap (simulating buildMlSequencesV9 logic)
  const performanceOrderMap = new Map<string, {
    orderOverall: number;
    orderInClass: number;
    countOverall: number;
    countInClass: number;
  }>();

  for (const row of appearanceRows) {
    if (!row.competition_slug || !row.corps_key) continue;
    const key = `${row.competition_slug}_${row.corps_key}`;
    performanceOrderMap.set(key, {
      orderOverall: row.performance_order_overall ?? 0,
      orderInClass: row.performance_order_in_class ?? 0,
      countOverall: row.number_of_performers_overall ?? 0,
      countInClass: row.number_of_performers_in_class ?? 0,
    });
  }

  console.log(`\nPerformanceOrderMap size: ${performanceOrderMap.size}`);

  // Test 3: Check if keys match between seasonRows and appearances
  const seasonRows = yield* (sql<{
    season: string;
    slug: string;
    corps_key: string;
  }>`
    SELECT DISTINCT
      c.season,
      c.slug,
      cs.corps_key
    FROM competitions c
    JOIN corps_scores cs ON cs.competition_slug = c.slug
    WHERE c.season = '2022'
      AND c.slug = '2022-dci-world-championship-semifinals'
      AND cs.corps_key IS NOT NULL
    LIMIT 10
  `);

  console.log(`\nSeasonRows data sample (from querySeasonCaptionsV6 simulation):`);
  console.log(`Found ${seasonRows.length} unique corps`);

  let matches = 0;
  let mismatches = 0;

  for (const row of seasonRows) {
    const lookupKey = `${row.slug}_${row.corps_key}`;
    const perfOrder = performanceOrderMap.get(lookupKey);

    if (perfOrder) {
      matches++;
      console.log(`  ✓ ${lookupKey}: orderInClass=${perfOrder.orderInClass}`);
    } else {
      mismatches++;
      console.log(`  ✗ ${lookupKey}: NOT FOUND in performanceOrderMap`);
    }
  }

  console.log(`\nResults: ${matches} matches, ${mismatches} mismatches`);

  if (mismatches > 0) {
    console.log("\n⚠️  ISSUE DETECTED: Keys from seasonRows don't match performanceOrderMap!");
  } else {
    console.log("\n✅ All keys match correctly!");
  }
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
