// src/training/evaluateV2.ts
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";

const TARGET_CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"];
const NUM_QUANTILES = 3;

async function main() {
  const modelDir = process.argv[2];
  if (!modelDir) {
    console.error("Usage: npx tsx src/training/evaluateV2.ts <model_dir>");
    process.exit(1);
  }

  console.log(`Evaluating model from: ${modelDir}`);

  // 1. Load Model
  const model = await tf.loadLayersModel(`file://${path.join(modelDir, "model.json")}`);
  const normStats = JSON.parse(fs.readFileSync(path.join(modelDir, "numeric_norm.json"), "utf8"));

  // 2. Load Test Data
  const db = new Database("./dci-relational.db", { readonly: true });
  const rows = db.prepare(`
    SELECT x_numeric_json, y_recap_json, corps_id, season_id, division_id, judge_ids_json
    FROM ml_training_rows
    WHERE split = 'test' AND y_recap_json IS NOT NULL
  `).all() as any[];
  db.close();

  console.log(`Loaded ${rows.length} test examples.`);

  // 3. Prepare Tensors
  const xNumeric = rows.map(r => JSON.parse(r.x_numeric_json));
  const xNorm = xNumeric.map(row => row.map((v: number, j: number) => (v - normStats.mean[j]) / (normStats.std[j] || 1)));

  const inputs: tf.Tensor[] = [
    tf.tensor2d(xNorm),
    tf.tensor2d(rows.map(r => [r.corps_id]), [rows.length, 1], "int32"),
    tf.tensor2d(rows.map(r => [r.season_id]), [rows.length, 1], "int32"),
    tf.tensor2d(rows.map(r => [r.division_id]), [rows.length, 1], "int32")
  ];

  const judgeIdsJson = rows[0]?.judge_ids_json;
  if (judgeIdsJson) {
    const judgeIds = rows.map(r => {
      const ids = JSON.parse(r.judge_ids_json || "[]");
      const padded = ids.slice(0, 16);
      while (padded.length < 16) padded.push(0);
      return padded;
    });
    inputs.push(tf.tensor2d(judgeIds, [judgeIds.length, 16], "int32"));
  }

  // 4. Predict
  const predictions = model.predict(inputs) as tf.Tensor;
  const predData = await predictions.array() as number[][]; // [batch, 24]

  // 5. Compute MAE per caption
  const captionMaes: Record<string, number> = {};
  const captionRmses: Record<string, number> = {};
  const coverageP10P90: Record<string, number> = {};

  for (let c = 0; c < TARGET_CAPTIONS.length; c++) {
    const caption = TARGET_CAPTIONS[c]!;
    let totalError = 0;
    let totalSqError = 0;
    let coveredCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const groundTruthMap = JSON.parse(rows[i].y_recap_json);
      const actual = groundTruthMap[caption] ?? 0;

      const p10 = predData[i]![c * 3 + 0]!;
      const p50 = predData[i]![c * 3 + 1]!;
      const p90 = predData[i]![c * 3 + 2]!;

      totalError += Math.abs(actual - p50);
      totalSqError += (actual - p50) ** 2;

      if (actual >= p10 && actual <= p90) {
        coveredCount++;
      }
    }

    captionMaes[caption] = totalError / rows.length;
    captionRmses[caption] = Math.sqrt(totalSqError / rows.length);
    coverageP10P90[caption] = coveredCount / rows.length;
  }

  // 6. Results
  console.log("\n--- V2 Model Evaluation (Test Set) ---");
  console.table(TARGET_CAPTIONS.map(caption => ({
    Caption: caption,
    MAE: captionMaes[caption]?.toFixed(4),
    RMSE: captionRmses[caption]?.toFixed(4),
    "Coverage (P10-P90)": (coverageP10P90[caption]! * 100).toFixed(1) + "%"
  })));

  const avgMae = Object.values(captionMaes).reduce((a, b) => a + b, 0) / TARGET_CAPTIONS.length;
  console.log(`\nAverage Per-Caption MAE: ${avgMae.toFixed(4)}`);
}

main().catch(console.error);
