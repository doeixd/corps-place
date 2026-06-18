import * as tf from "@tensorflow/tfjs-node";
import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const DB_PATH = "./dci-relational.db";
const MODEL_DIR = "./models/v7_curriculum";
const NORM_PATH = "./results/v7-curriculum-target-norm.json";
const JUDGE_INDEX_PATH = "./src/training/judgeIndexMap.json";
const CORPS_INDEX_PATH = "./src/training/corpsIndexMap.json";
const SEQ_LEN = 15;
const FEAT_DIM = 98;
const STATIC_DIM = 131;

const BATCH_SIZE = 32;
const EPOCHS = 500;
const EARLY_STOPPING_PATIENCE = 50;
const PADDING_INDEX = 3;
const CONSISTENCY_WEIGHT = 0.2;
const WIDTH_FLOOR_PTS = 0.5;
const WIDTH_FLOOR_WEIGHT = 0.05;
const SCORE_COVERAGE_TARGET = 0.8;
const SCORE_COVERAGE_WEIGHT = 2.0;
const EMA_ALPHA = 0.3;
const RESIDUAL_OFFSET = 18;

const CAPTION_STRIDE = 4;
const SAMPLES_PER_EPOCH = 4096;

const denormalize = (value: number, mean: number, std: number) => value * (std > 1e-6 ? std : 1) + mean;

function seededRandom(seed: number) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function shuffleArray<T>(array: T[], rng: () => number): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

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
    warmupEpochs: Number(get("--warmup-epochs") || 10),
    startEpoch: Number(get("--start-epoch") || 0),
    clipNorm: Number(get("--clip-norm") || 1.0),
    seed: Number(get("--seed", "42")),
    swa: get("--swa", "false") === "true",
    swaStart: Number(get("--swa-start", "0.75")),
    swaInterval: Number(get("--swa-interval", "1")),
    snapshotEpochs: get("--snapshot-epochs", ""),
    useMha: get("--use-mha", "false") === "true",
    widthFloorPts: Number(get("--width-floor-pts", `${WIDTH_FLOOR_PTS}`)),
    widthFloorWeight: Number(get("--width-floor-weight", `${WIDTH_FLOOR_WEIGHT}`)),
    valSplit: Number(get("--val-split", "0.05")), // Increased to 5% for more stable monitoring
    samplesPerEpoch: Number(get("--samples-per-epoch", `${SAMPLES_PER_EPOCH}`)),
    loadModel: get("--load-model"),
    // Logging
    logCsv: get("--log-csv", "./results/lstm-v6-production-training-log.csv"),
    trialId: get("--trial-id"),
  };
}

const JUDGE_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync(JUDGE_INDEX_PATH, "utf-8"));
const JUDGE_COUNT = Object.keys(JUDGE_INDEX_MAP).length;
const CORPS_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync(CORPS_INDEX_PATH, "utf-8"));
const CORPS_COUNT = Object.keys(CORPS_INDEX_MAP).length;

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
  judgeIndices: number[];
  corpsId: number;
  residuals: number[];
  recap: number[];
  total: number;
  division: string;
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

class V7LossScheduler {
  getWeights(epoch: number) {
    // Phase 1 (1-50): Focus on total/recap
    if (epoch < 48) {
      return { totalWeight: 1.0, recapWeight: 1.0, residualWeight: 0.0, quantileWeight: 0.0, consistencyWeight: 0.2, identityDropoutRate: 1.0 };
    }
    // Transition 1 (48-52): Smooth ramp
    if (epoch < 52) {
      const t = (epoch - 48) / 4; // 0 to 1
      return {
        totalWeight: 1.0 - 0.7 * t,  // 1.0 → 0.3
        recapWeight: 1.0 - 0.5 * t,  // 1.0 → 0.5
        residualWeight: 0.5 * t,     // 0.0 → 0.5
        quantileWeight: 0.0,
        consistencyWeight: 0.2,
        identityDropoutRate: 1.0
      };
    }
    // Phase 2 (52-148): Category alignment
    if (epoch < 148) {
      return { totalWeight: 0.3, recapWeight: 0.5, residualWeight: 0.5, quantileWeight: 0.0, consistencyWeight: 0.2, identityDropoutRate: 1.0 };
    }
    // Transition 2 (148-152): Ramp to Phase 3
    if (epoch < 152) {
      const t = (epoch - 148) / 4;
      return {
        totalWeight: 0.3 - 0.2 * t,  // 0.3 → 0.1
        recapWeight: 0.5 - 0.3 * t,  // 0.5 → 0.2
        residualWeight: 0.5 - 0.1 * t, // 0.5 → 0.4
        quantileWeight: 0.3 * t,     // 0.0 → 0.3
        consistencyWeight: 0.2,
        identityDropoutRate: 1.0     // Stay masked
      };
    }
    // Phase 3 (152-300): Full quantiles, identity ramp 1
    if (epoch < 300) {
      const t = (epoch - 152) / 148;
      const idDropout = 1.0 - 0.4 * t; // 1.0 → 0.6
      return {
        totalWeight: 0.1,
        recapWeight: 0.2,
        residualWeight: 0.4,
        quantileWeight: 0.3,
        consistencyWeight: 0.2,
        identityDropoutRate: idDropout
      };
    }
    // Phase 4 (300-500): Identity unmasking ramp 2
    const t = Math.min(1.0, (epoch - 300) / 200);
    const idDropout = 0.6 - 0.5 * t; // 0.6 → 0.1
    return {
      totalWeight: 0.1,
      recapWeight: 0.2,
      residualWeight: 0.4,
      quantileWeight: 0.3,
      consistencyWeight: 0.2,
      identityDropoutRate: idDropout
    };
  }
}

class SequenceDataProviderV7 {
  constructor(
    private rows: DataRow[],
    private epoch: number,
    private batchSize: number = BATCH_SIZE
  ) { }

  setEpoch(epoch: number) {
    this.epoch = epoch;
  }

  getSequenceLength(): number {
    if (this.epoch < 50) return 5;   // Phase 1
    return 15;                       // Phase 2/3/4
  }

  sampleRows(count: number, seed: number): DataRow[] {
    const worldRows = this.rows.filter(r => r.division === 'World Class');
    const openRows = this.rows.filter(r => r.division === 'Open Class');

    // Default to all if split is empty (shouldn't happen with proper data)
    if (openRows.length === 0) return this.sampleRandom(this.rows, count, seed);

    // Enforce ratio (e.g., 3:1 ratio -> 75% World, 25% Open)
    const openCount = Math.floor(count * 0.25);
    const worldCount = count - openCount;

    const batchWorld = this.sampleRandom(worldRows, worldCount, seed);
    const batchOpen = this.sampleRandom(openRows, openCount, seed + 1);

    return this.shuffle([...batchWorld, ...batchOpen], seed + 2);
  }

  private sampleRandom<T>(array: T[], n: number, seed: number): T[] {
    let len = array.length;
    if (n > len) n = len;
    const result = new Array(n);
    const taken = new Array(len);
    while (n--) {
      const x = Math.floor(this.seededRandom(seed++) * len);
      result[n] = array[x in taken ? taken[x] : x];
      taken[x] = --len in taken ? taken[len] : len;
    }
    return result;
  }

  private shuffle<T>(array: T[], seed: number): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(this.seededRandom(seed++) * (i + 1));
      [array[i], array[j]] = [array[j]!, array[i]!];
    }
    return array;
  }

  private seededRandom(seed: number) {
    const x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
  }
}

function buildDataRows(rows: Array<{ x_sequence_json: string; x_static_json: string; y_residuals_json: string; y_recap_json: string; judge_indices_json: string; division_name: string; corps_id: number }>) {
  const dataRows: DataRow[] = [];
  for (const row of rows) {
    const rawSeq = JSON.parse(row.x_sequence_json) as number[][];
    const seqMask = rawSeq.map((step) => step[PADDING_INDEX] !== 1);
    const seq = rawSeq.map((step) => (step[PADDING_INDEX] === 1 ? new Array(FEAT_DIM).fill(0) : step));
    const stat = JSON.parse(row.x_static_json) as number[];
    const judgeIndices = JSON.parse(row.judge_indices_json) as number[];
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

    dataRows.push({
      seq,
      seqMask,
      stat,
      judgeIndices,
      corpsId: row.corps_id ?? 0,
      residuals,
      recap: recapValues,
      total,
      division: row.division_name
    });
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
  xs: [number[][], number[], number[], number[], number];
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

function buildSamples(rows: DataRow[], stats: TargetStats, seqLen: number, identityDropoutRate: number, seed: number): Sample[] {
  const samples: Sample[] = [];
  const rng = seededRandom(seed);

  for (const row of rows) {
    const slicedSeq = row.seq.slice(-seqLen);
    const slicedMask = row.seqMask.slice(-seqLen).map((v) => (v ? 1 : 0));

    // Pad if sliced is shorter than SEQ_LEN (for TF input shape consistency)
    while (slicedSeq.length < SEQ_LEN) {
      slicedSeq.unshift(new Array(FEAT_DIM).fill(0));
      slicedMask.unshift(0);
    }
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

    // Apply Identity Dropout
    const corpsId = rng() < identityDropoutRate ? 0 : row.corpsId;

    samples.push({
      xs: [slicedSeq, row.stat, slicedMask, row.judgeIndices, corpsId],
      ys: [...residualTargets, ...recapValues, normalizedTotal],
    });
  }

  return samples;
}

type BatchedInputs = { [key: string]: tf.Tensor };

function createDataset(samples: Sample[], batchSize: number, shuffle: boolean, seed: number) {
  let dataset = tf.data.array(samples).map((sample) => ({
    xs: {
      sequence: tf.tensor(sample.xs[0], undefined, "float32"),
      static: tf.tensor(sample.xs[1], undefined, "float32"),
      mask: tf.tensor(sample.xs[2], [SEQ_LEN], "float32"),
      judge_ids: tf.tensor(sample.xs[3], [CAPTION_COUNT], "int32"),
      corps_id: tf.tensor([sample.xs[4]], [1], "int32"),
    },
    ys: tf.tensor(sample.ys, undefined, "float32"),
  }));

  if (shuffle) {
    dataset = dataset.shuffle(Math.min(samples.length, 1000), seed.toString(), true);
  }

  return dataset.batch(batchSize).prefetch(2);
}

// PERFORMANCE: Batched tensor creation - creates tensors once per batch instead of per sample
function buildBatchTensors(batchSamples: Sample[]): { xs: BatchedInputs; ys: tf.Tensor } {
  const batchSize = batchSamples.length;

  // Pre-allocate typed arrays for batch
  const sequenceData = new Float32Array(batchSize * SEQ_LEN * FEAT_DIM);
  const staticData = new Float32Array(batchSize * STATIC_DIM);
  const maskData = new Float32Array(batchSize * SEQ_LEN);
  const judgeIdsData = new Int32Array(batchSize * CAPTION_COUNT);
  const corpsIdData = new Int32Array(batchSize);
  const ysData = new Float32Array(batchSize * TARGET_DIM);

  for (let i = 0; i < batchSize; i++) {
    const sample = batchSamples[i]!;

    // Sequence: [batchSize, SEQ_LEN, FEAT_DIM]
    const seqFlat = sample.xs[0].flat();
    sequenceData.set(seqFlat, i * SEQ_LEN * FEAT_DIM);

    // Static: [batchSize, STATIC_DIM]
    staticData.set(sample.xs[1], i * STATIC_DIM);

    // Mask: [batchSize, SEQ_LEN]
    maskData.set(sample.xs[2], i * SEQ_LEN);

    // Judge IDs: [batchSize, CAPTION_COUNT]
    judgeIdsData.set(sample.xs[3], i * CAPTION_COUNT);

    // Corps ID: [batchSize]
    corpsIdData[i] = sample.xs[4];

    // Ys: [batchSize, TARGET_DIM]
    ysData.set(sample.ys, i * TARGET_DIM);
  }

  return {
    xs: {
      sequence: tf.tensor3d(sequenceData, [batchSize, SEQ_LEN, FEAT_DIM], "float32"),
      static: tf.tensor2d(staticData, [batchSize, STATIC_DIM], "float32"),
      mask: tf.tensor2d(maskData, [batchSize, SEQ_LEN], "float32"),
      judge_ids: tf.tensor2d(judgeIdsData, [batchSize, CAPTION_COUNT], "int32"),
      corps_id: tf.tensor2d(corpsIdData, [batchSize, 1], "int32"),
    },
    ys: tf.tensor2d(ysData, [batchSize, TARGET_DIM], "float32"),
  };
}

function* batchGenerator(samples: Sample[], batchSize: number, shuffle: boolean, seed: number): Generator<{ xs: BatchedInputs; ys: tf.Tensor }> {
  const rng = seededRandom(seed);
  const indices = shuffle ? shuffleArray([...Array(samples.length).keys()], rng) : [...Array(samples.length).keys()];

  for (let i = 0; i < indices.length; i += batchSize) {
    const batchIndices = indices.slice(i, i + batchSize);
    if (batchIndices.length === 0) continue;
    const batchSamples = batchIndices.map(idx => samples[idx]!);
    yield buildBatchTensors(batchSamples);
  }
}

function createLoss(stats: TargetStats, widthFloorPts: number, widthFloorWeight: number) {
  const recapMeanTensor = tf.tensor1d(stats.recapMean, "float32");
  const recapStdTensor = tf.tensor1d(stats.recapStd.map((value) => (value > 1e-6 ? value : 1)), "float32");
  const residualMeanTensor = tf.tensor1d(stats.residualMean, "float32");
  const residualStdTensor = tf.tensor1d(stats.residualStd.map((value) => (value > 1e-6 ? value : 1)), "float32");
  // Tempered weighting: alpha=0.5 (square root of inverse variance weighting)
  const residualWeightTensor = tf.pow(tf.tensor1d(stats.residualWeights, "float32"), tf.scalar(0.5));
  const recapWeightTensor = tf.tensor1d(stats.recapWeights, "float32");
  const totalMeanTensor = tf.scalar(stats.totalMean);
  const totalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

  const lossFn = (yTrue: tf.Tensor, yPred: tf.Tensor, weights: { totalWeight: number, recapWeight: number, residualWeight: number, quantileWeight: number, consistencyWeight: number }, returnComponents = false) =>
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

      const weightedQ10 = tf.mean(q10Loss);
      const weightedQ50 = weightedCaptionMean(q50Loss as tf.Tensor2D, residualWeightTensor as tf.Tensor1D);
      const weightedQ90 = tf.mean(q90Loss);

      const residualLoss = tf.add(
        tf.mul(tf.scalar(weights.residualWeight), weightedQ50),
        tf.mul(tf.scalar(weights.quantileWeight), tf.add(weightedQ10, weightedQ90))
      );

      const recapError = tf.sub(recapTrue, recapPred);
      const recapSq = tf.square(recapError) as tf.Tensor2D;
      const recapLoss = tf.mul(tf.scalar(weights.recapWeight), weightedCaptionMean(recapSq, recapWeightTensor));

      const totalError = tf.sub(totalTrue, totalPred);
      const totalLoss = tf.mul(tf.scalar(weights.totalWeight), tf.mean(tf.square(totalError)));

      const recapDenorm = tf.add(tf.mul(recapPred, recapStdTensor), recapMeanTensor);
      const totalDenorm = tf.add(tf.mul(totalPred, totalStdTensor), totalMeanTensor).reshape([-1]);
      const recapSum = tf.sum(recapDenorm, 1);
      const diff = tf.abs(tf.sub(recapSum, totalDenorm));
      const consistencyLoss = tf.mul(tf.scalar(weights.consistencyWeight), tf.mean(tf.div(diff, tf.add(tf.abs(totalDenorm), tf.scalar(1e-6)))));

      const q10Denorm = tf.add(tf.mul(residualPredQ10, residualStdTensor), residualMeanTensor);
      const q90Denorm = tf.add(tf.mul(residualPredQ90, residualStdTensor), residualMeanTensor);
      const widthPts = tf.sub(q90Denorm, q10Denorm);
      const widthShortfall = tf.relu(tf.sub(tf.scalar(widthFloorPts), widthPts));
      const widthPenalty = tf.mean(tf.square(widthShortfall));

      const total = tf.addN([
        residualLoss,
        recapLoss,
        totalLoss,
        consistencyLoss,
        // Gate width floor by quantile weight to prevent destabilizing early phases
        tf.mul(tf.scalar(widthFloorWeight * (weights.quantileWeight > 0 ? 1 : 0)), widthPenalty),
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
  console.log("Loading V7 Curriculum sequence data...");

  const result = await client.execute(`
    SELECT season, corps_key, corps_id, x_sequence_json, x_static_json, judge_indices_json, y_residuals_json, y_recap_json, division_name, split
    FROM ml_sequence_rows_v7
  `);

  const rawRows = result.rows as unknown as Array<{
    season: string;
    corps_key: string;
    corps_id: number;
    x_sequence_json: string;
    x_static_json: string;
    judge_indices_json: string;
    y_residuals_json: string;
    y_recap_json: string;
    division_name: string;
    split: string;
  }>;
  client.close();

  const allDataRows = buildDataRows(rawRows);
  // V7: Split logic - include everything except "test" in potential training
  const nonTestRows = allDataRows.filter((row, idx) => rawRows[idx].split !== "test");
  const testRows = allDataRows.filter((row, idx) => rawRows[idx].split === "test");

  // Determine train/val via custom split for better production monitoring
  const valRng = seededRandom(args.seed);
  const shuffled = shuffleArray([...nonTestRows], valRng);
  const valCount = Math.max(1, Math.floor(shuffled.length * args.valSplit));

  const valRows = shuffled.slice(0, valCount);
  const trainRows = shuffled.slice(valCount);

  const trainSubset = args.maxRows ? trainRows.slice(0, args.maxRows) : trainRows;
  const valSubset = args.maxRows ? valRows.slice(0, Math.min(args.maxRows, valRows.length)) : valRows;

  if (!trainSubset.length) {
    throw new Error("Missing train data for V7 model.");
  }

  const stats = computeTargetStats(trainSubset);
  fs.writeFileSync(NORM_PATH, JSON.stringify(stats, null, 2));
  console.log(`Saved normalization stats to ${NORM_PATH}`);

  // Default to full sequence length for initial sample building if needed (but we build per epoch now)
  const initialTrainSamples = buildSamples(trainSubset, stats, SEQ_LEN, 1.0, args.seed);
  const initialValSamples = buildSamples(valSubset, stats, SEQ_LEN, 1.0, args.seed + 1);
  const baselines = initialValSamples.length ? computeBaselineMae(initialValSamples, stats) : { baselineZero: 0, baselineMean: 0, baselineEma: 0 };

  const testStep = initialTrainSamples[0]?.xs[0][0];
  if (testStep && testStep.length !== FEAT_DIM) {
    throw new Error(`Feature dimension mismatch: expected ${FEAT_DIM}, got ${testStep.length}`);
  }

  console.log(`V7 Splits -> Train: ${trainRows.length}, Val: ${valRows.length}, Test: ${testRows.length}`);
  if (args.maxRows) {
    console.log(`Using maxRows=${args.maxRows} for quick training.`);
  }
  if (initialValSamples.length) {
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
  const judgeIdsInput = tf.input({ shape: [CAPTION_COUNT], dtype: "int32", name: "judge_ids" });
  const corpsIdInput = tf.input({ shape: [1], dtype: "int32", name: "corps_id" });

  // Judge Embeddings
  const judgeEmbedding = tf.layers.embedding({
    inputDim: JUDGE_COUNT + 1,
    outputDim: 16,
    embeddingsRegularizer: tf.regularizers.l2({ l2: 1e-5 }),
    name: "judge_embedding",
  }).apply(judgeIdsInput) as tf.SymbolicTensor;
  const judgeFlat = tf.layers.flatten().apply(judgeEmbedding) as tf.SymbolicTensor;

  // Corps Embedding
  const corpsEmbedding = tf.layers.embedding({
    inputDim: CORPS_COUNT + 1,
    outputDim: 16,
    embeddingsRegularizer: tf.regularizers.l2({ l2: 1e-5 }),
    name: "corps_embedding",
  }).apply(corpsIdInput) as tf.SymbolicTensor;
  const corpsFlat = tf.layers.flatten().apply(corpsEmbedding) as tf.SymbolicTensor;

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

  const concat = tf.layers.concatenate().apply([contextFlat, staticInput, judgeFlat, corpsFlat]) as tf.SymbolicTensor;

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

  const model = tf.model({ inputs: [seqInput, staticInput, maskInput, judgeIdsInput, corpsIdInput], outputs: output });

  if (args.loadModel) {
    if (fs.existsSync(args.loadModel)) {
      console.log(`Loading weights from ${args.loadModel}...`);
      const weightsPath = path.join(args.loadModel, "weights.bin");
      const modelJsonPath = path.join(args.loadModel, "model.json");
      if (fs.existsSync(weightsPath) && fs.existsSync(modelJsonPath)) {
        const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, "utf-8"));
        const weightSpecs = modelJson.weightsManifest[0].weights;
        const weightBuffer = fs.readFileSync(weightsPath);
        const weights: tf.Tensor[] = [];
        let offset = 0;
        for (const spec of weightSpecs) {
          const byteLength = spec.shape.reduce((a: number, b: number) => a * b, 1) * 4;
          const data = new Float32Array(weightBuffer.buffer, weightBuffer.byteOffset + offset, byteLength / 4);
          weights.push(tf.tensor(data, spec.shape));
          offset += byteLength;
        }
        model.setWeights(weights);
        console.log("Successfully loaded weights.");
      } else {
        console.warn(`Could not find model.json or weights.bin in ${args.loadModel}`);
      }
    } else {
      console.warn(`Load model path does not exist: ${args.loadModel}`);
    }
  }

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

  const scheduler = new V7LossScheduler();
  const provider = new SequenceDataProviderV7(trainSubset, 0, args.batchSize);

  // PERFORMANCE: Cache validation samples outside the epoch loop (deterministic: seqLen=15, identityDropout=0.0)
  const cachedValSamples = buildSamples(valSubset, stats, 15, 0.0, args.seed + 999);
  console.log(`Cached ${cachedValSamples.length} validation samples (seqLen=15, identityDropout=0.0)`);

  // PERFORMANCE: Create stat tensors once and reuse across epochs
  const valResidualMeanTensor = tf.tensor1d(stats.residualMean, "float32");
  const valResidualStdTensor = tf.tensor1d(stats.residualStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const valRecapStdTensor = tf.tensor1d(stats.recapStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const valTotalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

  for (let epoch = args.startEpoch; epoch < args.startEpoch + args.epochs; epoch++) {
    provider.setEpoch(epoch);
    const weights = scheduler.getWeights(epoch);
    const seqLen = provider.getSequenceLength();

    const epochSamples = buildSamples(provider.sampleRows(args.samplesPerEpoch, args.seed + epoch), stats, seqLen, weights.identityDropoutRate, args.seed + epoch);

    console.log(`\nEpoch ${epoch}: Weights ${JSON.stringify(weights)}, SeqLen ${seqLen}`);

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
    let trainCount = 0;

    // PERFORMANCE: Use batch generator instead of tf.data for training
    for (const batch of batchGenerator(epochSamples, args.batchSize, true, args.seed + epoch)) {
      const xs = batch.xs;
      const ys = batch.ys;
      const batchSize = ys.shape[0] ?? 0;

      const { value, grads } = tf.variableGrads(() =>
        tf.tidy(() => {
          const preds = model.predict([
            xs.sequence,
            xs.static,
            xs.mask,
            xs.judge_ids,
            xs.corps_id
          ]) as tf.Tensor;
          return lossFn(ys, preds, weights) as tf.Scalar;
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
      trainCount += batchSize;

      value.dispose();
      gradList.forEach((grad: tf.Tensor) => grad.dispose());
      clipped.forEach((grad) => grad.dispose());
      Object.values(xs).forEach((t) => t.dispose());
      ys.dispose();
    }

    let monitoringStats = {
      valScore: 0,
      valMaePoints: 0,
      valRecapMae: 0,
      valTotalMae: 0,
      coverage: 0,
      widthNorm: 0,
      widthFloorPct: 0
    };

    const captionMaePointsSum = new Array(CAPTION_COUNT).fill(0);
    const captionCoverageWithin = new Array(CAPTION_COUNT).fill(0);
    const captionWidthSum = new Array(CAPTION_COUNT).fill(0);
    const captionCount = new Array(CAPTION_COUNT).fill(0);

    if (cachedValSamples.length) {
      // PERFORMANCE: Use batch generator with cached val samples
      let valLossSum = 0;
      let valMaeSum = 0;
      let valMaePointsSum = 0;
      let valRecapMaeSum = 0;
      let valTotalMaeSum = 0;
      let coverageCount = 0;
      let coverageWithin = 0;
      let intervalWidthSum = 0;
      let widthNormSum = 0;
      let widthFloorCount = 0;
      let valCountTotal = 0;

      // PERFORMANCE: Use batch generator and cached stat tensors (valResidualMeanTensor, etc.)
      for (const batch of batchGenerator(cachedValSamples, args.batchSize, false, args.seed)) {
        const xs = batch.xs;
        const ys = batch.ys;
        const batchSize = ys.shape[0] ?? 0;

        const preds = model.predict([
          xs.sequence,
          xs.static,
          xs.mask,
          xs.judge_ids,
          xs.corps_id
        ]) as tf.Tensor;
        const lossTensor = lossFn(ys, preds, weights) as tf.Tensor;
        const lossValue = lossTensor.dataSync()[0] ?? 0;
        const maeTensor = computeMaeFromPreds(preds, ys);
        const maeValue = maeTensor.dataSync()[0] ?? 0;

        const predQ10 = preds.slice([0, 0], [-1, CAPTION_COUNT]);
        const predQ50 = preds.slice([0, CAPTION_COUNT], [-1, CAPTION_COUNT]);
        const predQ90 = preds.slice([0, CAPTION_COUNT * 2], [-1, CAPTION_COUNT]);
        const trueResidual = ys.slice([0, 0], [-1, CAPTION_COUNT]);
        const predDenorm = tf.add(tf.mul(predQ50, valResidualStdTensor), valResidualMeanTensor);
        const trueDenorm = tf.add(tf.mul(trueResidual, valResidualStdTensor), valResidualMeanTensor);
        const maePointsTensor = tf.mean(tf.abs(tf.sub(predDenorm, trueDenorm)));
        const maePointsValue = maePointsTensor.dataSync()[0] ?? 0;

        const predRecap = preds.slice([0, RESIDUAL_DIM], [-1, RECAP_DIM]);
        const trueRecap = ys.slice([0, CAPTION_COUNT], [-1, RECAP_DIM]);
        const recapMaePointsTensor = tf.mean(tf.mul(valRecapStdTensor, tf.abs(tf.sub(predRecap, trueRecap))));
        const recapMae = recapMaePointsTensor.dataSync()[0] ?? 0;

        const predTotal = preds.slice([0, RESIDUAL_DIM + RECAP_DIM], [-1, TOTAL_DIM]);
        const trueTotal = ys.slice([0, CAPTION_COUNT + RECAP_DIM], [-1, TOTAL_DIM]);
        const totalMaePointsTensor = tf.mean(tf.mul(valTotalStdTensor, tf.abs(tf.sub(predTotal, trueTotal))));
        const totalMae = totalMaePointsTensor.dataSync()[0] ?? 0;

        const predQ10Denorm = tf.add(tf.mul(predQ10, valResidualStdTensor), valResidualMeanTensor);
        const predQ90Denorm = tf.add(tf.mul(predQ90, valResidualStdTensor), valResidualMeanTensor);
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

        // Per-caption stats
        const capMaeTensor = tf.abs(tf.sub(predDenorm, trueDenorm));
        const capMaeValues = capMaeTensor.mean(0).dataSync();
        const capWithinValues = withinFloat.sum(0).dataSync();
        const capWidthTensor = tf.sub(upper, lower);
        const capWidthValues = capWidthTensor.mean(0).dataSync();

        for (let i = 0; i < CAPTION_COUNT; i++) {
          captionMaePointsSum[i] += (capMaeValues[i] ?? 0) * batchSize;
          captionCoverageWithin[i] += capWithinValues[i] ?? 0;
          captionWidthSum[i] += (capWidthValues[i] ?? 0) * batchSize;
          captionCount[i] += batchSize;
        }
        capMaeTensor.dispose();
        capWidthTensor.dispose();

        valLossSum += lossValue * batchSize;
        valMaeSum += maeValue * batchSize;
        valMaePointsSum += maePointsValue * batchSize;
        valRecapMaeSum += recapMae * batchSize;
        valTotalMaeSum += totalMae * batchSize;
        coverageWithin += withinCount;
        coverageCount += batchSize * CAPTION_COUNT;
        intervalWidthSum += intervalWidth * (batchSize * CAPTION_COUNT);
        widthNormSum += widthNormValue * batchSize;
        widthFloorCount += widthFloorCountBatch;
        valCountTotal += batchSize;

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
        predRecap.dispose();
        trueRecap.dispose();
        recapMaePointsTensor.dispose();
        predTotal.dispose();
        trueTotal.dispose();
        totalMaePointsTensor.dispose();
        preds.dispose();
        Object.values(xs).forEach((t) => t.dispose());
        ys.dispose();
      }

      // PERFORMANCE: Cached stat tensors disposed at end of training, not per-epoch

      const valMaePoints = valCountTotal ? valMaePointsSum / valCountTotal : 0;
      const valRecapMae = valCountTotal ? valRecapMaeSum / valCountTotal : 0;
      const valTotalMae = valCountTotal ? valTotalMaeSum / valCountTotal : 0;
      const coverage = coverageCount ? coverageWithin / coverageCount : 0;
      const underCoverage = Math.max(0, SCORE_COVERAGE_TARGET - coverage);

      // Phase-aware monitoring
      let valScore: number;
      if (weights.residualWeight === 0) {
        // Phase 1: Only monitor total/recap MAE
        valScore = valRecapMae + valTotalMae;
      } else {
        // Phase 2+: Residual MAE + Coverage
        valScore = valMaePoints + SCORE_COVERAGE_WEIGHT * underCoverage;
      }

      monitoringStats = {
        valScore,
        valMaePoints,
        valRecapMae,
        valTotalMae,
        coverage,
        widthNorm: (valCountTotal * CAPTION_COUNT) ? intervalWidthSum / (valCountTotal * CAPTION_COUNT) : 0,
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
      `recap_mae_pts=${monitoringStats.valRecapMae.toFixed(4)} ` +
      `total_mae_pts=${monitoringStats.valTotalMae.toFixed(4)} ` +
      `mon_cov=${monitoringStats.coverage.toFixed(3)} ` +
      `mon_score=${monitoringStats.valScore.toFixed(4)} ` +
      `time=${elapsed}s`
    );

    // Periodic Per-Caption Logging
    if (weights.residualWeight > 0 && ((epoch + 1) % 50 === 0 || epoch === 0)) {
      console.log(`\n--- CAPTION STATS (Epoch ${epoch}) ---`);
      for (let i = 0; i < CAPTION_COUNT; i++) {
        const capMae = captionCount[i] ? captionMaePointsSum[i] / captionCount[i]! : 0;
        const capCov = captionCount[i] ? captionCoverageWithin[i]! / captionCount[i]! : 0;
        const capWidth = captionCount[i] ? captionWidthSum[i] / captionCount[i]! : 0;
        console.log(`${CAPTIONS[i]}: mae=${capMae.toFixed(4)}, cov=${capCov.toFixed(3)}, width=${capWidth.toFixed(4)}`);
      }
      console.log("----------------------------------\n");
    }

    const improved = monitoringStats.valScore < bestScore - 1e-4;

    if (improved || !initialValSamples.length) {
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

  // PERFORMANCE: Dispose cached stat tensors
  valResidualMeanTensor.dispose();
  valResidualStdTensor.dispose();
  valRecapStdTensor.dispose();
  valTotalStdTensor.dispose();

  console.log(`Saving final production model to ${runDir}...`);
  await saveModel(model, runDir);
  fs.writeFileSync(path.join(runDir, "training-args.json"), JSON.stringify(args, null, 2));

  // FINAL TEST EVALUATION PASS
  if (testRows.length > 0) {
    console.log("\n--- FINAL TEST EVALUATION ---");
    const testSamples = buildSamples(testRows, stats, SEQ_LEN, 0.0, 42); // 0.0 dropout for test
    let testMaePointsSum = 0;
    let testRecapMaeSum = 0;
    let testTotalMaeSum = 0;
    let testCoverageWithin = 0;
    let testWidthSum = 0;
    let testWidthFloorCount = 0;
    let testCount = 0;

    // Create stat tensors for test eval
    const testResidualMeanTensor = tf.tensor1d(stats.residualMean, "float32");
    const testResidualStdTensor = tf.tensor1d(stats.residualStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
    const testRecapStdTensor = tf.tensor1d(stats.recapStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
    const testTotalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

    // PERFORMANCE: Use batch generator for test eval
    for (const batch of batchGenerator(testSamples, args.batchSize, false, 42)) {
      const xs = batch.xs;
      const ys = batch.ys;
      const batchSize = ys.shape[0] ?? 0;
      const preds = model.predict([xs.sequence, xs.static, xs.mask, xs.judge_ids, xs.corps_id]) as tf.Tensor;

      const predQ50 = preds.slice([0, CAPTION_COUNT], [-1, CAPTION_COUNT]);
      const trueResidual = ys.slice([0, 0], [-1, CAPTION_COUNT]);
      const predDenorm = tf.add(tf.mul(predQ50, testResidualStdTensor), testResidualMeanTensor);
      const trueDenorm = tf.add(tf.mul(trueResidual, testResidualStdTensor), testResidualMeanTensor);
      const maePoints = tf.mean(tf.abs(tf.sub(predDenorm, trueDenorm))).dataSync()[0] ?? 0;

      const predRecap = preds.slice([0, RESIDUAL_DIM], [-1, RECAP_DIM]);
      const trueRecap = ys.slice([0, CAPTION_COUNT], [-1, RECAP_DIM]);
      const recapMae = tf.mean(tf.mul(testRecapStdTensor, tf.abs(tf.sub(predRecap, trueRecap)))).dataSync()[0] ?? 0;

      const predTotal = preds.slice([0, RESIDUAL_DIM + RECAP_DIM], [-1, TOTAL_DIM]);
      const trueTotal = ys.slice([0, CAPTION_COUNT + RECAP_DIM], [-1, TOTAL_DIM]);
      const totalMae = tf.mean(tf.mul(testTotalStdTensor, tf.abs(tf.sub(predTotal, trueTotal)))).dataSync()[0] ?? 0;

      const predQ10 = preds.slice([0, 0], [-1, CAPTION_COUNT]);
      const predQ90 = preds.slice([0, CAPTION_COUNT * 2], [-1, CAPTION_COUNT]);
      const predQ10Denorm = tf.add(tf.mul(predQ10, testResidualStdTensor), testResidualMeanTensor);
      const predQ90Denorm = tf.add(tf.mul(predQ90, testResidualStdTensor), testResidualMeanTensor);
      const lower = tf.minimum(predQ10Denorm, predQ90Denorm);
      const upper = tf.maximum(predQ10Denorm, predQ90Denorm);
      const within = tf.logicalAnd(trueDenorm.greaterEqual(lower), trueDenorm.lessEqual(upper));
      const withinCount = tf.cast(within, "float32").sum().dataSync()[0] ?? 0;
      const intervalWidth = tf.mean(tf.sub(upper, lower)).dataSync()[0] ?? 0;
      const widthFloorMask = tf.less(tf.sub(predQ90Denorm, predQ10Denorm), tf.scalar(args.widthFloorPts));
      const widthFloorCountBatch = tf.sum(tf.cast(widthFloorMask, "float32")).dataSync()[0] ?? 0;

      testMaePointsSum += maePoints * batchSize;
      testRecapMaeSum += recapMae * batchSize;
      testTotalMaeSum += totalMae * batchSize;
      testCoverageWithin += withinCount;
      testWidthSum += intervalWidth * (batchSize * CAPTION_COUNT);
      testWidthFloorCount += widthFloorCountBatch;
      testCount += batchSize;

      preds.dispose();
      predQ10.dispose();
      predQ50.dispose();
      predQ90.dispose();
      trueResidual.dispose();
      predRecap.dispose();
      trueRecap.dispose();
      predTotal.dispose();
      trueTotal.dispose();
      predDenorm.dispose();
      trueDenorm.dispose();
      predQ10Denorm.dispose();
      predQ90Denorm.dispose();
      lower.dispose();
      upper.dispose();
      within.dispose();
      widthFloorMask.dispose();
      Object.values(xs).forEach(t => t.dispose());
      ys.dispose();
    }
    testResidualMeanTensor.dispose();
    testResidualStdTensor.dispose();
    testRecapStdTensor.dispose();
    testTotalStdTensor.dispose();

    const finalTestMae = testCount ? testMaePointsSum / testCount : 0;
    const finalTestRecap = testCount ? testRecapMaeSum / testCount : 0;
    const finalTestTotal = testCount ? testTotalMaeSum / testCount : 0;
    const finalTestCov = (testCount * CAPTION_COUNT) ? testCoverageWithin / (testCount * CAPTION_COUNT) : 0;
    const finalTestWidth = (testCount * CAPTION_COUNT) ? testWidthSum / (testCount * CAPTION_COUNT) : 0;
    const finalTestWidthFloorPct = (testCount * CAPTION_COUNT) ? testWidthFloorCount / (testCount * CAPTION_COUNT) : 0;

    console.log(`TEST RESULTS: residual_mae_pts=${finalTestMae.toFixed(4)}, recap_mae_pts=${finalTestRecap.toFixed(4)}, total_mae_pts=${finalTestTotal.toFixed(4)}, coverage=${finalTestCov.toFixed(3)}, width=${finalTestWidth.toFixed(4)}, width_floor_pct=${finalTestWidthFloorPct.toFixed(3)}`);
    fs.writeFileSync(path.join(runDir, "test-results.json"), JSON.stringify({ finalTestMae, finalTestRecap, finalTestTotal, finalTestCov, finalTestWidth, finalTestWidthFloorPct }, null, 2));
  }

  console.log("Production training complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
