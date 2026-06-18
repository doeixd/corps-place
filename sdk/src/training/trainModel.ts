// ml/train/trainModel.ts
//
// Updated TFJS-node training skeleton with:
// 1) features.json export (ordered feature names + default/missing rules)
// 2) embedding dropout + optional numeric feature dropout
// 3) metadata includes featureSpec hash
//
// deps:
//   npm i @tensorflow/tfjs-node better-sqlite3 zod
//
// usage:
//   ts-node ml/train/trainModel.ts --db ./dci-relational.db --out ./models --runTag 2026-01-08 --featureSpec ./ml/features/featurespec.json

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import Database from "better-sqlite3";
import * as tf from "@tensorflow/tfjs";
import "@tensorflow/tfjs-backend-cpu";
import { z } from "zod";

// -----------------------------
// Feature spec (saved with model)
// -----------------------------
export type FeatureSpec = {
  version: string; // bump when you reorder/rename
  // Ordered list of numeric features that correspond exactly to x_numeric_json vector order
  numericOrder: Array<{
    name: string;
    defaultValue: number; // used if missing at inference
    // If present, indicates which "has_*" feature should be set when this feature is provided/missing.
    // (Only meaningful if that missingFlag feature is also in numericOrder.)
    missingFlag?: string;
  }>;
  notes?: string;
};

function sha256(x: string): string {
  return crypto.createHash("sha256").update(x).digest("hex");
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function readFeatureSpecOrDefault(featureSpecPath: string | undefined, numNumeric: number): FeatureSpec {
  if (featureSpecPath && fs.existsSync(featureSpecPath)) {
    const raw = fs.readFileSync(featureSpecPath, "utf8");
    // Strip comments for JSONC support
    const clean = raw.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
    const parsed = JSON.parse(clean) as FeatureSpec;
    if (!parsed.numericOrder || parsed.numericOrder.length !== numNumeric) {
      throw new Error(
        `FeatureSpec numericOrder length (${parsed.numericOrder?.length}) must match numNumeric (${numNumeric}).`
      );
    }
    return parsed;
  }

  // Fallback: stable but not informative names.
  return {
    version: "auto-fallback-v1",
    numericOrder: Array.from({ length: numNumeric }, (_, i) => ({
      name: `f_${i}`,
      defaultValue: 0,
    })),
    notes:
      "Auto-generated because --featureSpec was not provided. Replace with a real spec that matches your feature builder.",
  };
}

// -----------------------------
// CLI args
// -----------------------------
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
  featureSpec?: string;
  // generalization knobs
  l2: number;
  dropout: number;
  embeddingDropout: number;
  numericDropout: number;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };

  return {
    db: get("--db", "./dci-relational.db")!,
    out: get("--out", "./models")!,
    runTag: get("--runTag", new Date().toISOString().slice(0, 10))!,
    featureSpec: get("--featureSpec"),
    maxJudges: Number(get("--maxJudges", "16")),
    useJudges: get("--useJudges", "1") !== "0",
    epochs: Number(get("--epochs", "200")),
    batchSize: Number(get("--batchSize", "256")),
    patience: Number(get("--patience", "15")),
    learningRate: Number(get("--learningRate", "0.001")),
    l2: Number(get("--l2", "0.0001")),
    dropout: Number(get("--dropout", "0.25")),
    embeddingDropout: Number(get("--embeddingDropout", "0.10")), // NEW
    numericDropout: Number(get("--numericDropout", "0.05")), // NEW (feature dropout)
  };
}

// -----------------------------
// Data contract
// -----------------------------
const RowSchema = z.object({
  split: z.enum(["train", "val", "test"]),
  x_numeric_json: z.string(),
  corps_id: z.number().int().nonnegative(),
  season_id: z.number().int().nonnegative(),
  division_id: z.number().int().nonnegative(),
  judge_ids_json: z.string().optional(),
  y_total: z.number(),
  sample_weight: z.number().nullable().optional(),

  // Optional fields useful for evaluation/auditing:
  pct_through_season: z.number().nullable().optional(),
  competition_slug: z.string().optional(),
  corps_key: z.string().optional(),
  competition_date: z.string().optional(),
});
type DBRow = z.infer<typeof RowSchema>;

// Point this SQL at a VIEW that is already leakage-free and split by time.
// Add pct_through_season if you can (helps evaluation scripts).
const DEFAULT_SQL = `
  SELECT
    split,
    x_numeric_json,
    corps_id,
    season_id,
    division_id,
    judge_ids_json,
    y_total,
    sample_weight,
    pct_through_season,
    competition_slug,
    corps_key,
    competition_date
  FROM ml_training_rows
  WHERE y_total IS NOT NULL
`;

function safeJsonArrayNumbers(s: string): number[] {
  const v = JSON.parse(s);
  if (!Array.isArray(v)) throw new Error("Expected JSON array");
  return v.map((x) => (typeof x === "number" ? x : Number(x)));
}

function padJudgeIds(ids: number[], maxJudges: number): number[] {
  const out = ids.slice(0, maxJudges);
  while (out.length < maxJudges) out.push(0); // 0 reserved for PAD/UNK
  return out;
}

function loadRows(dbPath: string, sql = DEFAULT_SQL): DBRow[] {
  const db = new Database(dbPath, { readonly: true });
  const stmt = db.prepare(sql);
  const rows = stmt.all();
  db.close();
  return rows.map((row: unknown) => RowSchema.parse(row));

}

function splitRows(rows: DBRow[]) {
  const train = rows.filter((r) => r.split === "train");
  const val = rows.filter((r) => r.split === "val");
  const test = rows.filter((r) => r.split === "test");
  return { train, val, test };
}

type Dataset = {
  xNumeric: number[][];
  corpsId: number[];
  seasonId: number[];
  divisionId: number[];
  judgeIds?: number[][];
  y: number[][];
  weight: number[];
};

function toDataset(rows: DBRow[], maxJudges: number, useJudges: boolean): Dataset {
  const xNumeric: number[][] = [];
  const corpsId: number[] = [];
  const seasonId: number[] = [];
  const divisionId: number[] = [];
  const judgeIds: number[][] = [];
  const y: number[][] = [];
  const weight: number[] = [];

  for (const r of rows) {
    xNumeric.push(safeJsonArrayNumbers(r.x_numeric_json));
    corpsId.push(r.corps_id);
    seasonId.push(r.season_id);
    divisionId.push(r.division_id);

    if (useJudges) {
      const ids = r.judge_ids_json ? safeJsonArrayNumbers(r.judge_ids_json).map((n) => Math.trunc(n)) : [];
      judgeIds.push(padJudgeIds(ids, maxJudges));
    }

    y.push([r.y_total]);
    weight.push(r.sample_weight ?? 1.0);
  }

  return { xNumeric, corpsId, seasonId, divisionId, judgeIds: useJudges ? judgeIds : undefined, y, weight };
}

type NormStats = { mean: number[]; std: number[] };

function computeNormStats(x: number[][]): NormStats {
  const n = x.length;
  const d = x[0]!.length;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);

  for (const row of x) for (let j = 0; j < d; j++) mean[j] += row[j]!;
  for (let j = 0; j < d; j++) mean[j] /= n;

  for (const row of x) for (let j = 0; j < d; j++) std[j] += (row[j]! - mean[j]!) ** 2;
  for (let j = 0; j < d; j++) {
    std[j] = Math.sqrt(std[j] / Math.max(1, n - 1));
    if (!Number.isFinite(std[j]) || std[j] === 0) std[j] = 1;
  }

  return { mean, std };
}

function applyNorm(x: number[][], stats: NormStats): number[][] {
  const d = stats.mean.length;
  return x.map((row) => {
    const out = new Array(d);
    for (let j = 0; j < d; j++) out[j] = (row[j]! - stats.mean[j]!) / stats.std[j]!;
    return out;
  });
}

// -----------------------------
// Quantile loss
// -----------------------------
function quantileLoss(q: number) {
  return (yTrue: tf.Tensor, yPred: tf.Tensor) =>
    tf.tidy(() => {
      const e = tf.sub(yTrue, yPred);
      return tf.mean(tf.maximum(tf.mul(q, e), tf.mul(q - 1, e)));
    });
}

function quantileLoss3(qs: [number, number, number]) {
  const qT = tf.tensor1d(qs, "float32");
  return (yTrue: tf.Tensor, yPred: tf.Tensor) => {
    const e = tf.sub(yTrue, yPred); // [batch, 3]
    const loss = tf.maximum(tf.mul(qT, e), tf.mul(tf.sub(qT, 1), e));
    return tf.mean(loss);
  };
}

// -----------------------------
// Model (embedding + feature dropout + embedding dropout)
// -----------------------------
type ModelConfig = {
  numNumeric: number;
  corpsVocab: number;
  seasonVocab: number;
  divisionVocab: number;
  judgeVocab?: number;
  maxJudges: number;
  useJudges: boolean;

  corpsEmbDim: number;
  seasonEmbDim: number;
  divisionEmbDim: number;
  judgeEmbDim: number;

  l2: number;
  dropout: number;
  embeddingDropout: number; // NEW
  numericDropout: number; // NEW
};

function buildModel(cfg: ModelConfig): tf.LayersModel {
  const reg = tf.regularizers.l2({ l2: cfg.l2 });

  const numericIn = tf.input({ shape: [cfg.numNumeric], name: "x_numeric" });
  // Feature dropout on numeric inputs (helps robustness to missing/incomplete data)
  const numericDropped =
    cfg.numericDropout > 0
      ? (tf.layers.dropout({ rate: cfg.numericDropout, name: "dropout_numeric" }).apply(numericIn) as tf.SymbolicTensor)
      : (numericIn as tf.SymbolicTensor);

  const corpsIn = tf.input({ shape: [1], dtype: "int32", name: "corps_id" });
  const seasonIn = tf.input({ shape: [1], dtype: "int32", name: "season_id" });
  const divisionIn = tf.input({ shape: [1], dtype: "int32", name: "division_id" });

  const embCorps = tf.layers
    .embedding({ inputDim: cfg.corpsVocab, outputDim: cfg.corpsEmbDim, embeddingsRegularizer: reg, name: "emb_corps" })
    .apply(corpsIn) as tf.SymbolicTensor;
  const embSeason = tf.layers
    .embedding({
      inputDim: cfg.seasonVocab,
      outputDim: cfg.seasonEmbDim,
      embeddingsRegularizer: reg,
      name: "emb_season",
    })
    .apply(seasonIn) as tf.SymbolicTensor;
  const embDivision = tf.layers
    .embedding({
      inputDim: cfg.divisionVocab,
      outputDim: cfg.divisionEmbDim,
      embeddingsRegularizer: reg,
      name: "emb_division",
    })
    .apply(divisionIn) as tf.SymbolicTensor;

  const corpsFlat = tf.layers.flatten().apply(embCorps) as tf.SymbolicTensor;
  const seasonFlat = tf.layers.flatten().apply(embSeason) as tf.SymbolicTensor;
  const divisionFlat = tf.layers.flatten().apply(embDivision) as tf.SymbolicTensor;

  // Embedding dropout (anti-memorization)
  const corpsDrop =
    cfg.embeddingDropout > 0
      ? (tf.layers.dropout({ rate: cfg.embeddingDropout, name: "dropout_corps_emb" }).apply(corpsFlat) as tf.SymbolicTensor)
      : corpsFlat;
  const seasonDrop =
    cfg.embeddingDropout > 0
      ? (tf.layers.dropout({ rate: cfg.embeddingDropout, name: "dropout_season_emb" }).apply(seasonFlat) as tf.SymbolicTensor)
      : seasonFlat;
  const divisionDrop =
    cfg.embeddingDropout > 0
      ? (tf.layers.dropout({ rate: cfg.embeddingDropout, name: "dropout_division_emb" }).apply(divisionFlat) as tf.SymbolicTensor)
      : divisionFlat;

  let inputs: tf.SymbolicTensor[] = [numericIn, corpsIn, seasonIn, divisionIn];
  let concatParts: tf.SymbolicTensor[] = [numericDropped, corpsDrop, seasonDrop, divisionDrop];

  if (cfg.useJudges) {
    if (cfg.judgeVocab == null) throw new Error("judgeVocab required when useJudges=true");

    const judgeIn = tf.input({ shape: [cfg.maxJudges], dtype: "int32", name: "judge_ids" });
    inputs = [...inputs, judgeIn];

    const judgeEmb = tf.layers
      .embedding({
        inputDim: cfg.judgeVocab,
        outputDim: cfg.judgeEmbDim,
        embeddingsRegularizer: reg,
        name: "emb_judges",
      })
      .apply(judgeIn) as tf.SymbolicTensor; // [b, maxJudges, embDim]

    // Simple mean pooling (no masking - padding at 0 will have small learned embeddings)
    const pooled = tf.layers
      .globalAveragePooling1d({ name: "judge_gap" })
      .apply(judgeEmb) as tf.SymbolicTensor;

    const pooledDrop =
      cfg.embeddingDropout > 0
        ? (tf.layers.dropout({ rate: cfg.embeddingDropout, name: "dropout_judge_emb" }).apply(pooled) as tf.SymbolicTensor)
        : pooled;

    concatParts = [...concatParts, pooledDrop];
  }

  const concat = tf.layers.concatenate({ name: "concat_features" }).apply(concatParts) as tf.SymbolicTensor;

  const h1 = tf.layers.dense({ units: 256, activation: "relu", kernelRegularizer: reg, name: "dense_1" }).apply(concat) as tf.SymbolicTensor;
  const d1 = tf.layers.dropout({ rate: cfg.dropout, name: "dropout_1" }).apply(h1) as tf.SymbolicTensor;

  const dense2 = tf.layers.dense({ units: 128, activation: "relu", kernelRegularizer: reg, name: "dense_2" }).apply(d1) as tf.SymbolicTensor;
  const h2Drop = tf.layers.dropout({ rate: cfg.dropout, name: "dropout_2" }).apply(dense2) as tf.SymbolicTensor;

  const out = tf.layers.dense({ units: 1, name: "y_score" }).apply(h2Drop) as tf.SymbolicTensor;

  return tf.model({ inputs, outputs: out });
}

// -----------------------------
// Tensor building
// -----------------------------
function maxPlusOne(values: number[]): number {
  return values.reduce((m, v) => Math.max(m, v), 0) + 1;
}

function makeTensors(ds: Dataset, stats: NormStats, useJudges: boolean) {
  const xNorm = applyNorm(ds.xNumeric, stats);
  const xNumericT = tf.tensor2d(xNorm, [xNorm.length, xNorm[0]!.length], "float32");
  const corpsT = tf.tensor2d(ds.corpsId.map((v) => [v]), [ds.corpsId.length, 1], "int32");
  const seasonT = tf.tensor2d(ds.seasonId.map((v) => [v]), [ds.seasonId.length, 1], "int32");
  const divisionT = tf.tensor2d(ds.divisionId.map((v) => [v]), [ds.divisionId.length, 1], "int32");
  const yTrue = tf.tensor2d(ds.y, [ds.y.length, 1], "float32");
  const sampleW = tf.tensor1d(ds.weight, "float32");

  if (useJudges) {
    if (!ds.judgeIds) throw new Error("Expected judgeIds when useJudges=true");
    const judgeT = tf.tensor2d(ds.judgeIds, [ds.judgeIds.length, ds.judgeIds[0]!.length], "int32");
    return { inputs: [xNumericT, corpsT, seasonT, divisionT, judgeT], yTrue, sampleW };
  }
  return { inputs: [xNumericT, corpsT, seasonT, divisionT], yTrue, sampleW };
}

// -----------------------------
// Callbacks
// -----------------------------
function makeBestWeightsCallback() {
  let bestVal = Number.POSITIVE_INFINITY;
  let bestWeights: tf.Tensor[] | null = null;
  let currentModel: tf.LayersModel | null = null;

  return {
    set(m: tf.LayersModel) {
      currentModel = m;
    },
    onEpochEnd: async (epoch: number, logs?: tf.Logs) => {
      const val = logs?.val_loss;
      if (val == null) return;
      if (val < bestVal) {
        bestVal = val;
        if (bestWeights) bestWeights.forEach((t) => t.dispose());
        const w = currentModel?.getWeights() ?? [];
        bestWeights = w.map((t) => t.clone());
        console.log(`epoch=${epoch} new best val_loss=${val.toFixed(6)}`);
      }
    },
    onTrainEnd: async () => {
      if (bestWeights && currentModel) {
        currentModel.setWeights(bestWeights);
        bestWeights.forEach((t) => t.dispose());
        bestWeights = null;
      }
    },
  };
}

function makeProgressCallback() {
  return {
    onBatchEnd: async (batch: number, logs?: tf.Logs) => {
      if (batch % 10 === 0 && logs) {
        process.stdout.write(`.`);
      }
    },
    onEpochBegin: async (epoch: number) => {
      process.stdout.write(`Epoch ${epoch} `);
    },
    onEpochEnd: async (epoch: number, logs?: tf.Logs) => {
      const trainLoss = logs?.loss ? logs.loss.toFixed(4) : "???";
      const valLoss = logs?.val_loss ? logs.val_loss.toFixed(4) : "???";
      process.stdout.write(`\nEpoch ${epoch} done. Train: ${trainLoss}, Val: ${valLoss}\n`);
    }
  };
}

async function evaluateMAE(model: tf.LayersModel, inputs: tf.Tensor[], yTrue: tf.Tensor2D) {
  return tf.tidy(() => {
    const yPred = model.predict(inputs) as tf.Tensor2D;
    const mae = tf.mean(tf.abs(tf.sub(yTrue, yPred))).arraySync() as number;
    return { mae };
  });
}

// -----------------------------
// Main
// -----------------------------
async function main() {
  const args = parseArgs();
  ensureDir(args.out);

  const rows = loadRows(args.db, DEFAULT_SQL);
  const { train: trainRows, val: valRows, test: testRows } = splitRows(rows);

  if (!trainRows.length || !valRows.length || !testRows.length) {
    throw new Error(`Need non-empty train/val/test splits. Got train=${trainRows.length}, val=${valRows.length}, test=${testRows.length}`);
  }

  const trainDsRaw = toDataset(trainRows, args.maxJudges, args.useJudges);
  const valDsRaw = toDataset(valRows, args.maxJudges, args.useJudges);
  const testDsRaw = toDataset(testRows, args.maxJudges, args.useJudges);

  const numNumeric = trainDsRaw.xNumeric[0]!.length;
  const norm = computeNormStats(trainDsRaw.xNumeric);

  // NEW: feature spec
  const featureSpec = readFeatureSpecOrDefault(args.featureSpec, numNumeric);
  const featureSpecJson = JSON.stringify(featureSpec, null, 2);
  const featureSpecHash = sha256(featureSpecJson);

  const corpsVocab = maxPlusOne(rows.map((r) => r.corps_id));
  const seasonVocab = maxPlusOne(rows.map((r) => r.season_id));
  const divisionVocab = maxPlusOne(rows.map((r) => r.division_id));

  let judgeVocab: number | undefined;
  if (args.useJudges) {
    let maxJudge = 0;
    for (const r of rows) {
      if (!r.judge_ids_json) continue;
      const ids = safeJsonArrayNumbers(r.judge_ids_json).map((n) => Math.trunc(n));
      for (const id of ids) maxJudge = Math.max(maxJudge, id);
    }
    judgeVocab = maxJudge + 1;
    if (judgeVocab < 2) judgeVocab = 2;
  }

  const trainT = makeTensors(trainDsRaw, norm, args.useJudges);
  const valT = makeTensors(valDsRaw, norm, args.useJudges);
  const testT = makeTensors(testDsRaw, norm, args.useJudges);

  const model = buildModel({
    numNumeric,
    corpsVocab,
    seasonVocab,
    divisionVocab,
    judgeVocab,
    maxJudges: args.maxJudges,
    useJudges: args.useJudges,
    corpsEmbDim: 12,
    seasonEmbDim: 6,
    divisionEmbDim: 4,
    judgeEmbDim: 12,
    l2: args.l2,
    dropout: args.dropout,
    embeddingDropout: args.embeddingDropout,
    numericDropout: args.numericDropout,
  });

  model.summary();

  model.compile({ optimizer: tf.train.adam(args.learningRate), loss: "meanSquaredError" });

  const best = makeBestWeightsCallback();
  best.set(model);
  const earlyStop = tf.callbacks.earlyStopping({ monitor: "val_loss", patience: args.patience, restoreBestWeights: false });

  const history = await model.fit(trainT.inputs, trainT.yTrue, {
    epochs: args.epochs,
    batchSize: args.batchSize,
    validationData: [valT.inputs, valT.yTrue],
    // sampleWeight: trainT.sampleW, // Unsupported in pure tfjs
    // callbacks: [best, earlyStop],
    callbacks: [best, makeProgressCallback()],
    shuffle: true,
  });

  const valMae = await evaluateMAE(model, valT.inputs, valT.yTrue as tf.Tensor2D);
  const testMae = await evaluateMAE(model, testT.inputs, testT.yTrue as tf.Tensor2D);

  console.log("VAL  MAE (p10/p50/p90):", valMae);
  console.log("TEST MAE (p10/p50/p90):", testMae);

  // Export
  const modelDir = path.join(args.out, `dci-score-model_${args.runTag}_${Date.now()}`);
  ensureDir(modelDir);

  // Manual save of topology and weights because model.save('file://...') fails in pure tfjs
  const modelJson = model.toJSON() as any;
  fs.writeFileSync(path.join(modelDir, "model.json"), JSON.stringify(modelJson, null, 2));

  // Save weights as binary
  const weights = model.getWeights();
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]!;
    const name = `weight_${i}.bin`;
    const data = w.dataSync();
    fs.writeFileSync(path.join(modelDir, name), Buffer.from(data.buffer));
  }
  fs.writeFileSync(path.join(modelDir, "numeric_norm.json"), JSON.stringify(norm, null, 2));
  fs.writeFileSync(path.join(modelDir, "features.json"), featureSpecJson); // NEW

  const meta = {
    runTag: args.runTag,
    createdAt: new Date().toISOString(),
    dbPath: args.db,
    querySha256: sha256(DEFAULT_SQL),
    featureSpecHash,
    numRows: { train: trainRows.length, val: valRows.length, test: testRows.length },
    numNumeric,
    useJudges: args.useJudges,
    maxJudges: args.maxJudges,
    vocab: { corpsVocab, seasonVocab, divisionVocab, judgeVocab: judgeVocab ?? null },
    hyperparams: {
      epochs: args.epochs,
      batchSize: args.batchSize,
      patience: args.patience,
      learningRate: args.learningRate,
      l2: args.l2,
      dropout: args.dropout,
      embeddingDropout: args.embeddingDropout,
      numericDropout: args.numericDropout,
      embDims: { corps: 12, season: 6, division: 4, judge: 12 },
    },
    metrics: { valMae, testMae },
    history: history.history,
  };
  fs.writeFileSync(path.join(modelDir, "metadata.json"), JSON.stringify(meta, null, 2));

  tf.dispose([
    ...trainT.inputs,
    trainT.yTrue,
    trainT.sampleW,
    ...valT.inputs,
    valT.yTrue,
    valT.sampleW,
    ...testT.inputs,
    testT.yTrue,
    testT.sampleW,
  ]);

  console.log(`Saved model to: ${modelDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
