import * as tf from "@tensorflow/tfjs-node";
import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const DB_PATH = "./dci-relational.db";
const MODEL_DIR = "./models/v6_production";
const NORM_PATH = "./results/v6-production-target-norm.json";
const SEQ_LEN = 15;
const FEAT_DIM = 57;
const STATIC_DIM = 53;
const BATCH_SIZE = 32;
const EPOCHS = 200;
const EARLY_STOPPING_PATIENCE = 50;
const PADDING_INDEX = 3;
const CONSISTENCY_WEIGHT = 0.2;
const WIDTH_FLOOR_PTS = 0.5;
const WIDTH_FLOOR_WEIGHT = 0.05;
const SCORE_COVERAGE_TARGET = 0.8;
const SCORE_COVERAGE_WEIGHT = 0.3;
const EMA_ALPHA = 0.3;
const RESIDUAL_OFFSET = 14;
const CAPTION_STRIDE = 4;

const denormalize = (value: number, mean: number, std: number) => value * (std > 1e-6 ? std : 1) + mean;

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const CAPTION_COUNT = CAPTIONS.length;
const RESIDUAL_DIM = CAPTION_COUNT * 3;
const RECAP_DIM = CAPTION_COUNT;
const TOTAL_DIM = 1;
const OUTPUT_DIM = RESIDUAL_DIM + RECAP_DIM + TOTAL_DIM;
const TARGET_DIM = CAPTION_COUNT + RECAP_DIM + TOTAL_DIM;


class MaskedSoftmax extends tf.layers.Layer {
  static className = "MaskedSoftmax";
  private hasLogged = false;

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape = inputShape as Array<Array<number | null>>;
    return shape[0];
  }

  call(inputs: tf.Tensor | tf.Tensor[], kwargs: Record<string, unknown>) {
    return tf.tidy(() => {
      const [scoresRaw, maskRaw] = inputs as tf.Tensor[];
      const scores = tf.reshape(scoresRaw, [-1, SEQ_LEN]);
      const mask = tf.reshape(maskRaw, [-1, SEQ_LEN]);
      if (!this.hasLogged) {
        console.log("MaskedSoftmax shapes:", scoresRaw.shape, maskRaw.shape, scores.shape, mask.shape);
        this.hasLogged = true;
      }
      const boolMask = tf.cast(mask, "bool");
      const negInf = tf.fill(scores.shape, -1e9);
      const masked = tf.where(boolMask, scores, negInf);
      return tf.softmax(masked, 1);
    });
  }

  getConfig() {
    return { ...super.getConfig() };
  }

  getClassName() {
    return "MaskedSoftmax";
  }
}

tf.serialization.registerClass(MaskedSoftmax);

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };

  return {
    epochs: Number(get("--epochs", `${EPOCHS}`)),
    batchSize: Number(get("--batch", `${BATCH_SIZE}`)),
    maxRows: Number(get("--maxRows", "")) || undefined,
    patience: Number(get("--patience", `${EARLY_STOPPING_PATIENCE}`)),
    // Hyperparameters
    lstm1Units: Number(get("--lstm1-units", "64")),
    lstm2Units: Number(get("--lstm2-units", "32")),
    dropoutLstm: Number(get("--dropout-lstm", "0.2")),
    recurrentDropout: Number(get("--recurrent-dropout", "0.2")),
    dropoutDense1: Number(get("--dropout-dense1", "0.3")),
    dropoutDense2: Number(get("--dropout-dense2", "0.2")),
    l2Reg: Number(get("--l2-reg", "0.00002")),
    learningRate: Number(get("--lr", "0.0005")),
    minLr: Number(get("--min-lr", "0.00005")),
    warmupEpochs: Number(get("--warmup-epochs", "5")),
    clipNorm: Number(get("--clip-norm", "1.0")),
    seed: Number(get("--seed", "42")),
    swa: get("--swa", "false") === "true",
    swaStart: Number(get("--swa-start", "0.75")),
    swaInterval: Number(get("--swa-interval", "1")),
    snapshotEpochs: get("--snapshot-epochs", ""),
    useMha: get("--use-mha", "false") === "true",
    widthFloorPts: Number(get("--width-floor-pts", `${WIDTH_FLOOR_PTS}`)),
    widthFloorWeight: Number(get("--width-floor-weight", `${WIDTH_FLOOR_WEIGHT}`)),
    valSplit: Number(get("--val-split", "0.01")), // Default 1% validation for monitoring
    // Logging
    logCsv: get("--log-csv", "./results/lstm-v6-production-training-log.csv"),
    trialId: get("--trial-id"),
  };
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const std = (values: number[]) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
};

const computeEma = (values: number[], alpha: number) => {
  if (!values.length) return 0;
  let ema = values[0]!;
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i]! + (1 - alpha) * ema;
  }
  return ema;
};

type DataRow = {
  seq: number[][];
  seqMask: boolean[];
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
  residualWeights: number[];
  recapWeights: number[];
};

function buildDataRows(rows: Array<{ x_sequence_json: string; x_static_json: string; y_residuals_json: string; y_recap_json: string }>) {
  const dataRows: DataRow[] = [];
  for (const row of rows) {
    const rawSeq = JSON.parse(row.x_sequence_json) as number[][];
    const seqMask = rawSeq.map((step) => step[PADDING_INDEX] !== 1);
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

    dataRows.push({ seq, seqMask, stat, residuals, recap: recapValues, total });
  }

  return dataRows;
}

function computeTargetStats(rows: DataRow[]): TargetStats {
  const residualSeries = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const recapSeries = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const totalSeries: number[] = [];

  for (const row of rows) {
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      residualSeries[idx]!.push(row.residuals[idx] ?? 0);
      recapSeries[idx]!.push(row.recap[idx] ?? 0);
    }
    totalSeries.push(row.total);
  }

  const residualMean = residualSeries.map(mean);
  const residualStd = residualSeries.map(std);
  const recapMean = recapSeries.map(mean);
  const recapStd = recapSeries.map(std);
  const totalMean = mean(totalSeries);
  const totalStd = std(totalSeries);

  const minStd = 0.25;
  const residualWeights = residualStd.map((value) => 1 / Math.max(value ?? 0, minStd));
  const recapWeights = recapStd.map((value) => 1 / Math.max(value ?? 0, minStd));

  return {
    residualMean,
    residualStd,
    recapMean,
    recapStd,
    totalMean,
    totalStd,
    residualWeights,
    recapWeights,
  };
}

function normalizeValue(value: number, meanValue: number, stdValue: number) {
  if (!Number.isFinite(stdValue) || stdValue < 1e-6) return 0;
  return (value - meanValue) / stdValue;
}

type Sample = {
  xs: [number[][], number[], number[]];
  ys: number[];
};

function getResidualFromStep(step: number[], captionIndex: number): number {
  return step[RESIDUAL_OFFSET + captionIndex * CAPTION_STRIDE] ?? 0;
}

function computeBaselineMae(samples: Sample[], stats: TargetStats) {
  let zeroSum = 0;
  let meanSum = 0;
  let emaSum = 0;
  let count = 0;

  for (const sample of samples) {
    const seq = sample.xs[0];
    const mask = sample.xs[2];
    const steps = mask.length
      ? seq.filter((_, idx) => mask[idx] === 1)
      : seq.filter((step) => step.some((value) => value !== 0));
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      const actualNorm = sample.ys[idx] ?? 0;
      const meanPred = stats.residualMean[idx] ?? 0;
      const actual = denormalize(actualNorm, stats.residualMean[idx]!, stats.residualStd[idx]!);
      zeroSum += Math.abs(actual);
      meanSum += Math.abs(actual - meanPred);

      const history = steps.map((step) => getResidualFromStep(step, idx));
      const ema = history.length ? computeEma(history, EMA_ALPHA) : 0;
      emaSum += Math.abs(actual - ema);
      count += 1;
    }
  }

  return {
    baselineZero: count ? zeroSum / count : 0,
    baselineMean: count ? meanSum / count : 0,
    baselineEma: count ? emaSum / count : 0,
  };
}

function buildSamples(rows: DataRow[], stats: TargetStats): Sample[] {
  const samples: Sample[] = [];

  for (const row of rows) {
    const residualTargets: number[] = [];
    const recapValues: number[] = [];
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      const rawResidual = row.residuals[idx] ?? 0;
      const normalizedResidual = normalizeValue(rawResidual, stats.residualMean[idx]!, stats.residualStd[idx]!);
      residualTargets.push(normalizedResidual);

      const rawRecap = row.recap[idx] ?? 0;
      const normalizedRecap = normalizeValue(rawRecap, stats.recapMean[idx]!, stats.recapStd[idx]!);
      recapValues.push(normalizedRecap);
    }
    const normalizedTotal = normalizeValue(row.total, stats.totalMean, stats.totalStd || 1);

    samples.push({
      xs: [row.seq, row.stat, row.seqMask.map((value) => (value ? 1 : 0))],
      ys: [...residualTargets, ...recapValues, normalizedTotal],
    });
  }

  return samples;
}

type BatchedInputs = { seq: tf.Tensor; stat: tf.Tensor; mask: tf.Tensor };

function createDataset(samples: Sample[], batchSize: number, shuffle: boolean, seed: number) {
  let dataset = tf.data.array(samples).map((sample) => ({
    xs: {
      seq: tf.tensor(sample.xs[0], undefined, "float32"),
      stat: tf.tensor(sample.xs[1], undefined, "float32"),
      mask: tf.tensor(sample.xs[2], [SEQ_LEN], "float32"),
    },
    ys: tf.tensor(sample.ys, undefined, "float32"),
  }));

  if (shuffle) {
    dataset = dataset.shuffle(Math.min(samples.length, 1000), seed.toString(), true);
  }

  return dataset.batch(batchSize).prefetch(2);
}

function createLoss(stats: TargetStats, widthFloorPts: number, widthFloorWeight: number) {
  const recapMeanTensor = tf.tensor1d(stats.recapMean, "float32");
  const recapStdTensor = tf.tensor1d(stats.recapStd.map((value) => (value > 1e-6 ? value : 1)), "float32");
  const residualMeanTensor = tf.tensor1d(stats.residualMean, "float32");
  const residualStdTensor = tf.tensor1d(stats.residualStd.map((value) => (value > 1e-6 ? value : 1)), "float32");
  const residualWeightTensor = tf.tensor1d(stats.residualWeights, "float32");
  const recapWeightTensor = tf.tensor1d(stats.recapWeights, "float32");
  const totalMeanTensor = tf.scalar(stats.totalMean);
  const totalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

  const lossFn = (yTrue: tf.Tensor, yPred: tf.Tensor, returnComponents = false) =>
    tf.tidy(() => {
      const residualTrue = yTrue.slice([0, 0], [-1, CAPTION_COUNT]);
      const recapTrue = yTrue.slice([0, CAPTION_COUNT], [-1, RECAP_DIM]);
      const totalTrue = yTrue.slice([0, CAPTION_COUNT + RECAP_DIM], [-1, TOTAL_DIM]);

      const residualPred = yPred.slice([0, 0], [-1, RESIDUAL_DIM]);
      const recapPred = yPred.slice([0, RESIDUAL_DIM], [-1, RECAP_DIM]);
      const totalPred = yPred.slice([0, RESIDUAL_DIM + RECAP_DIM], [-1, TOTAL_DIM]);

      const residualPredQ10 = residualPred.slice([0, 0], [-1, CAPTION_COUNT]);
      const residualPredQ50 = residualPred.slice([0, CAPTION_COUNT], [-1, CAPTION_COUNT]);
      const residualPredQ90 = residualPred.slice([0, CAPTION_COUNT * 2], [-1, CAPTION_COUNT]);

      const err10 = tf.sub(residualTrue, residualPredQ10);
      const err50 = tf.sub(residualTrue, residualPredQ50);
      const err90 = tf.sub(residualTrue, residualPredQ90);

      const q10Loss = tf.maximum(tf.mul(0.1, err10), tf.mul(-0.9, err10));
      const q50Loss = tf.maximum(tf.mul(0.5, err50), tf.mul(-0.5, err50));
      const q90Loss = tf.maximum(tf.mul(0.9, err90), tf.mul(-0.1, err90));

      const weightedCaptionMean = (lossByCap: tf.Tensor2D, weights: tf.Tensor1D) => {
        const perCap = tf.mean(lossByCap, 0);
        const denom = tf.maximum(tf.sum(weights), tf.scalar(1e-8));
        return tf.div(tf.sum(tf.mul(perCap, weights)), denom);
      };

      const weightedQ10 = tf.mean(q10Loss); // Uniform weighting for tails to ensure coverage
      const weightedQ50 = weightedCaptionMean(q50Loss as tf.Tensor2D, residualWeightTensor);
      const weightedQ90 = tf.mean(q90Loss); // Uniform weighting for tails to ensure coverage
      const residualLoss = tf.addN([weightedQ10, weightedQ50, weightedQ90]);

      const recapError = tf.sub(recapTrue, recapPred);
      const recapSq = tf.square(recapError) as tf.Tensor2D;
      const recapLoss = weightedCaptionMean(recapSq, recapWeightTensor);

      const totalError = tf.sub(totalTrue, totalPred);
      const totalLoss = tf.mean(tf.square(totalError));

      const recapDenorm = tf.add(tf.mul(recapPred, recapStdTensor), recapMeanTensor);
      const totalDenorm = tf.add(tf.mul(totalPred, totalStdTensor), totalMeanTensor).reshape([-1]);
      const recapSum = tf.sum(recapDenorm, 1);
      const diff = tf.abs(tf.sub(recapSum, totalDenorm));
      const consistencyLoss = tf.mean(tf.div(diff, tf.add(tf.abs(totalDenorm), tf.scalar(1e-6))));

      const q10Denorm = tf.add(tf.mul(residualPredQ10, residualStdTensor), residualMeanTensor);
      const q90Denorm = tf.add(tf.mul(residualPredQ90, residualStdTensor), residualMeanTensor);
      const widthPts = tf.sub(q90Denorm, q10Denorm);
      const widthShortfall = tf.relu(tf.sub(tf.scalar(widthFloorPts), widthPts));
      const widthPenalty = tf.mean(tf.square(widthShortfall));

      const total = tf.addN([
        residualLoss,
        recapLoss,
        totalLoss,
        tf.mul(tf.scalar(CONSISTENCY_WEIGHT), consistencyLoss),
        tf.mul(tf.scalar(widthFloorWeight), widthPenalty),
      ]);

      if (returnComponents) {
        return {
          total,
          residual: residualLoss,
          recap: recapLoss,
          totalHead: totalLoss,
          consistency: consistencyLoss,
          widthFloor: widthPenalty,
        };
      }

      return total;
    });

  const dispose = () => {
    recapMeanTensor.dispose();
    recapStdTensor.dispose();
    residualMeanTensor.dispose();
    residualStdTensor.dispose();
    residualWeightTensor.dispose();
    recapWeightTensor.dispose();
    totalMeanTensor.dispose();
    totalStdTensor.dispose();
  };

  return { lossFn, dispose };
}

async function main() {
  const args = parseArgs();
  await tf.setBackend("tensorflow");
  const seedrandom = (tf.util as unknown as { seedrandom?: (seed: string) => void }).seedrandom;
  if (seedrandom) {
    seedrandom(args.seed.toString());
  }
  try {
    tf.env().set("DETERMINISTIC", true);
  } catch {
    // ignore if backend doesn't support deterministic setting
  }

  const client = createClient({ url: `file:${DB_PATH}` });
  console.log("Loading V6 Production sequence data...");

  const result = await client.execute(`
    SELECT season, corps_key, x_sequence_json, x_static_json, y_residuals_json, y_recap_json, split
    FROM ml_sequence_rows_v6_production
  `);

  const rows = result.rows as unknown as Array<{
    season: string;
    corps_key: string;
    x_sequence_json: string;
    x_static_json: string;
    y_residuals_json: string;
    y_recap_json: string;
    split: string;
  }>;
  client.close();

  // PRODUCTION: Shuffle everything that isn't the final test set and then split
  const trainSplitRows = rows.filter((row) => row.split === "train");
  const testRows = rows.filter((row) => row.split === "test");

  // Shuffle trainSplitRows
  for (let i = trainSplitRows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [trainSplitRows[i], trainSplitRows[j]] = [trainSplitRows[j]!, trainSplitRows[i]!];
  }

  const valCount = Math.floor(trainSplitRows.length * args.valSplit);
  const valRows = trainSplitRows.slice(0, valCount);
  const trainRows = trainSplitRows.slice(valCount);

  const trainData = buildDataRows(trainRows);
  const valData = buildDataRows(valRows);

  const trainSubset = args.maxRows ? trainData.slice(0, args.maxRows) : trainData;
  const valSubset = args.maxRows ? valData.slice(0, Math.min(args.maxRows, valData.length)) : valData;

  if (!trainSubset.length) {
    throw new Error("Missing train data for V6 Production model.");
  }

  const stats = computeTargetStats(trainSubset);
  fs.writeFileSync(NORM_PATH, JSON.stringify(stats, null, 2));
  console.log(`Saved normalization stats to ${NORM_PATH}`);

  const trainSamples = buildSamples(trainSubset, stats);
  const valSamples = buildSamples(valSubset, stats);
  const baselines = valSamples.length ? computeBaselineMae(valSamples, stats) : { baselineZero: 0, baselineMean: 0, baselineEma: 0 };

  const testStep = trainSamples[0]?.xs[0][0];
  if (testStep && testStep.length !== FEAT_DIM) {
    throw new Error(`Feature dimension mismatch: expected ${FEAT_DIM}, got ${testStep.length}`);
  }

  console.log(`Production Splits -> Train: ${trainSamples.length}, Val (Monitoring): ${valSamples.length}, Test (Held-out): ${testRows.length}`);
  if (args.maxRows) {
    console.log(`Using maxRows=${args.maxRows} for quick training.`);
  }
  if (valSamples.length) {
    console.log(
      `Baselines (monitoring residual MAE): zero=${baselines.baselineZero.toFixed(4)}, ` +
      `mean=${baselines.baselineMean.toFixed(4)}, ema=${baselines.baselineEma.toFixed(4)}`
    );
  }

  const { lossFn, dispose: disposeLoss } = createLoss(stats, args.widthFloorPts, args.widthFloorWeight);

  const snapshotEpochs = args.snapshotEpochs
    ? args.snapshotEpochs.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value))
    : [];
  const snapshotEpochSet = new Set(snapshotEpochs);
  const runId = `${args.trialId ?? "run"}_${Date.now()}`;
  const runDir = path.join(MODEL_DIR, runId);
  const bestDir = path.join(runDir, "best");
  let bestSavedEpoch = -1;
  let lastBestSaveMs = 0;
  const MIN_BEST_SAVE_INTERVAL_MS = 30_000;

  fs.mkdirSync(runDir, { recursive: true });

  const saveModel = async (modelToSave: tf.LayersModel, dir: string) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const saveHandler = {
      save: async (modelArtifacts: any) => {
        if (modelArtifacts.weightData) {
          let buffer: Buffer;
          if (modelArtifacts.weightData instanceof ArrayBuffer) {
            buffer = Buffer.from(new Uint8Array(modelArtifacts.weightData));
          } else {
            buffer = Buffer.concat(
              (modelArtifacts.weightData as ArrayBuffer[]).map((chunk: ArrayBuffer) => Buffer.from(new Uint8Array(chunk)))
            );
          }
          fs.writeFileSync(path.join(dir, "weights.bin"), buffer);
        }

        const modelJson = {
          modelTopology: modelArtifacts.modelTopology,
          weightsManifest: [{ paths: ["weights.bin"], weights: modelArtifacts.weightSpecs }],
          format: modelArtifacts.format,
          generatedBy: modelArtifacts.generatedBy,
          convertedBy: modelArtifacts.convertedBy,
        };
        fs.writeFileSync(path.join(dir, "model.json"), JSON.stringify(modelJson));

        return {
          modelArtifactsInfo: {
            dateSaved: new Date(),
            modelTopologyType: "JSON" as const,
          },
        };
      },
    };

    await modelToSave.save(saveHandler);
  };

  const seqInput = tf.input({ shape: [SEQ_LEN, FEAT_DIM], name: "sequence" });
  const staticInput = tf.input({ shape: [STATIC_DIM], name: "static" });

  const maskedInput = tf.layers.masking({ maskValue: 0 }).apply(seqInput) as tf.SymbolicTensor;

  const lstm1 = tf.layers
    .bidirectional({
      layer: tf.layers.lstm({
        units: args.lstm1Units,
        returnSequences: true,
        dropout: args.dropoutLstm,
        recurrentDropout: args.recurrentDropout,
        kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
      }),
      mergeMode: "concat",
    })
    .apply(maskedInput) as tf.SymbolicTensor;


  const norm1 = tf.layers.layerNormalization().apply(lstm1) as tf.SymbolicTensor;

  const lstm2 = tf.layers
    .bidirectional({
      layer: tf.layers.lstm({
        units: args.lstm2Units,
        returnSequences: true,
        dropout: args.dropoutLstm,
        recurrentDropout: args.recurrentDropout,
        kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
      }),
      mergeMode: "concat",
    })
    .apply(norm1) as tf.SymbolicTensor;

  const norm2 = tf.layers.layerNormalization().apply(lstm2) as tf.SymbolicTensor;

  let attentionInput = norm2;
  if (args.useMha) {
    try {
      const require = createRequire(import.meta.url);
      const { MultiHeadAttention } = require("@tensorflow/tfjs-layers/dist/layers/nlp/multihead_attention") as {
        MultiHeadAttention: new (args: { numHeads: number; keyDim: number }) => tf.layers.Layer;
      };

      const selfAttended = new MultiHeadAttention({ numHeads: 4, keyDim: 16 }).apply(norm2, {
        value: norm2,
        key: norm2,
      }) as tf.SymbolicTensor;
      const attentionResidual = tf.layers.add().apply([norm2, selfAttended]) as tf.SymbolicTensor;
      attentionInput = tf.layers.layerNormalization().apply(attentionResidual) as tf.SymbolicTensor;
      attentionInput = tf.layers.dropout({ rate: 0.1 }).apply(attentionInput) as tf.SymbolicTensor;
    } catch (error) {
      console.warn("MultiHeadAttention failed; falling back to norm2.", error);
    }
  }

  const attentionScores = tf.layers.dense({ units: 1, activation: "tanh" }).apply(attentionInput) as tf.SymbolicTensor;
  const attentionScoresFlat = tf.layers.reshape({ targetShape: [SEQ_LEN] }).apply(attentionScores) as tf.SymbolicTensor;
  const maskInput = tf.input({ shape: [SEQ_LEN], name: "mask" });
  const attentionWeightsFlat = new MaskedSoftmax().apply([attentionScoresFlat, maskInput]) as tf.SymbolicTensor;

  const attentionWeights = tf.layers
    .reshape({ targetShape: [SEQ_LEN, 1] })
    .apply(attentionWeightsFlat) as tf.SymbolicTensor;
  const context = tf.layers.dot({ axes: [1, 1] }).apply([attentionWeights, attentionInput]) as tf.SymbolicTensor;
  const contextFlat = tf.layers.flatten().apply(context) as tf.SymbolicTensor;

  const concat = tf.layers.concatenate().apply([contextFlat, staticInput]) as tf.SymbolicTensor;

  const d1 = tf.layers
    .dense({
      units: 128,
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
    })
    .apply(concat) as tf.SymbolicTensor;

  const d1Drop = tf.layers.dropout({ rate: args.dropoutDense1 }).apply(d1) as tf.SymbolicTensor;

  const d2 = tf.layers
    .dense({
      units: 64,
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
    })
    .apply(d1Drop) as tf.SymbolicTensor;

  const d2Drop = tf.layers.dropout({ rate: args.dropoutDense2 }).apply(d2) as tf.SymbolicTensor;

  const skipConcat = tf.layers.concatenate().apply([d2Drop, staticInput]) as tf.SymbolicTensor;

  const q50Head = tf.layers.dense({ units: CAPTION_COUNT, name: "q50_head" }).apply(skipConcat) as tf.SymbolicTensor;
  const q10DeltaRaw = tf.layers.dense({ units: CAPTION_COUNT, name: "q10_delta_raw" }).apply(skipConcat) as tf.SymbolicTensor;
  const q90DeltaRaw = tf.layers.dense({ units: CAPTION_COUNT, name: "q90_delta_raw" }).apply(skipConcat) as tf.SymbolicTensor;
  const q10Delta = tf.layers.activation({ activation: "softplus", name: "q10_delta" }).apply(q10DeltaRaw) as tf.SymbolicTensor;
  const q90Delta = tf.layers.activation({ activation: "softplus", name: "q90_delta" }).apply(q90DeltaRaw) as tf.SymbolicTensor;
  const q10DeltaNeg = tf.layers
    .dense({
      units: CAPTION_COUNT,
      useBias: false,
      trainable: false,
      kernelInitializer: tf.initializers.identity({ gain: -1 }),
      name: "q10_delta_neg",
    })
    .apply(q10Delta) as tf.SymbolicTensor;
  const q10Head = tf.layers.add({ name: "q10_head" }).apply([q50Head, q10DeltaNeg]) as tf.SymbolicTensor;
  const q90Head = tf.layers.add({ name: "q90_head" }).apply([q50Head, q90Delta]) as tf.SymbolicTensor;
  const recapHead = tf.layers.dense({ units: RECAP_DIM, name: "recap_head" }).apply(skipConcat) as tf.SymbolicTensor;
  const totalHead = tf.layers.dense({ units: TOTAL_DIM, name: "total_head" }).apply(skipConcat) as tf.SymbolicTensor;

  const output = tf.layers
    .concatenate({ name: "output" })
    .apply([q10Head, q50Head, q90Head, recapHead, totalHead]) as tf.SymbolicTensor;

  const model = tf.model({ inputs: [seqInput, staticInput, maskInput], outputs: output });

  const optimizer = tf.train.adam(args.learningRate);
  model.summary();

  console.log(
    `Hyperparameters: lstm1=${args.lstm1Units}, lstm2=${args.lstm2Units}, dropout=${args.dropoutLstm}, ` +
    `lr=${args.learningRate}, batch=${args.batchSize}, width_floor_pts=${args.widthFloorPts}, ` +
    `width_floor_weight=${args.widthFloorWeight}`
  );

  const setLearningRate = (lr: number) => {
    const opt = optimizer as unknown as { setLearningRate?: (value: number) => void; learningRate?: number };
    if (opt.setLearningRate) opt.setLearningRate(lr);
    else if (opt.learningRate != null) opt.learningRate = lr;
  };

  const computeMaeFromPreds = (preds: tf.Tensor, ys: tf.Tensor) =>
    tf.tidy(() => {
      const predQ50 = preds.slice([0, CAPTION_COUNT], [-1, CAPTION_COUNT]);
      const trueResidual = ys.slice([0, 0], [-1, CAPTION_COUNT]);
      return tf.mean(tf.abs(tf.sub(predQ50, trueResidual)));
    });

  const csvPath = args.logCsv;
  let csvInitialized = false;
  const startTime = Date.now();

  const clipGradients = (grads: tf.Tensor[], clipNorm: number) =>
    tf.tidy(() => {
      const squared = grads.map((grad) => tf.sum(tf.square(grad)));
      const sum = tf.addN(squared);
      const globalNorm = tf.sqrt(sum);
      const scale = tf.minimum(tf.scalar(1), tf.div(tf.scalar(clipNorm), tf.add(globalNorm, tf.scalar(1e-6))));
      return grads.map((grad) => tf.mul(grad, scale));
    });

  const swaStartEpoch = Number.isFinite(args.swaStart)
    ? Math.max(0, Math.floor(args.epochs * args.swaStart))
    : Math.floor(args.epochs * 0.75);
  const swaInterval = Math.max(1, args.swaInterval || 1);
  let swaWeights: tf.Tensor[] | null = null;
  let swaCount = 0;

  let bestScore = Number.POSITIVE_INFINITY;
  let bestWeights: tf.Tensor[] | null = null;
  let patience = 0;

  for (let epoch = 0; epoch < args.epochs; epoch++) {
    const warmup = Math.max(0, Math.min(args.warmupEpochs, args.epochs));
    let lr: number;
    if (epoch < warmup) {
      lr = args.learningRate * (epoch + 1) / Math.max(1, warmup);
    } else {
      const progress = warmup >= args.epochs ? 1 : (epoch - warmup) / Math.max(1, args.epochs - warmup);
      lr = args.minLr + 0.5 * (args.learningRate - args.minLr) * (1 + Math.cos(Math.PI * progress));
    }
    setLearningRate(lr);

    let trainLossSum = 0;
    let trainMaeSum = 0;
    let trainCount = 0;

    const trainDs = createDataset(trainSamples, args.batchSize, true, args.seed + epoch);
    const trainIterator = await trainDs.iterator();
    while (true) {
      const item = await trainIterator.next();
      if (item.done) break;
      const batch = item.value as { xs: BatchedInputs; ys: tf.Tensor };
      const xs = batch.xs;
      const ys = batch.ys;
      const batchSize = ys.shape[0] ?? 0;

      let batchMae = 0;
      const { value, grads } = tf.variableGrads(() =>
        tf.tidy(() => {
          const preds = model.predict([xs.seq, xs.stat, xs.mask]) as tf.Tensor;
          const maeTensor = computeMaeFromPreds(preds, ys);
          batchMae = maeTensor.dataSync()[0] ?? 0;
          maeTensor.dispose();
          return lossFn(ys, preds) as tf.Scalar;
        })
      );

      const gradList = Object.values(grads) as tf.Tensor[];
      const clipped = clipGradients(gradList, args.clipNorm);
      const clippedMap: Record<string, tf.Tensor> = {};
      Object.keys(grads).forEach((name, idx) => {
        clippedMap[name] = clipped[idx]!;
      });
      optimizer.applyGradients(clippedMap as any);

      const lossValue = value.dataSync()[0] ?? 0;

      trainLossSum += lossValue * batchSize;
      trainMaeSum += batchMae * batchSize;
      trainCount += batchSize;

      value.dispose();
      gradList.forEach((grad: tf.Tensor) => grad.dispose());
      clipped.forEach((grad) => grad.dispose());
      xs.seq.dispose();
      xs.stat.dispose();
      xs.mask.dispose();
      ys.dispose();

    }

    let monitoringStats = {
      valScore: 0,
      valMaePoints: 0,
      coverage: 0,
      widthNorm: 0,
      widthFloorPct: 0
    };

    if (valSamples.length) {
      const valDs = createDataset(valSamples, args.batchSize, false, args.seed);
      let valLossSum = 0;
      let valMaeSum = 0;
      let valMaePointsSum = 0;
      let coverageCount = 0;
      let coverageWithin = 0;
      let intervalWidthSum = 0;
      let widthNormSum = 0;
      let widthFloorCount = 0;
      let valCount = 0;
      const captionMaePointsSum = new Array(CAPTION_COUNT).fill(0);
      const captionCoverageWithin = new Array(CAPTION_COUNT).fill(0);
      const captionWidthSum = new Array(CAPTION_COUNT).fill(0);
      const captionCount = new Array(CAPTION_COUNT).fill(0);

      const residualMeanTensor = tf.tensor1d(stats.residualMean, "float32");
      const residualStdTensor = tf.tensor1d(stats.residualStd.map((value) => (value > 1e-6 ? value : 1)), "float32");

      const valIterator = await valDs.iterator();
      while (true) {
        const item = await valIterator.next();
        if (item.done) break;
        const batch = item.value as { xs: BatchedInputs; ys: tf.Tensor };
        const xs = batch.xs;
        const ys = batch.ys;
        const batchSize = ys.shape[0] ?? 0;

        const preds = model.predict([xs.seq, xs.stat, xs.mask]) as tf.Tensor;
        const lossTensor = lossFn(ys, preds) as tf.Tensor;
        const lossValue = lossTensor.dataSync()[0] ?? 0;
        const maeTensor = computeMaeFromPreds(preds, ys);
        const maeValue = maeTensor.dataSync()[0] ?? 0;

        const predQ10 = preds.slice([0, 0], [-1, CAPTION_COUNT]);
        const predQ50 = preds.slice([0, CAPTION_COUNT], [-1, CAPTION_COUNT]);
        const predQ90 = preds.slice([0, CAPTION_COUNT * 2], [-1, CAPTION_COUNT]);
        const trueResidual = ys.slice([0, 0], [-1, CAPTION_COUNT]);
        const predDenorm = tf.add(tf.mul(predQ50, residualStdTensor), residualMeanTensor);
        const trueDenorm = tf.add(tf.mul(trueResidual, residualStdTensor), residualMeanTensor);
        const maePointsTensor = tf.mean(tf.abs(tf.sub(predDenorm, trueDenorm)));
        const maePointsValue = maePointsTensor.dataSync()[0] ?? 0;

        const predQ10Denorm = tf.add(tf.mul(predQ10, residualStdTensor), residualMeanTensor);
        const predQ90Denorm = tf.add(tf.mul(predQ90, residualStdTensor), residualMeanTensor);
        const lower = tf.minimum(predQ10Denorm, predQ90Denorm);
        const upper = tf.maximum(predQ10Denorm, predQ90Denorm);
        const within = tf.logicalAnd(trueDenorm.greaterEqual(lower), trueDenorm.lessEqual(upper));
        const withinFloat = tf.cast(within, "float32");
        const withinCount = withinFloat.sum().dataSync()[0] ?? 0;
        const intervalWidth = tf.mean(tf.sub(upper, lower)).dataSync()[0] ?? 0;
        const widthNormTensor = tf.mean(tf.sub(predQ90, predQ10));
        const widthNormValue = widthNormTensor.dataSync()[0] ?? 0;
        const widthFloorMask = tf.less(tf.sub(predQ90Denorm, predQ10Denorm), tf.scalar(args.widthFloorPts));
        const widthFloorCountBatch = tf.sum(tf.cast(widthFloorMask, "float32")).dataSync()[0] ?? 0;

        valLossSum += lossValue * batchSize;
        valMaeSum += maeValue * batchSize;
        valMaePointsSum += maePointsValue * batchSize;
        coverageWithin += withinCount;
        coverageCount += batchSize * CAPTION_COUNT;
        intervalWidthSum += intervalWidth * batchSize;
        widthNormSum += widthNormValue * batchSize;
        widthFloorCount += widthFloorCountBatch;
        valCount += batchSize;

        lossTensor.dispose();
        maeTensor.dispose();
        predQ10.dispose();
        predQ50.dispose();
        predQ90.dispose();
        trueResidual.dispose();
        predDenorm.dispose();
        trueDenorm.dispose();
        predQ10Denorm.dispose();
        predQ90Denorm.dispose();
        lower.dispose();
        upper.dispose();
        within.dispose();
        withinFloat.dispose();
        widthNormTensor.dispose();
        widthFloorMask.dispose();
        maePointsTensor.dispose();
        preds.dispose();
        xs.seq.dispose();
        xs.stat.dispose();
        xs.mask.dispose();
        ys.dispose();
      }

      residualMeanTensor.dispose();
      residualStdTensor.dispose();

      const valMaePoints = valCount ? valMaePointsSum / valCount : 0;
      const coverage = coverageCount ? coverageWithin / coverageCount : 0;
      const underCoverage = Math.max(0, SCORE_COVERAGE_TARGET - coverage);

      monitoringStats = {
        valScore: valMaePoints + SCORE_COVERAGE_WEIGHT * underCoverage,
        valMaePoints,
        coverage,
        widthNorm: valCount ? widthNormSum / valCount : 0,
        widthFloorPct: coverageCount ? widthFloorCount / coverageCount : 0
      };
    }

    if (args.swa && epoch >= swaStartEpoch && (epoch - swaStartEpoch) % swaInterval === 0) {
      const currentWeights = model.getWeights();
      if (!swaWeights) {
        swaWeights = currentWeights.map((tensor) => tensor.clone());
        swaCount = 1;
      } else {
        const nextCount = swaCount + 1;
        const updated: tf.Tensor[] = swaWeights.map((avg, idx) => {
          const weighted = tf.add(tf.mul(avg, swaCount), currentWeights[idx]!);
          const next = tf.div(weighted, nextCount);
          avg.dispose();
          return next;
        });
        swaWeights = updated;
        swaCount = nextCount;
      }
      currentWeights.forEach((tensor) => tensor.dispose());
    }

    if (snapshotEpochSet.has(epoch + 1)) {
      const snapshotDir = path.join(MODEL_DIR, runId, `snapshot_${epoch + 1}`);
      await saveModel(model, snapshotDir);
      console.log(`Saved snapshot to ${snapshotDir}`);
    }

    const trainLoss = trainCount ? trainLossSum / trainCount : 0;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(
      `Epoch ${epoch}: loss=${trainLoss.toFixed(6)} ` +
      `mon_mae_pts=${monitoringStats.valMaePoints.toFixed(4)} ` +
      `mon_cov=${monitoringStats.coverage.toFixed(3)} ` +
      `mon_score=${monitoringStats.valScore.toFixed(4)} ` +
      `time=${elapsed}s`
    );

    const improved = monitoringStats.valScore < bestScore - 1e-4;

    if (improved || !valSamples.length) {
      bestScore = monitoringStats.valScore;
      patience = 0;
      if (bestWeights) {
        bestWeights.forEach((tensor) => tensor.dispose());
      }
      bestWeights = model.getWeights().map((tensor) => tensor.clone());

      const now = Date.now();
      const shouldSave = epoch !== bestSavedEpoch && now - lastBestSaveMs > MIN_BEST_SAVE_INTERVAL_MS;
      if (shouldSave) {
        const tmpBestDir = path.join(runDir, "best_tmp");
        if (fs.existsSync(tmpBestDir)) {
          fs.rmSync(tmpBestDir, { recursive: true, force: true });
        }
        await saveModel(model, tmpBestDir);
        const meta = {
          epoch,
          bestScore,
          monitoring: monitoringStats,
          savedAt: new Date().toISOString(),
        };
        fs.writeFileSync(path.join(tmpBestDir, "best-meta.json"), JSON.stringify(meta, null, 2));
        if (fs.existsSync(bestDir)) {
          fs.rmSync(bestDir, { recursive: true, force: true });
        }
        fs.renameSync(tmpBestDir, bestDir);
        bestSavedEpoch = epoch;
        lastBestSaveMs = now;
        console.log(`Saved BEST checkpoint @ epoch ${epoch} score=${bestScore.toFixed(4)} -> ${bestDir}`);
      }
    } else {
      patience += 1;
      if (patience >= args.patience) {
        console.log(`Early stopping at epoch ${epoch}`);
        break;
      }
    }
  }

  if (args.swa && swaWeights) {
    model.setWeights(swaWeights);
    swaWeights.forEach((tensor) => tensor.dispose());
  } else if (bestWeights) {
    model.setWeights(bestWeights);
    bestWeights.forEach((tensor) => tensor.dispose());
  }

  disposeLoss();
  console.log(`Saving final production model to ${runDir}...`);
  await saveModel(model, runDir);
  fs.writeFileSync(path.join(runDir, "training-args.json"), JSON.stringify(args, null, 2));
  console.log("Production training complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
