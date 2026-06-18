// test/evaluateModel.ts
// Evaluate a trained model on test data from the database.
//
// Run with: npx tsx test/evaluateModel.ts --modelDir ./models/<model-dir> --season 2023

import Database from "better-sqlite3";
import { loadDciModel, type PredictInput } from "../src/training/loadModel.js";

// ----- Config -----

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };

  return {
    modelDir: get("--modelDir", "./models/latest"),
    season: get("--season", "2023"),
    dbPath: get("--db", "./dci-relational.db"),
  };
}

// ----- Main Program -----

async function main() {
  const args = parseArgs();
  console.log("Model Evaluation");
  console.log("================");
  console.log("Model Dir:", args.modelDir);
  console.log("Test Season:", args.season);
  console.log("");

  try {
    // Load the model
    console.log("Loading model...");
    const model = await loadDciModel(args.modelDir, {
      useJudges: true,
      maxJudges: 16,
      preferBackend: "tfjs",
    });
    console.log(`✓ Loaded model (backend: ${model.backend})`);

    // Load test data from database
    console.log(`\nLoading ${args.season} season data from database...`);
    const db = new Database(args.dbPath, { readonly: true });

    const rows = db.prepare(`
      SELECT
        corps_id,
        season_id,
        division_id,
        judge_ids_json,
        x_numeric_json,
        y_total,
        corps_key,
        competition_slug,
        pct_through_season
      FROM ml_training_rows
      WHERE season = ?
      ORDER BY competition_date, corps_key
    `).all(args.season) as any[];

    db.close();

    if (rows.length === 0) {
      console.log(`\n✗ No data found for season ${args.season}`);
      process.exitCode = 1;
      return;
    }

    console.log(`✓ Loaded ${rows.length} rows`);

    // Convert to PredictInput format
    console.log("\nRunning predictions...");
    const inputs: PredictInput[] = rows.map(row => ({
      corpsId: row.corps_id,
      seasonId: row.season_id,
      divisionId: row.division_id,
      judgeIds: row.judge_ids_json ? JSON.parse(row.judge_ids_json) : undefined,
      numeric: JSON.parse(row.x_numeric_json).reduce((acc: any, val: number, idx: number) => {
        const featureName = model.features.numericOrder[idx]?.name || `f_${idx}`;
        acc[featureName] = val;
        return acc;
      }, {}),
    }));

    const predictions = await model.predictBatch(inputs);

    // Calculate metrics
    const actuals = rows.map(r => r.y_total);
    const predicted = predictions.map(p => p.p50);

    const errors = actuals.map((actual, i) => Math.abs(actual - predicted[i]!));
    const squaredErrors = actuals.map((actual, i) => Math.pow(actual - predicted[i]!, 2));

    const mae = errors.reduce((sum, e) => sum + e, 0) / errors.length;
    const rmse = Math.sqrt(squaredErrors.reduce((sum, e) => sum + e, 0) / squaredErrors.length);
    const maxError = Math.max(...errors);
    const minError = Math.min(...errors);

    // Display results
    console.log("\nEvaluation Metrics:");
    console.log("-------------------");
    console.table({
      "Mean Absolute Error (MAE)": mae.toFixed(3),
      "Root Mean Squared Error (RMSE)": rmse.toFixed(3),
      "Max Error": maxError.toFixed(3),
      "Min Error": minError.toFixed(3),
      "Number of Predictions": rows.length,
    });

    // Show some example predictions
    console.log("\nSample Predictions (first 10):");
    console.log("-------------------------------");
    const samples = rows.slice(0, 10).map((row, i) => ({
      Corps: row.corps_key,
      Competition: row.competition_slug.substring(0, 20),
      Actual: actuals[i]!.toFixed(2),
      Predicted: predicted[i]!.toFixed(2),
      Error: errors[i]!.toFixed(2),
    }));
    console.table(samples);

    // Cleanup
    model.dispose();
    console.log("\n✓ Evaluation completed successfully");
  } catch (err) {
    console.error("\n✗ Evaluation failed:", err);
    process.exitCode = 1;
  }
}

main();
