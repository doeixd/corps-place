// test/ml.test.ts
// Tests for ML infrastructure
//
// Run with: npx tsx test/ml.test.ts
// Or add a test runner like vitest

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import {
  buildNumericVector,
  ensureMlTables,
} from "../src/buildMlRows.js";
import {
  computeRollingFeatures,
  computeRankingsAsOf,
  daysBetween,
  type PriorShowRow,
  type BestSoFarRow,
} from "../src/mlQueries.js";

// ----- Test Utilities -----

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`FAIL: ${message}`);
  }
  console.log(`PASS: ${message}`);
}

function assertClose(a: number, b: number, tolerance: number, message: string) {
  if (Math.abs(a - b) > tolerance) {
    throw new Error(`FAIL: ${message} (expected ${b}, got ${a})`);
  }
  console.log(`PASS: ${message}`);
}

// ----- Unit Tests -----

function testBuildNumericVector() {
  console.log("\n=== Testing buildNumericVector ===");

  const spec = {
    version: "test",
    numericOrder: [
      { name: "a", defaultValue: 0 },
      { name: "b", defaultValue: -1, missingFlag: "has_b" },
      { name: "has_b", defaultValue: 0 },
    ],
  };

  // Test with missing values
  const vec1 = buildNumericVector(spec, {});
  assert(vec1[0] === 0, "Default value for a");
  assert(vec1[1] === -1, "Default value for b (missing)");
  assert(vec1[2] === 0, "has_b flag should be 0 when b is missing");

  // Test with provided values
  const vec2 = buildNumericVector(spec, { a: 10, b: 20 });
  assert(vec2[0] === 10, "Provided value for a");
  assert(vec2[1] === 20, "Provided value for b");
  assert(vec2[2] === 1, "has_b flag should be 1 when b is provided");

  // Test with null value
  const vec3 = buildNumericVector(spec, { a: 5, b: null });
  assert(vec3[0] === 5, "Provided value for a");
  assert(vec3[1] === -1, "Default for b when null");
  assert(vec3[2] === 0, "has_b flag should be 0 when b is null");
}

function testComputeRollingFeatures() {
  console.log("\n=== Testing computeRollingFeatures ===");

  // Empty shows
  const empty = computeRollingFeatures([]);
  assert(!empty.hasLastShow, "No shows - hasLastShow should be false");
  assert(!empty.hasLast3, "No shows - hasLast3 should be false");

  // One show
  const oneShow: PriorShowRow[] = [
    { competition_slug: "a", competition_date: "2024-07-01", total_score: 80, rank: 1, leader_corps_key: "a", leader_score: 80, day_of_season: 30, percent_through: 40, latitude: null, longitude: null },
  ];
  const one = computeRollingFeatures(oneShow);
  assert(one.hasLastShow, "One show - hasLastShow should be true");
  assert(!one.hasLast3, "One show - hasLast3 should be false");
  assert(one.lastScoreTotal === 80, "Last score should be 80");

  // Three shows
  const threeShows: PriorShowRow[] = [
    { competition_slug: "c", competition_date: "2024-07-15", total_score: 85, rank: 1, leader_corps_key: "c", leader_score: 85, day_of_season: 45, percent_through: 60, latitude: null, longitude: null },
    { competition_slug: "b", competition_date: "2024-07-10", total_score: 82, rank: 2, leader_corps_key: "c", leader_score: 84, day_of_season: 40, percent_through: 55, latitude: null, longitude: null },
    { competition_slug: "a", competition_date: "2024-07-01", total_score: 78, rank: 3, leader_corps_key: "c", leader_score: 82, day_of_season: 30, percent_through: 40, latitude: null, longitude: null },
  ];
  const three = computeRollingFeatures(threeShows);
  assert(three.hasLastShow, "Three shows - hasLastShow should be true");
  assert(three.hasLast3, "Three shows - hasLast3 should be true");
  assert(three.lastScoreTotal === 85, "Last score should be 85");
  assertClose(three.avgLast3Total!, (85 + 82 + 78) / 3, 0.01, "Avg should be mean of 3");
  // Slope should be positive (scores increasing over time)
  assert(three.slopeLast3Total! > 0, "Slope should be positive (improving)");
}

function testComputeRankingsAsOf() {
  console.log("\n=== Testing computeRankingsAsOf ===");

  const bestSoFar: BestSoFarRow[] = [
    { corps_key: "blue-devils", best_total: 95 },
    { corps_key: "bluecoats", best_total: 92 },
    { corps_key: "carolina-crown", best_total: 90 },
  ];

  // Leader
  const leader = computeRankingsAsOf("blue-devils", bestSoFar);
  assert(leader.hasOverallRank, "Leader should have rank");
  assert(leader.overallRankAsOf === 1, "Leader should be rank 1");
  assert(leader.overallGapToLeader === 0, "Leader gap should be 0");

  // Third place
  const third = computeRankingsAsOf("carolina-crown", bestSoFar);
  assert(third.hasOverallRank, "Third should have rank");
  assert(third.overallRankAsOf === 3, "Third should be rank 3");
  assert(third.overallGapToLeader === 5, "Gap should be 5 points");

  // Unknown corps
  const unknown = computeRankingsAsOf("unknown-corps", bestSoFar);
  assert(!unknown.hasOverallRank, "Unknown corps should not have rank");
}

function testDaysBetween() {
  console.log("\n=== Testing daysBetween ===");

  const days1 = daysBetween("2024-07-01", "2024-07-10");
  assert(days1 === 9, "9 days between July 1 and July 10");

  const days2 = daysBetween("2024-06-15", "2024-07-15");
  assert(days2 === 30, "30 days between June 15 and July 15");
}

// ----- Integration Tests -----

async function testEnsureMlTables() {
  console.log("\n=== Testing ensureMlTables (Integration) ===");

  const SqlLayer = LibsqlClient.layer({ url: ":memory:" });

  try {
    await Effect.runPromise(
      ensureMlTables.pipe(Effect.provide(SqlLayer))
    );
    console.log("PASS: ensureMlTables completed without error");
  } catch (err) {
    console.error("FAIL: ensureMlTables threw error:", err);
  }
}

// ----- Main -----

async function main() {
  console.log("Running ML Tests\n");

  // Unit tests (no DB required)
  testBuildNumericVector();
  testComputeRollingFeatures();
  testComputeRankingsAsOf();
  testDaysBetween();

  // Integration tests (require libsql)
  await testEnsureMlTables();

  console.log("\n✓ All tests completed");
}

main().catch((err) => {
  console.error("Test suite failed:", err);
  process.exitCode = 1;
});
