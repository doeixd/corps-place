
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-cpu';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Config
const DB_PATH = './dci-relational.db';
const MODEL_DIR = './models/v4_trajectory';
const REFERENCE_CURVES_PATH = './src/training/referenceCurvesV4.json';

// Constants
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"];
const SEQ_LEN = 15;
const FEAT_DIM = 40;

// Load Reference Curves
const REF_CURVES = JSON.parse(fs.readFileSync(REFERENCE_CURVES_PATH, 'utf-8'));

async function main() {
  console.log("Evaluating V4 Model on Test Set (2024)...");

  // Custom IO Handler
  const handler = {
    load: async () => {
      const modelJson = JSON.parse(fs.readFileSync(MODEL_DIR + '/model.json', 'utf-8'));
      const weightsManifest = modelJson.weightsManifest;
      // Assume single weight file for simplicity
      const weightPath = weightsManifest[0].paths[0];
      const weightData = new Uint8Array(fs.readFileSync(MODEL_DIR + '/' + weightPath));

      return {
        modelTopology: modelJson.modelTopology,
        weightSpecs: weightsManifest[0].weights,
        weightData: weightData.buffer
      };
    }
  };

  const model = await tf.loadLayersModel(handler);
  console.log("Model loaded successfully.");

  // 2. Load Test Data
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare(`
    SELECT season, corps_key, competition_date, x_sequence_json, y_residuals_json, y_recap_json, split 
    FROM ml_sequence_rows_v4
    WHERE split = 'test'
    ORDER BY competition_date ASC
  `).all();

  console.log(`Loaded ${rows.length} test rows from 2024 season.`);

  // 3. Prepare Tensors (Reconstruct vocab)
  const allRows = db.prepare('SELECT season, corps_key FROM ml_sequence_rows_v4').all();
  const corpsSet = new Set<string>();
  const seasonSet = new Set<string>();
  allRows.forEach((r: any) => { corpsSet.add(r.corps_key); seasonSet.add(r.season); });

  const corpsList = Array.from(corpsSet).sort();
  const seasonList = Array.from(seasonSet).sort();
  const corpsMap = new Map(corpsList.map((c, i) => [c, i + 1]));
  const seasonMap = new Map(seasonList.map((s, i) => [s, i + 1]));

  const xSeq: number[][][] = [];
  const xCorps: number[] = [];
  const xSeason: number[] = [];

  rows.forEach((r: any) => {
    xSeq.push(JSON.parse(r.x_sequence_json));
    xCorps.push(corpsMap.get(r.corps_key) || 0);
    xSeason.push(seasonMap.get(r.season) || 0);
  });

  const tSeq = tf.tensor3d(xSeq, [rows.length, SEQ_LEN, FEAT_DIM]);
  const tCorps = tf.tensor2d(xCorps, [rows.length, 1]);
  const tSeason = tf.tensor2d(xSeason, [rows.length, 1]);

  // 4. Predict
  console.log("Running inference...");
  const predictions = model.predict([tSeq, tCorps, tSeason]) as tf.Tensor;
  const predsData = await predictions.array() as number[][];

  // 5. Analyze Results
  console.log("\nComparison: Predicted vs Actual (Total Score Only)");
  console.log("-------------------------------------------------------------");
  console.log("Date       Corps (Key)             Pred Tot   Act Tot   Diff");

  let totalAbsError = 0;
  let count = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as any;
    const yResid = JSON.parse(r.y_residuals_json);
    const yRecap = JSON.parse(r.y_recap_json);

    // Prediction vector: P50 estimates
    const p50s: Record<string, number> = {};
    CAPTIONS.forEach((cap, idx) => {
      const p50_residual = predsData[i][idx * 3 + 1];
      const actRaw = yRecap[cap] || 0;
      const actResid = yResid[cap] || 0;
      const predRaw = actRaw - actResid + p50_residual;
      p50s[cap] = predRaw;
    });

    // Simplified Summation
    const geTot = p50s["GE1"] + p50s["GE2"];
    const visTot = (p50s["VP"] + p50s["VA"] + p50s["CG"]) / 3.0 * 1.5;
    const musTot = (p50s["MB"] + p50s["MA"] + p50s["MP"]) / 3.0 * 1.5;
    let predTotal = geTot + (p50s["VP"] + p50s["VA"] + p50s["CG"]) / 2 + (p50s["MB"] + p50s["MA"] + p50s["MP"]) / 2;

    const actGe = (yRecap["GE1"] || 0) + (yRecap["GE2"] || 0);
    const actVis = ((yRecap["VP"] || 0) + (yRecap["VA"] || 0) + (yRecap["CG"] || 0)) / 2;
    const actMus = ((yRecap["MB"] || 0) + (yRecap["MA"] || 0) + (yRecap["MP"] || 0)) / 2;
    let actTotal = actGe + actVis + actMus;

    const diff = predTotal - actTotal;
    totalAbsError += Math.abs(diff);
    count++;

    if (i < 20) {
      console.log(`${r.competition_date.slice(5)}  ${r.corps_key.padEnd(20)}  ${predTotal.toFixed(2)}       ${actTotal.toFixed(2)}      ${diff > 0 ? '+' : ''}${diff.toFixed(2)}`);
    }
  }

  if (count > 0) {
    console.log("-------------------------------------------------------------");
    console.log(`Mean Absolute Error (Total Score): ${(totalAbsError / count).toFixed(3)}`);
  }
}

main().catch(console.error);
