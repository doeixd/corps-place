// src/training/trainModelV2.ts
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";
import { z } from "zod";

// -----------------------------
// Constants & Types
// -----------------------------

const TARGET_CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"];
const NUM_QUANTILES = 3; // p10, p50, p90

// These should match buildMlRows.ts DEFAULT_FEATURE_SPEC
const FEATURE_NAMES = [
  "percentageThroughSeason", "dayOfSeason", "showOfSeason", "performanceOrderInClass", "corpsCountInClass",
  "daysSinceLastShow", "lastTotalScore", "lastGapToLeaderTotal", "avgLast3GapTotal", "overallRankAsOf", "gapToLeaderOverall",
  "avgFieldRank", "isFinals", "isRegional",
  "refScoreAtRankAndPercent",
  "prevSeasonRankAsOf", "prevSeasonGapToLeader", "gapToSeasonHigh", "lastResidualToBaseline",
  ...["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"].flatMap(c => [
    `lastGap_${c}`, `lastRank_${c}`, `lastScore_${c}`
  ]),
  "lastContentRank_Perc", "lastAchievementRank_Perc",
  "hasLastShow", "hasLast3", "hasOverallRank", "hasPrevSeasonData", "hasWeather", "hasJudgeInfo",
  ...["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"].map(c => `hasLast_${c}`)
];

type Args = {
  db: string;
  out: string;
  runTag: string;
  maxJudges: number;
  useJudges: boolean;
  epochs: number;
  batchSize: number;
  patience: number;
  learningRate: number;
  l2: number;
  dropout: number;
  embeddingDropout: number;
  numericDropout: number;
  rankLossWeight: number;
  totalScoreWeight: number;
  momentumMaskRate: number; // probability of zeroing out momentum features during training
};

// -----------------------------
// Helpers
// -----------------------------

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safeJsonNumbers(s: string): number[] {
  return JSON.parse(s).map(Number);
}

function safeJsonMap(s: string): Record<string, number> {
  try {
    return JSON.parse(s);
  } catch (e) {
    return {};
  }
}

// -----------------------------
// Data Loading
// -----------------------------

const RowSchema = z.object({
  split: z.enum(["train", "val", "test"]),
  x_numeric_json: z.string(),
  corps_id: z.number().int().nonnegative(),
  season_id: z.number().int().nonnegative(),
  division_id: z.number().int().nonnegative(),
  judge_ids_json: z.string().optional().nullable(),
  y_residuals_json: z.string().optional().nullable(),
  y_recap_json: z.string().optional().nullable(),
  sample_weight: z.number().nullable().optional(),
});

type DBRow = z.infer<typeof RowSchema>;

const LOAD_SQL = `
  SELECT split, x_numeric_json, corps_id, season_id, division_id, judge_ids_json, y_residuals_json, y_recap_json, sample_weight
  FROM ml_training_rows
  WHERE y_residuals_json IS NOT NULL
`;

type Dataset = {
  xNumeric: number[][];
  corpsId: number[];
  seasonId: number[];
  divisionId: number[];
  judgeIds?: number[][];
  yResiduals: number[][]; // [batch, 8]
  yRecap: number[][];     // [batch, 8] - used for final ranking validation
  weight: number[];
};

function toDataset(rows: DBRow[], maxJudges: number, useJudges: boolean, momentumMaskRate: number = 0): Dataset {
  const ds: Dataset = { xNumeric: [], corpsId: [], seasonId: [], divisionId: [], judgeIds: useJudges ? [] : undefined, yResiduals: [], yRecap: [], weight: [] };

  const momentumIdx = FEATURE_NAMES.indexOf("lastResidualToBaseline");
  const lastTotalIdx = FEATURE_NAMES.indexOf("lastTotalScore");
  const scoreIndices = TARGET_CAPTIONS.map(c => FEATURE_NAMES.indexOf(`lastScore_${c}`));

  for (const r of rows) {
    const residualsMap = safeJsonMap(r.y_residuals_json || "{}");
    const recapMap = safeJsonMap(r.y_recap_json || "{}");
    const residualsVector = TARGET_CAPTIONS.map(c => residualsMap[c] ?? 0);
    const recapVector = TARGET_CAPTIONS.map(c => recapMap[c] ?? 0);

    // Filter out all-zero recaps (likely missing data/noise)
    if (residualsVector.every(v => v === 0)) continue;

    const x = safeJsonNumbers(r.x_numeric_json);
    if (x.length !== FEATURE_NAMES.length) {
      console.warn(`Feature mismatch: expected ${FEATURE_NAMES.length}, got ${x.length}`);
      continue;
    }

    // MOMENTUM MASKING: 
    // Randomly zero out the 'Season Momentum' feature during training 
    // to force the model to learn relative gaps too.
    if (momentumMaskRate > 0 && Math.random() < momentumMaskRate && r.split === "train" && momentumIdx !== -1) {
      x[momentumIdx] = 0;
    }

    // 70% PROVISIONING (30% MASKING) for absolute subcaption scores and total score
    if (Math.random() < 0.3 && r.split === "train") {
      if (lastTotalIdx !== -1) x[lastTotalIdx] = 0;
      for (const idx of scoreIndices) {
        if (idx !== -1) x[idx] = 0;
      }
    }

    ds.xNumeric.push(x);
    ds.corpsId.push(r.corps_id);
    ds.seasonId.push(r.season_id);
    ds.divisionId.push(r.division_id);

    if (useJudges && ds.judgeIds) {
      const ids = r.judge_ids_json ? safeJsonNumbers(r.judge_ids_json) : [];
      const padded = ids.slice(0, maxJudges);
      while (padded.length < maxJudges) padded.push(0);
      ds.judgeIds.push(padded);
    }

    ds.yResiduals.push(residualsVector);
    ds.yRecap.push(recapVector);
    ds.weight.push(r.sample_weight ?? 1.0);
  }

  return ds;
}

// -----------------------------
// Normalization
// -----------------------------

type NormStats = { mean: number[]; std: number[] };

function computeNormStats(x: number[][]): NormStats {
  const d = x[0]!.length;
  const n = x.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of x) for (let j = 0; j < d; j++) mean[j] += row[j]!;
  for (let j = 0; j < d; j++) mean[j] /= n;
  for (const row of x) for (let j = 0; j < d; j++) std[j] += (row[j]! - mean[j]!) ** 2;
  for (let j = 0; j < d; j++) {
    std[j] = Math.sqrt(std[j] / Math.max(1, n - 1));
    if (std[j] === 0) std[j] = 1;
  }
  return { mean, std };
}

function applyNorm(x: number[][], stats: NormStats): number[][] {
  return x.map(row => row.map((v, j) => (v - stats.mean[j]!) / stats.std[j]!));
}

// -----------------------------
// Model Build
// -----------------------------

function buildModelV2(cfg: any): tf.LayersModel {
  const reg = tf.regularizers.l2({ l2: cfg.l2 });
  const numericIn = tf.input({ shape: [cfg.numNumeric], name: "x_numeric" });
  const corpsIn = tf.input({ shape: [1], dtype: "int32", name: "corps_id" });
  const seasonIn = tf.input({ shape: [1], dtype: "int32", name: "season_id" });
  const divisionIn = tf.input({ shape: [1], dtype: "int32", name: "division_id" });

  const corpsEmb = tf.layers.embedding({ inputDim: cfg.corpsVocab, outputDim: 12, embeddingsRegularizer: reg }).apply(corpsIn);
  const seasonEmb = tf.layers.embedding({ inputDim: cfg.seasonVocab, outputDim: 6, embeddingsRegularizer: reg }).apply(seasonIn);
  const divisionEmb = tf.layers.embedding({ inputDim: cfg.divisionVocab, outputDim: 4, embeddingsRegularizer: reg }).apply(divisionIn);

  let features = [
    tf.layers.dropout({ rate: cfg.numericDropout }).apply(numericIn) as tf.SymbolicTensor,
    tf.layers.flatten().apply(corpsEmb) as tf.SymbolicTensor,
    tf.layers.flatten().apply(seasonEmb) as tf.SymbolicTensor,
    tf.layers.flatten().apply(divisionEmb) as tf.SymbolicTensor,
  ];

  let inputs = [numericIn, corpsIn as tf.SymbolicTensor, seasonIn as tf.SymbolicTensor, divisionIn as tf.SymbolicTensor];

  if (cfg.useJudges) {
    const judgeIn = tf.input({ shape: [cfg.maxJudges], dtype: "int32", name: "judge_ids" });
    const judgeEmb = tf.layers.embedding({ inputDim: cfg.judgeVocab, outputDim: 12, embeddingsRegularizer: reg }).apply(judgeIn);
    const judgePooled = tf.layers.globalAveragePooling1d().apply(judgeEmb) as tf.SymbolicTensor;
    inputs.push(judgeIn as tf.SymbolicTensor);
    features.push(judgePooled);
  }

  const combined = tf.layers.concatenate().apply(features) as tf.SymbolicTensor;
  const h1 = tf.layers.dense({ units: 256, activation: "relu", kernelRegularizer: reg }).apply(combined) as tf.SymbolicTensor;
  const d1 = tf.layers.dropout({ rate: cfg.dropout }).apply(h1) as tf.SymbolicTensor;
  const h2 = tf.layers.dense({ units: 128, activation: "relu", kernelRegularizer: reg }).apply(d1) as tf.SymbolicTensor;
  const d2 = tf.layers.dropout({ rate: cfg.dropout }).apply(h2) as tf.SymbolicTensor;
  const out = tf.layers.dense({ units: TARGET_CAPTIONS.length * NUM_QUANTILES, name: "y_quantiles" }).apply(d2) as tf.SymbolicTensor;

  return tf.model({ inputs, outputs: out });
}

function multiQuantileLoss(qs: number[]) {
  const qT = tf.tensor1d(qs, "float32");
  return (yTrue: tf.Tensor, yPred: tf.Tensor) => tf.tidy(() => {
    const e = tf.sub(yTrue, yPred);
    return tf.mean(tf.maximum(tf.mul(qT, e), tf.mul(tf.sub(qT, 1), e)));
  });
}

/**
 * Pairwise Ranking Loss + Quantile Loss + Total Score Loss.
 * Penalizes ranking errors, quantile errors, and deviations from the weighted total score.
 */
function combinedModelLoss(qs: number[], rankWeight: number, totalWeight: number) {
  const pinball = multiQuantileLoss(qs);
  // DCI Weights: GE (index 0,1) count 1.0, Viz/Mus (index 2-7) count 0.5
  const dciWeights = tf.tensor1d([1.0, 1.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);

  return (yTrue: tf.Tensor, yPred: tf.Tensor) => tf.tidy(() => {
    const pLoss = pinball(yTrue, yPred);

    // Reshape to [batch, 8, 3] to get P10, P50, P90 for each caption
    const yPred3 = yPred.reshape([-1, 8, 3]);
    const yTrue3 = yTrue.reshape([-1, 8, 3]);

    // Extract P50 (index 1)
    const yPredP50 = yPred3.gather(tf.tensor1d([1], 'int32'), 2).squeeze([2]); // [batch, 8]
    const yTrueP50 = yTrue3.gather(tf.tensor1d([1], 'int32'), 2).squeeze([2]); // [batch, 8]

    // 1. Ranking Loss (Pairwise)
    let rLoss = tf.scalar(0);
    if (rankWeight > 0) {
      const diffActual = tf.sub(yTrueP50.expandDims(0), yTrueP50.expandDims(1)); // [batch, batch, 8]
      const diffPred = tf.sub(yPredP50.expandDims(0), yPredP50.expandDims(1));   // [batch, batch, 8]
      const mask = tf.greater(diffActual, 0.1);
      const rankPenalty = tf.log(tf.add(1, tf.exp(tf.neg(diffPred))));
      rLoss = tf.mean(tf.where(mask, rankPenalty, tf.zerosLike(rankPenalty)));
    }

    // 2. Total Score Loss (MSE on the weighted sum of P50s)
    let tLoss = tf.scalar(0);
    if (totalWeight > 0) {
      const predTotal = tf.sum(tf.mul(yPredP50, dciWeights), 1); // [batch]
      const trueTotal = tf.sum(tf.mul(yTrueP50, dciWeights), 1); // [batch]
      tLoss = tf.losses.meanSquaredError(trueTotal, predTotal);
    }

    return tf.add(tf.add(pLoss, tf.mul(rankWeight, rLoss)), tf.mul(totalWeight, tLoss));
  });
}

function makeTensors(ds: Dataset, stats: NormStats, useJudges: boolean) {
  const n = ds.yResiduals.length;
  if (n === 0) throw new Error("Dataset is empty");

  const inputs = [
    tf.tensor2d(applyNorm(ds.xNumeric, stats), [n, ds.xNumeric[0]!.length]),
    tf.tensor2d(ds.corpsId.map(v => [v]), [n, 1], "int32"),
    tf.tensor2d(ds.seasonId.map(v => [v]), [n, 1], "int32"),
    tf.tensor2d(ds.divisionId.map(v => [v]), [n, 1], "int32"),
  ];
  if (useJudges && ds.judgeIds) inputs.push(tf.tensor2d(ds.judgeIds, [n, ds.judgeIds[0]!.length], "int32"));

  const yTrue = tf.tidy(() => {
    const base = tf.tensor2d(ds.yResiduals, [n, TARGET_CAPTIONS.length]);
    return base.expandDims(-1).tile([1, 1, 3]).reshape([n, 24]);
  });
  return { inputs, yTrue };
}

// -----------------------------
// Logger
// -----------------------------

const REF_CURS = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src/training/referenceCurvesPercent.json"), "utf8"));
function getRef(rank: number, percent: number): number {
  const bucket = Math.floor(percent / 5) * 5;
  return REF_CURS[`${rank}-${bucket}`] ?? REF_CURS[`${rank}-${bucket - 5}`] ?? REF_CURS[`${rank}-100`] ?? 70;
}

class ProgressLogger extends tf.Callback {
  private finalsTensors: tf.Tensor[];
  private rawFinalsX: number[][];
  private corpsNames: string[];

  constructor(finalsDs: Dataset, corpsNames: string[], stats: NormStats, useJudges: boolean) {
    super();
    this.corpsNames = corpsNames;
    this.rawFinalsX = finalsDs.xNumeric;
    const { inputs } = makeTensors(finalsDs, stats, useJudges);
    this.finalsTensors = inputs;
  }

  override async onBatchEnd(batch: number, logs?: tf.Logs) {
    if (batch % 10 === 0) process.stdout.write(".");
  }

  override async onEpochEnd(epoch: number, logs?: tf.Logs) {
    const loss = logs?.loss?.toFixed(4) ?? "???";
    const valLoss = logs?.val_loss?.toFixed(4) ?? "???";
    process.stdout.write(` Done. Loss: ${loss}, ValLoss: ${valLoss}\n`);

    tf.tidy(() => {
      const preds = this.model!.predict(this.finalsTensors) as tf.Tensor;
      const data = preds.arraySync() as number[][];

      const results = data.map((row, i) => {
        const feat = this.rawFinalsX[i]!;
        const pct = feat[0]!; // percentageThroughSeason
        const lastRank = feat[8]!; // overallRankAsOf

        const baseTotal = getRef(Math.round(lastRank) || 12, pct);
        const baseCaption = baseTotal / 5.0;

        const reconstructed: number[] = [];
        for (let c = 0; c < TARGET_CAPTIONS.length; c++) {
          const predictedResidual = row[c * 3 + 1]!; // P50
          reconstructed.push(baseCaption + predictedResidual);
        }

        const ge = reconstructed[0]! + reconstructed[1]!;
        const viz = (reconstructed[2]! + reconstructed[3]! + reconstructed[4]!) * 0.5;
        const mus = (reconstructed[5]! + reconstructed[6]! + reconstructed[7]!) * 0.5;
        const tot = ge + viz + mus;

        // Total predicted "patch" relative to baseline
        const patch = tot - baseTotal;

        return { name: this.corpsNames[i], ge, viz, mus, tot, patch };
      });

      results.sort((a, b) => b.tot - a.tot);

      console.log(`\n--- Predicted 2024 Finals (Epoch ${epoch}) ---`);
      console.log("+------+---------------------------+-------+-------+-------+-------+-------+");
      console.log("| Rank | Corps                     | GE    | Viz   | Music | Total | Patch |");
      console.log("+------+---------------------------+-------+-------+-------+-------+-------+");
      results.forEach((r, idx) => {
        console.log(`| ${(idx + 1).toString().padEnd(4)} | ${r.name!.padEnd(25)} | ${r.ge.toFixed(2).padStart(5)} | ${r.viz.toFixed(2).padStart(5)} | ${r.mus.toFixed(2).padStart(5)} | ${r.tot.toFixed(2).padStart(5)} | ${r.patch.toFixed(2).padStart(5)} |`);
      });
      console.log("+------+---------------------------+-------+-------+-------+-------+-------+");
      console.log(" (Patch = Reconstructed Prediction minus historical Rank-Week baseline)\n");
    });
  }
}

// -----------------------------
// MAIN
// -----------------------------

async function main() {
  const args: Args = {
    db: "./dci-relational.db",
    out: "./models/v2",
    runTag: "v2-dynamic",
    maxJudges: 16,
    useJudges: true,
    epochs: 100,
    batchSize: 128,
    patience: 15,
    learningRate: 0.0005,
    l2: 0.0001,
    dropout: 0.2,
    embeddingDropout: 0.1,
    numericDropout: 0.0,
    rankLossWeight: 0.5,
    totalScoreWeight: 1.0,
    momentumMaskRate: 0.4 // 40% of the time, model must survive without absolute score anchor
  };
  ensureDir(args.out);
  const db = new Database(args.db, { readonly: true });
  const rows = db.prepare(LOAD_SQL).all() as DBRow[];
  const finalsRows = db.prepare(`SELECT r.*, c.name FROM ml_training_rows r JOIN corps c ON r.corps_key = c.corps_key WHERE r.competition_slug = '2024-dci-world-championship-finals' ORDER BY r.y_total DESC`).all() as any[];
  db.close();

  console.log(`Loading dataset (v2.2 Dynamic Calibration)...`);
  const trainDs = toDataset(rows.filter(r => r.split === "train"), args.maxJudges, args.useJudges, args.momentumMaskRate);
  const valDs = toDataset(rows.filter(r => r.split === "val"), args.maxJudges, args.useJudges, 0); // Always give validation full context
  const finalsDs = toDataset(finalsRows, args.maxJudges, args.useJudges, 0); // Inference ALWAYS has full context
  const finalsNames = finalsRows.map(r => r.name);

  console.log(`Dataset stats: Train=${trainDs.yResiduals.length}, Val=${valDs.yResiduals.length}`);
  const norm = computeNormStats(trainDs.xNumeric);
  const trainT = makeTensors(trainDs, norm, args.useJudges);
  const valT = makeTensors(valDs, norm, args.useJudges);

  const allRows = [...rows, ...finalsRows];
  const corpsVocab = Math.max(...allRows.map(r => r.corps_id)) + 1;
  const seasonVocab = Math.max(...allRows.map(r => r.season_id)) + 1;
  const divisionVocab = Math.max(...allRows.map(r => r.division_id)) + 1;

  let maxJudgeId = 1000;
  allRows.forEach(r => {
    if (r.judge_ids_json) {
      const ids = safeJsonNumbers(r.judge_ids_json);
      if (ids.length > 0) maxJudgeId = Math.max(maxJudgeId, ...ids);
    }
  });
  const judgeVocab = maxJudgeId + 1;

  const model = buildModelV2({
    numNumeric: trainDs.xNumeric[0]!.length,
    corpsVocab,
    seasonVocab,
    divisionVocab,
    judgeVocab,
    maxJudges: args.maxJudges,
    useJudges: args.useJudges,
    l2: args.l2,
    dropout: args.dropout,
    embeddingDropout: args.embeddingDropout,
    numericDropout: args.numericDropout
  });

  const qList = Array.from({ length: 8 }, () => [0.1, 0.5, 0.9]).flat();
  model.compile({ optimizer: tf.train.adam(args.learningRate), loss: combinedModelLoss(qList, args.rankLossWeight, args.totalScoreWeight) });

  await model.fit(trainT.inputs, trainT.yTrue, {
    epochs: args.epochs,
    batchSize: args.batchSize,
    validationData: [valT.inputs, valT.yTrue],
    callbacks: [
      tf.callbacks.earlyStopping({ patience: args.patience }),
      new ProgressLogger(finalsDs, finalsNames, norm, args.useJudges)
    ],
    verbose: 0
  });

  const modelDir = path.join(args.out, `${args.runTag}_${Date.now()}`);
  ensureDir(modelDir);
  fs.writeFileSync(path.join(modelDir, "numeric_norm.json"), JSON.stringify(norm, null, 2));
  model.getWeights().forEach((w, i) => fs.writeFileSync(path.join(modelDir, `weight_${i}.bin`), Buffer.from(w.dataSync().buffer)));
  fs.writeFileSync(path.join(modelDir, "model.json"), JSON.stringify(model.toJSON(), null, 2));
  console.log(`Model saved: ${modelDir}`);
}
main().catch(console.error);
