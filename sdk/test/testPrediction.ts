// test/testPrediction.ts
// End-to-end test for model loading and prediction.
//
// Run with: npx tsx test/testPrediction.ts --modelDir ./models/<model-dir>
//
// This script tests:
// 1. Loading a trained model
// 2. Building features for sample corps
// 3. Running predictions
// 4. Ranking by predicted scores

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { loadDciModel, type PredictInput } from "../src/training/loadModel.js";
import { MlApi, makeMlApi } from "../src/mlService.js";

// ----- Config -----

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };

  return {
    modelDir: get("--modelDir", "./models/latest"),
    dbUrl: `file:${get("--db", "./dci-relational.db")}`,
  };
}

// ----- Sample Data -----

const SAMPLE_ENTRIES: PredictInput[] = [
  {
    corpsId: 1,  // Blue Devils
    seasonId: 1,
    divisionId: 1,
    judgeIds: [1, 2, 3, 4, 5],  // Sample judge IDs
    numeric: {
      percentageThroughSeason: 80,
      dayOfSeason: 45,
      showOfSeason: 8,
      corpsCountInClass: 15,
      daysSinceLastShow: 3,
      lastScoreTotal: 92.5,
      avgLast3Total: 91.0,
      slopeLast3Total: 0.8,
      overallRankAsOf: 1,
      gapToLeaderOverall: 0,
    },
  },
  {
    corpsId: 2,  // Bluecoats
    seasonId: 1,
    divisionId: 1,
    judgeIds: [1, 2, 3, 4, 5],
    numeric: {
      percentageThroughSeason: 80,
      dayOfSeason: 45,
      showOfSeason: 7,
      corpsCountInClass: 15,
      daysSinceLastShow: 5,
      lastScoreTotal: 90.8,
      avgLast3Total: 89.5,
      slopeLast3Total: 0.6,
      overallRankAsOf: 2,
      gapToLeaderOverall: 1.7,
    },
  },
  {
    corpsId: 3,  // Carolina Crown
    seasonId: 1,
    divisionId: 1,
    judgeIds: [1, 2, 3, 4, 5],
    numeric: {
      percentageThroughSeason: 80,
      dayOfSeason: 45,
      showOfSeason: 8,
      corpsCountInClass: 15,
      daysSinceLastShow: 3,
      lastScoreTotal: 89.5,
      avgLast3Total: 88.2,
      slopeLast3Total: 0.9,
      overallRankAsOf: 3,
      gapToLeaderOverall: 3.0,
    },
  },
];

const CORPS_NAMES: Record<number, string> = {
  1: "Blue Devils",
  2: "Bluecoats",
  3: "Carolina Crown",
};

// ----- Test Program -----

async function main() {
  const args = parseArgs();
  console.log("Test Prediction");
  console.log("================");
  console.log("Model Dir:", args.modelDir);
  console.log("");

  try {
    // Load the model
    console.log("Loading model...");
    const model = await loadDciModel(args.modelDir, {
      useJudges: true,
      maxJudges: 16,
      preferBackend: "onnx",
    });
    console.log(`✓ Loaded model (backend: ${model.backend})`);

    // Run predictions
    console.log("\nRunning predictions...");
    const predictions = await model.predictBatch(SAMPLE_ENTRIES);

    // Display results
    console.log("\nPrediction Results:");
    console.log("-------------------");

    const ranked = SAMPLE_ENTRIES
      .map((entry, i) => ({
        corpsName: CORPS_NAMES[entry.corpsId] ?? `Corps ${entry.corpsId}`,
        ...predictions[i]!,
      }))
      .sort((a, b) => b.p50 - a.p50);

    console.table(
      ranked.map((r, idx) => ({
        Rank: idx + 1,
        Corps: r.corpsName,
        "P10 (Low)": r.p10.toFixed(2),
        "P50 (Median)": r.p50.toFixed(2),
        "P90 (High)": r.p90.toFixed(2),
      }))
    );

    // Cleanup
    model.dispose();
    console.log("\n✓ Test completed successfully");
  } catch (err) {
    console.error("\n✗ Test failed:", err);
    console.log("\nNote: This test requires a trained model in the specified directory.");
    console.log("Run training first or provide a valid --modelDir path.");
    process.exitCode = 1;
  }
}

main();
