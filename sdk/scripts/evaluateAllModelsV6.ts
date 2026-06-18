import * as tf from "@tensorflow/tfjs-node";
import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";

const DB_PATH = "./dci-relational.db";
const MODEL_DIR = "./models/v6_multitask";
const NORM_PATH = "./results/v6-target-norm.json";
const RESULTS_JSON = "./results/model-evaluation-v6.json";
const RESULTS_MD = "./results/model-comparison-v6.md";

const SEQ_LEN = 15;
const FEAT_DIM = 57;
const STATIC_DIM = 53;
const PADDING_INDEX = 3;

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const CAPTION_COUNT = CAPTIONS.length;
const RESIDUAL_DIM = CAPTION_COUNT * 3;
const RECAP_DIM = CAPTION_COUNT;
const TOTAL_DIM = 1;

type DataRow = {
  seq: number[][];
  stat: number[];
  residuals: number[];
  recap: number[];
  total: number;
};

type TargetStats = {
  residualMean: number[];
  residualStd: number[];
  recapMean: number[];
  recapStd: number[];
  totalMean: number;
  totalStd: number;
};

const normalizeValue = (value: number, mean: number, std: number) => (std > 1e-6 ? (value - mean) / std : 0);
const denormalizeValue = (value: number, mean: number, std: number) => value * (std > 1e-6 ? std : 1) + mean;

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const rmse = (errors: number[]) => Math.sqrt(mean(errors.map((value) => value * value)));

function buildRows(rows: Array<{ x_sequence_json: string; x_static_json: string; y_residuals_json: string; y_recap_json: string }>): DataRow[] {
  const dataRows: DataRow[] = [];
  for (const row of rows) {
    const rawSeq = JSON.parse(row.x_sequence_json) as number[][];
    const seq = rawSeq.map((step) => (step[PADDING_INDEX] === 1 ? new Array(FEAT_DIM).fill(0) : step));
    const stat = JSON.parse(row.x_static_json) as number[];
    const resids = JSON.parse(row.y_residuals_json) as Record<string, number>;
    const recap = JSON.parse(row.y_recap_json) as Record<string, number>;

    if (seq.length !== SEQ_LEN || seq[0]?.length !== FEAT_DIM) continue;
    if (stat.length !== STATIC_DIM) continue;

    const residuals: number[] = [];
    const recapValues: number[] = [];
    let total = 0;
    for (const caption of CAPTIONS) {
      const residual = resids[caption] ?? 0;
      const recapValue = recap[caption] ?? 0;
      residuals.push(residual);
      recapValues.push(recapValue);
      total += recapValue;
    }

    dataRows.push({ seq, stat, residuals, recap: recapValues, total });
  }

  return dataRows;
}

async function main() {
  if (!fs.existsSync(NORM_PATH)) {
    throw new Error(`Missing normalization file at ${NORM_PATH}`);
  }
  const stats = JSON.parse(fs.readFileSync(NORM_PATH, "utf-8")) as TargetStats;

  const client = createClient({ url: `file:${DB_PATH}` });
  const result = await client.execute(`
    SELECT x_sequence_json, x_static_json, y_residuals_json, y_recap_json, split
    FROM ml_sequence_rows_v5
    WHERE split = 'val'
  `);
  client.close();

  const rows = result.rows as unknown as Array<{
    x_sequence_json: string;
    x_static_json: string;
    y_residuals_json: string;
    y_recap_json: string;
    split: string;
  }>;

  const dataRows = buildRows(rows);
  if (!dataRows.length) throw new Error("No validation rows found.");

  const xSeq = tf.tensor3d(
    dataRows.map((row) => row.seq),
    [dataRows.length, SEQ_LEN, FEAT_DIM]
  );
  const xStat = tf.tensor2d(
    dataRows.map((row) => row.stat),
    [dataRows.length, STATIC_DIM]
  );

  const modelPath = `file://${path.resolve(MODEL_DIR, "model.json")}`;
  const model = await tf.loadLayersModel(modelPath);

  const preds = model.predict([xSeq, xStat]) as tf.Tensor;
  const predArray = (await preds.array()) as number[][];

  const residualErrors: number[] = [];
  const recapErrorsByCaption = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const totalErrors: number[] = [];
  const consistencyErrors: number[] = [];

  predArray.forEach((pred, idx) => {
    const row = dataRows[idx]!;
    const residualPredNorm = pred.slice(0, RESIDUAL_DIM);
    const recapPredNorm = pred.slice(RESIDUAL_DIM, RESIDUAL_DIM + RECAP_DIM);
    const totalPredNorm = pred[RESIDUAL_DIM + RECAP_DIM] ?? 0;

    for (let capIdx = 0; capIdx < CAPTION_COUNT; capIdx++) {
      const predResidualNorm = residualPredNorm[CAPTION_COUNT + capIdx] ?? 0;
      const predResidual = denormalizeValue(predResidualNorm, stats.residualMean[capIdx]!, stats.residualStd[capIdx]!);
      residualErrors.push(predResidual - row.residuals[capIdx]!);

      const predRecap = denormalizeValue(recapPredNorm[capIdx] ?? 0, stats.recapMean[capIdx]!, stats.recapStd[capIdx]!);
      recapErrorsByCaption[capIdx]!.push(predRecap - row.recap[capIdx]!);
    }

    const totalPred = denormalizeValue(totalPredNorm, stats.totalMean, stats.totalStd);
    totalErrors.push(totalPred - row.total);

    const recapSum = recapPredNorm.reduce((sum, value, capIdx) => {
      const denorm = denormalizeValue(value ?? 0, stats.recapMean[capIdx]!, stats.recapStd[capIdx]!);
      return sum + denorm;
    }, 0);
    consistencyErrors.push(recapSum - totalPred);
  });

  const recapMAEByCaption: Record<string, number> = {};
  recapErrorsByCaption.forEach((errors, idx) => {
    recapMAEByCaption[CAPTIONS[idx]!] = mean(errors.map((value) => Math.abs(value)));
  });

  const results = {
    residual: {
      mae: mean(residualErrors.map((value) => Math.abs(value))),
      rmse: rmse(residualErrors),
    },
    recap: {
      maeByCaption: recapMAEByCaption,
      maeOverall: mean(Object.values(recapMAEByCaption)),
    },
    total: {
      mae: mean(totalErrors.map((value) => Math.abs(value))),
      rmse: rmse(totalErrors),
    },
    consistency: {
      mae: mean(consistencyErrors.map((value) => Math.abs(value))),
    },
  };

  fs.writeFileSync(RESULTS_JSON, JSON.stringify(results, null, 2));

  let md = "# Model Comparison - V6\n\n";
  md += "## Residual Metrics (p50)\n\n";
  md += `- MAE: ${results.residual.mae.toFixed(4)}\n`;
  md += `- RMSE: ${results.residual.rmse.toFixed(4)}\n\n`;

  md += "## Recap Metrics\n\n";
  md += `- Overall MAE: ${results.recap.maeOverall.toFixed(4)}\n`;
  md += "- Per-caption MAE:\n";
  for (const caption of CAPTIONS) {
    md += `  - ${caption}: ${results.recap.maeByCaption[caption].toFixed(4)}\n`;
  }

  md += "\n## Total Metrics\n\n";
  md += `- MAE: ${results.total.mae.toFixed(4)}\n`;
  md += `- RMSE: ${results.total.rmse.toFixed(4)}\n\n`;

  md += "## Consistency (|sum recap - total|)\n\n";
  md += `- MAE: ${results.consistency.mae.toFixed(4)}\n`;

  fs.writeFileSync(RESULTS_MD, md);

  console.log(`Saved evaluation to ${RESULTS_JSON}`);
  console.log(`Saved markdown to ${RESULTS_MD}`);

  tf.dispose([xSeq, xStat, preds]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
