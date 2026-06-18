/**
 * trainModelV8: Performance-Optimized Hierarchical Model
 * 
 * DESIGN: Delta-Primary Architecture
 * - Predicts Q10/Q50/Q90 deltas relative to baseline (historical EMA).
 * - Derives absolute Recap, Category, and Total scores via fixed linear layers.
 * - This ensures 100% mathematical consistency across all heads by design.
 * - Incorporates Trend Features (slope of last 3 shows) into static context.
 */
/* * DCI DOMAIN & SCORING SUMMARY * * Drum Corps International (DCI) competitions involve marching corps (units like "Blue Devils") * competing in divisions (World Class, Open Class, All-Age). Each competition produces a "Recap" * showing how judges scored each corps. * * SCORING HIERARCHY (100 points total): * * 1. CATEGORIES (3 main pillars): * - General Effect (GE): 40.00 pts * - Visual: 30.00 pts * - Music: 30.00 pts * * 2. CAPTIONS (specific disciplines): * - GE: GE1 (20pts), GE2 (20pts) * - Visual: Visual Proficiency, Visual Analysis, Color Guard (20pts each) * - Music: Music Analysis, Brass, Percussion (20pts each) * * 3. JUDGES: Each caption is evaluated by 1+ judges (often 2 for GE1, GE2, MA, Percussion) * * 4. SUBCAPTIONS: Each judge gives 2 scores: * - Content (Repertoire): Difficulty/quality of design * - Achievement (Performance): Execution quality * * SCORING ALGORITHM: * - GE: Avg(GE1_JudgeA, GE1_JudgeB) + Avg(GE2_JudgeA, GE2_JudgeB) = GE Score * - Visual: (Analysis + Proficiency + ColorGuard) / 2 = Visual Score * - Music: (Avg(Analysis) + Avg(Brass) + Avg(Percussion)) / 2 = Music Score * - Total: GE + Visual + Music - Penalties * * This model predicts: * - Delta quantiles (Q10, Q50, Q90) for caption-level residuals * - Absolute recap scores for 8 captions: [GE1, GE2, VP, VA, CG, MB, MA, MP] * - Category totals: [GE, Visual, Music] * - Total score */
import * as tf from "@tensorflow/tfjs-node";
import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const DB_PATH = "./dci-relational.db";
const MODEL_DIR = "./models/v8_curriculum";
const NORM_PATH = "./results/v8-curriculum-target-norm.json";
const JUDGE_INDEX_PATH = "./src/training/judgeIndexMap.json";
const CORPS_INDEX_PATH = "./src/training/corpsIndexMap.json";
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const CAPTION_COUNT = CAPTIONS.length;
const SEQ_LEN = 15;
const FEAT_DIM = 98;
const RAW_STATIC_DIM = 131;
const TREND_DIM = CAPTION_COUNT;
const TOTAL_STATIC_DIM = RAW_STATIC_DIM + TREND_DIM; // 131 + 8 = 139

// Note: STATIC_DIM in buildDataRows refers to the DB column, while model expects TOTAL_STATIC_DIM 
const BATCH_SIZE = 32;
const EPOCHS = 500;
const EARLY_STOPPING_PATIENCE = 50;
const PADDING_INDEX = 3;
const CONSISTENCY_WEIGHT = 0.2;
const FINAL_CONSISTENCY_WEIGHT = 0.5; // Phase 9
const WIDTH_FLOOR_PTS = 0.5;
const WIDTH_FLOOR_WEIGHT = 0.05;
const SCORE_COVERAGE_TARGET = 0.8;
const SCORE_COVERAGE_WEIGHT = 0.1; // Phase 4: Reduced from 2.0
const EMA_ALPHA = 0.3;
const RECAP_OFFSET_IN_FEATS = 18;
const CAPTION_STRIDE = 4;

const SAMPLES_PER_EPOCH = 4096;
const WIDTH_TARGET_PTS = 2.5;
const UNK_CORPS_ID = 0;
const DELTA_DIM = CAPTION_COUNT * 3; // Quantiles for delta

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
const RECAP_DIM = CAPTION_COUNT;
const CATEGORY_DIM = 3; // GE, Visual, Music
const TOTAL_DIM = 1;
const OUTPUT_DIM = DELTA_DIM + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM;
const TARGET_DIM = CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM + TOTAL_DIM;


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

      // Safety check for NaNs (though we control the mask generation, this is good practice)
      // if (tf.any(tf.isNaN(masked)).dataSync()[0]) console.warn("MaskedSoftmax produced NaNs before softmax");

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

class NegationLayer extends tf.layers.Layer {
  static className = "NegationLayer";
  constructor(config?: any) {
    super(config || {});
  }
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape | tf.Shape[] { return inputShape as tf.Shape; }
  call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor | tf.Tensor[] {
    return tf.tidy(() => tf.neg(Array.isArray(inputs) ? inputs[0] : inputs));
  }
  getConfig() { return { ...super.getConfig() }; }
}
tf.serialization.registerClass(NegationLayer);

interface DerivationConfig {
  deltaMean: number[];
  deltaStd: number[];
  recapMean: number[];
  recapStd: number[];
  categoryMean: number[];
  categoryStd: number[];
  totalMean: number;
  totalStd: number;
}

class RecapLayer extends tf.layers.Layer {
  static className = "RecapLayer";
  private A: tf.Tensor;
  private C: tf.Tensor;

  constructor(config: any) {
    super(config);
    const stats = config.stats as DerivationConfig;
    this.A = tf.tensor1d(stats.deltaStd.map((std, i) => (std / (stats.recapStd[i]! > 1e-6 ? stats.recapStd[i]! : 1))));
    this.C = tf.tensor1d(stats.deltaMean.map((m, i) => m / (stats.recapStd[i]! > 1e-6 ? stats.recapStd[i]! : 1)));
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return (inputShape as tf.Shape[])[0];
  }

  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [delta, base] = inputs as [tf.Tensor, tf.Tensor];
      return tf.add(tf.add(tf.mul(delta, this.A), base), this.C);
    });
  }
}
tf.serialization.registerClass(RecapLayer);

class CategoryLayer extends tf.layers.Layer {
  static className = "CategoryLayer";
  private catA: tf.Tensor;
  private catC: tf.Tensor;

  constructor(config: any) {
    super(config);
    const stats = config.stats as DerivationConfig;
    const MatrixM = [
      [1, 1, 0, 0, 0, 0, 0, 0], // GE
      [0, 0, 0.5, 0.5, 0.5, 0, 0, 0], // Visual
      [0, 0, 0, 0, 0, 0.5, 0.5, 0.5]  // Music
    ] as number[][];

    this.catA = tf.tensor2d(MatrixM.map((row, i) =>
      row.map((val, j) => val * stats.recapStd[j]! / (stats.categoryStd[i]! > 1e-6 ? stats.categoryStd[i]! : 1))
    )).transpose();

    this.catC = tf.tensor1d(MatrixM.map((row, i) => {
      const pts = row.reduce((acc, val, j) => acc + val * stats.recapMean[j]!, 0);
      return (pts - stats.categoryMean[i]!) / (stats.categoryStd[i]! > 1e-6 ? stats.categoryStd[i]! : 1);
    }));
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape = inputShape as number[];
    return [shape[0], 3];
  }

  call(inputs: tf.Tensor | tf.Tensor[]) {
    const recap = Array.isArray(inputs) ? inputs[0]! : (inputs as tf.Tensor);
    return tf.tidy(() => {
      const r2 = (recap.rank === 1) ? recap.expandDims(0) : recap;
      return tf.add(tf.matMul(r2, this.catA), this.catC);
    });
  }
}
tf.serialization.registerClass(CategoryLayer);

class TotalLayer extends tf.layers.Layer {
  static className = "TotalLayer";
  private totalA: tf.Tensor;
  private totalC: tf.Tensor;

  constructor(config: any) {
    super(config);
    const stats = config.stats as DerivationConfig;
    this.totalA = tf.tensor1d(stats.categoryStd.map(std => std / (stats.totalStd > 1e-6 ? stats.totalStd : 1)));
    const totalCVal = (stats.categoryMean.reduce((a, b) => a + b, 0) - stats.totalMean) / (stats.totalStd > 1e-6 ? stats.totalStd : 1);
    this.totalC = tf.scalar(totalCVal);
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape = Array.isArray(inputShape[0]) ? inputShape[0] : (inputShape as number[]);
    return [shape[0], 1];
  }

  call(inputs: tf.Tensor | tf.Tensor[]) {
    const cat = Array.isArray(inputs) ? inputs[0]! : (inputs as tf.Tensor);
    return tf.tidy(() => {
      const r2 = (cat.rank === 1) ? cat.expandDims(0) : cat;
      return tf.add(tf.sum(tf.mul(r2, this.totalA), 1, true), this.totalC);
    });
  }
}
tf.serialization.registerClass(TotalLayer);

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
    recurrentDropout: Number(get("--recurrent-dropout", "0.1")),
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
if (CORPS_INDEX_MAP["unknown"] !== UNK_CORPS_ID) {
  throw new Error(`Expected corps unknown to be index ${UNK_CORPS_ID}, got ${CORPS_INDEX_MAP["unknown"]}`);
}
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

const coverageWeight = (epoch: number, start: number, ramp: number, maxW: number) => {
  if (epoch < start) return 0;
  const t = Math.min(1, (epoch - start) / Math.max(1, ramp));
  // smoothstep ramp
  return maxW * t * t * (3 - 2 * t);
};

type DataRow = {
  seq: number[][];
  seqMask: boolean[];
  stat: number[];
  judgeIndices: number[];
  corpsId: number;
  residuals: number[]; // Renamed from recapTargets to avoid confusion with actual targets
  recap: number[];
  total: number;
  division: string;
  split: string;
};

type TargetStats = {
  deltaMean: number[];   // MEAN(RecapActual - Baseline)
  deltaStd: number[];
  recapMean: number[];
  recapStd: number[];
  categoryMean: number[]; // [GE, Visual, Music]
  categoryStd: number[];
  totalMean: number;
  totalStd: number;
  deltaWeights: number[];
  recapWeights: number[];
};

class V8LossScheduler {
  getWeights(epoch: number) {
    // Phase 1 (1-40): Delta Q50 warming up. Quantiles & Widths restricted.
    if (epoch < 40) {
      return {
        totalWeight: 0.1, recapWeight: 0.1, deltaWeight: 1.0, categoryWeight: 0.1,
        quantileWeight: 0.0, consistencyWeight: 0.2, identityDropoutRate: 1.0
      };
    }
    // Phase 2 (40-100): Early unmasking + Quantile/Width introduction
    if (epoch < 100) {
      const t = (epoch - 40) / 60;
      return {
        totalWeight: 0.1, recapWeight: 0.1, deltaWeight: 1.0, categoryWeight: 0.1,
        quantileWeight: 0.05 + 0.1 * t, consistencyWeight: 0.2 + 0.3 * t,
        identityDropoutRate: 1.0 - 0.7 * t // Ramp down to 0.3
      };
    }
    // Phase 3 (100+): High-capacity Quantiles + Minimized ID Dropout
    const t = Math.min(1.0, (epoch - 100) / 200);
    return {
      totalWeight: 0.1, recapWeight: 0.1, deltaWeight: 1.0, categoryWeight: 0.1,
      quantileWeight: 0.2, consistencyWeight: 0.5,
      identityDropoutRate: 0.3 - 0.2 * t // Final settle at 0.1
    };
  }
}

class SequenceDataProviderV7 {
  private worldRows: DataRow[];
  private openRows: DataRow[];

  constructor(
    private rows: DataRow[],
    private epoch: number,
    private batchSize: number = BATCH_SIZE
  ) {
    this.worldRows = this.rows.filter(r => r.division === 'World Class');
    this.openRows = this.rows.filter(r => r.division === 'Open Class');
  }

  setEpoch(epoch: number) {
    this.epoch = epoch;
  }

  getSequenceLength(): number {
    if (this.epoch < 50) return 5;   // Phase 1
    return 15;                       // Phase 2/3/4
  }

  sampleRows(count: number, seed: number): DataRow[] {
    // Default to all if split is empty (shouldn't happen with proper data)
    if (this.openRows.length === 0) return this.sampleRandom(this.rows, count, seed);

    // Enforce ratio (e.g., 3:1 ratio -> 75% World, 25% Open)
    const openCount = Math.floor(count * 0.25);
    const worldCount = count - openCount;

    const batchWorld = this.sampleRandom(this.worldRows, worldCount, seed);
    const batchOpen = this.sampleRandom(this.openRows, openCount, seed + 1);

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

function buildDataRows(rows: Array<{ x_sequence_json: string; x_static_json: string; y_residuals_json: string; y_recap_json: string; judge_indices_json: string; division_name: string; corps_id: number; split: string }>) {
  const dataRows: DataRow[] = [];
  for (const row of rows) {
    const rawSeq = JSON.parse(row.x_sequence_json) as number[][];
    const seqMask = rawSeq.map((step) => step[PADDING_INDEX] !== 1);
    const seq = rawSeq.map((step) => (step[PADDING_INDEX] === 1 ? new Array(FEAT_DIM).fill(0) : step));
    const stat = JSON.parse(row.x_static_json) as number[];
    const judgeIndices = JSON.parse(row.judge_indices_json) as number[];
    const resids = JSON.parse(row.y_residuals_json) as Record<string, number>;
    const recap = JSON.parse(row.y_recap_json) as Record<string, number>;

    if (seq.length !== SEQ_LEN || (seq[0] && seq[0].length !== FEAT_DIM)) continue;
    if (stat.length !== RAW_STATIC_DIM) continue;

    const residuals: number[] = [];
    const recapValues: number[] = [];
    for (const caption of CAPTIONS) {
      const recapValue = recap[caption] ?? 0;
      // FIX: Use recap as the "residual" signal because DB residuals are broken (GE1 offset by -16)
      // This effectively makes the model predict: Recap(t) = EMA_Recap(t-1) + Delta
      const residual = recapValue; // WAS: resids[caption] ?? 0;
      residuals.push(residual);
      recapValues.push(recapValue);
    }

    // Phase 16: DCI Correct Total Calculation
    const ge = (recap["GE1"] ?? 0) + (recap["GE2"] ?? 0);
    const visual = ((recap["VP"] ?? 0) + (recap["VA"] ?? 0) + (recap["CG"] ?? 0)) / 2;
    const music = ((recap["MB"] ?? 0) + (recap["MA"] ?? 0) + (recap["MP"] ?? 0)) / 2;
    const total = ge + visual + music;

    dataRows.push({
      seq,
      seqMask,
      stat,
      judgeIndices,
      corpsId: row.corps_id ?? 0,
      residuals, // Renamed from recapTargets
      recap: recapValues,
      total,
      division: row.division_name,
      split: row.split
    });
  }

  return dataRows;
}

function computeTargetStats(rows: DataRow[]): TargetStats {
  const deltaSeries = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const recapSeries = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const categorySeries = Array.from({ length: 3 }, () => [] as number[]); // GE, Visual, Music
  const totalSeries: number[] = [];

  for (const row of rows) {
    // Determine history for baseline (EMA)
    // EXCLUDE last valid step to avoid leakage (assuming it's the target show)
    const validSteps = row.seq.filter((_, i) => row.seqMask[i]);
    const historySteps = validSteps.length > 0 ? validSteps.slice(0, -1) : [];

    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      const history = historySteps.map(step => getRecapFromStep(step, idx));
      const baselineRaw = history.length ? computeEma(history, EMA_ALPHA) : 0;

      const rawRecap = row.recap[idx] ?? 0;
      const deltaRaw = rawRecap - baselineRaw;

      deltaSeries[idx]!.push(deltaRaw);
      recapSeries[idx]!.push(rawRecap);
    }

    // Category Totals
    const ge = (row.recap[0] ?? 0) + (row.recap[1] ?? 0);
    const visual = ((row.recap[2] ?? 0) + (row.recap[3] ?? 0) + (row.recap[4] ?? 0)) / 2;
    const music = ((row.recap[5] ?? 0) + (row.recap[6] ?? 0) + (row.recap[7] ?? 0)) / 2;

    categorySeries[0]!.push(ge);
    categorySeries[1]!.push(visual);
    categorySeries[2]!.push(music);

    totalSeries.push(row.total);
  }

  const deltaMean = deltaSeries.map(mean);
  const deltaStd = deltaSeries.map(std);
  const recapMean = recapSeries.map(mean);
  const recapStd = recapSeries.map(std);
  const categoryMean = categorySeries.map(mean);
  const categoryStd = categorySeries.map(std);
  const totalMean = mean(totalSeries);
  const totalStd = std(totalSeries);

  const minStd = 0.25;
  const deltaWeights = deltaStd.map((value) => 1 / Math.max(value ?? 0, minStd));
  const recapWeights = recapStd.map((value) => 1 / Math.max(value ?? 0, minStd));

  return {
    deltaMean,
    deltaStd,
    recapMean,
    recapStd,
    categoryMean,
    categoryStd,
    totalMean,
    totalStd,
    deltaWeights,
    recapWeights,
  };
}

function normalizeValue(value: number, meanValue: number, stdValue: number) {
  if (!Number.isFinite(stdValue) || stdValue < 1e-6) return 0;
  return (value - meanValue) / stdValue;
}

type Sample = {
  xs: [number[][], number[], number[], number[], number, number[]]; // Added baseline recap vector
  ys: number[]; // delta targets (8) + recap targets (8) + category targets (3) + total (1)
};

function getRecapFromStep(step: number[], captionIndex: number): number {
  // Per-caption block: [captionScore-baseline, captionRank, normalizedScore, normalizedDelta]
  const normalizedScore = step[RECAP_OFFSET_IN_FEATS + 2 + captionIndex * CAPTION_STRIDE] ?? 0;
  return normalizedScore * 20;
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
      // Truth Recap (absolute)
      const truthRecapNorm = sample.ys[CAPTION_COUNT + idx] ?? 0;
      const actual = denormalize(truthRecapNorm, stats.recapMean[idx]!, stats.recapStd[idx]!);

      const historyFull = steps.map((step) => getRecapFromStep(step, idx));
      // Phase 11: Fix leakage. Exclude the last valid step (the label target).
      const history = historyFull.length > 0 ? historyFull.slice(0, -1) : [];
      const ema = history.length ? computeEma(history, EMA_ALPHA) : 0;
      const meanPred = stats.recapMean[idx] ?? 0;

      zeroSum += Math.abs(actual);
      meanSum += Math.abs(actual - meanPred);
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

function buildSamples(rows: DataRow[], stats: TargetStats, seqLen: number, identityDropoutRate: number, seed: number, epoch: number = 0): Sample[] {
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

    // Phase 11: Prevent unnecessary cloning. 
    // Only clone if any recap features (indices relevant to score) are non-zero.
    const lastValidIdx = slicedMask.lastIndexOf(1);
    if (lastValidIdx !== -1) {
      const originalStep = slicedSeq[lastValidIdx]!;
      let needsZeroing = false;

      // Check for leakage in the caption feature slots
      for (let i = 0; i < CAPTION_COUNT; i++) {
        const base = RECAP_OFFSET_IN_FEATS + i * CAPTION_STRIDE;
        for (let j = 0; j < CAPTION_STRIDE; j++) {
          if (originalStep[base + j] !== 0) {
            needsZeroing = true;
            break;
          }
        }
        if (needsZeroing) break;
      }

      if (needsZeroing) {
        // Clone the step to avoid mutating the shared reference (which would poison the dataset)
        const step = [...originalStep];
        // Zero the entire caption feature block for the last step.
        for (let i = 0; i < CAPTION_COUNT; i++) {
          const base = RECAP_OFFSET_IN_FEATS + i * CAPTION_STRIDE;
          for (let j = 0; j < CAPTION_STRIDE; j++) {
            step[base + j] = 0;
          }
        }
        slicedSeq[lastValidIdx] = step;
      }

    }

    // Compute Recap Baseline (EMA of history in this window)
    const validSteps = slicedSeq.filter((_, i) => slicedMask[i] === 1);
    const baselineRecapVector: number[] = [];

    // Compute targets (Delta)
    const deltaTargets: number[] = [];
    const recapValues: number[] = [];

    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      // Baseline calculation (Recap history: EXCLUDE current step to avoid leakage)
      const historyFull = validSteps.map((step) => getRecapFromStep(step, idx));
      const history = historyFull.length > 0 ? historyFull.slice(0, -1) : [];
      const baselineRaw = history.length ? computeEma(history, EMA_ALPHA) : 0;
      // We normalize baseline using recap stats
      const baselineNorm = normalizeValue(baselineRaw, stats.recapMean[idx]!, stats.recapStd[idx]!);
      baselineRecapVector.push(baselineNorm);

      // Delta calculation: actualRecap - baselineRecap
      const rawRecap = row.recap[idx] ?? 0;
      const deltaRaw = rawRecap - baselineRaw;

      const normalizedDelta = normalizeValue(deltaRaw, stats.deltaMean[idx]!, stats.deltaStd[idx]!);
      deltaTargets.push(normalizedDelta);

      const normalizedRecap = normalizeValue(rawRecap, stats.recapMean[idx]!, stats.recapStd[idx]!);
      recapValues.push(normalizedRecap);
    }

    // Category Targets (Option A: ABSOLUTE totals)
    const geRaw = (row.recap[0] ?? 0) + (row.recap[1] ?? 0);
    const visualRaw = ((row.recap[2] ?? 0) + (row.recap[3] ?? 0) + (row.recap[4] ?? 0)) / 2;
    const musicRaw = ((row.recap[5] ?? 0) + (row.recap[6] ?? 0) + (row.recap[7] ?? 0)) / 2;

    const categoryTargets = [
      normalizeValue(geRaw, stats.categoryMean[0]!, stats.categoryStd[0]!),
      normalizeValue(visualRaw, stats.categoryMean[1]!, stats.categoryStd[1]!),
      normalizeValue(musicRaw, stats.categoryMean[2]!, stats.categoryStd[2]!)
    ];

    const normalizedTotal = normalizeValue(row.total, stats.totalMean, stats.totalStd || 1);

    // Phase 12: Trend Features (Slope of last 3 shows)
    const trendFeatures: number[] = [];
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      const historyFull = validSteps.map((step) => getRecapFromStep(step, idx));
      const history = historyFull.length > 0 ? historyFull.slice(0, -1) : []; // Exclude target
      const last3 = history.slice(-3);
      const slope = last3.length >= 2 ? (last3[last3.length - 1]! - last3[0]!) / (last3.length - 1) : 0;
      // Normalize slope (0.1 points per show is a reasonable heuristic unit)
      trendFeatures.push(slope / 0.1);
    }

    // Apply Identity Dropout
    if (row.corpsId < 0 || row.corpsId >= CORPS_COUNT) {
      // In production we might warn, but here we fail fast
      throw new Error(`corps_id out of range: ${row.corpsId}`);
    }
    // Phase 11: Gate leak detector. Only run on 1/64 samples on specific epochs.
    if ((epoch === 0 || epoch % 50 === 0) && rng() < 1 / 64) {
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        const rawRecap = row.recap[idx] ?? 0;
        const historyFull = validSteps.map((step) => getRecapFromStep(step, idx));
        const history = historyFull.length > 0 ? historyFull.slice(0, -1) : [];
        const baselineRaw = history.length ? computeEma(history, EMA_ALPHA) : 0;
        if (Math.abs(rawRecap - baselineRaw) < 1e-6 && rawRecap !== 0 && history.length > 0) {
          // Warning: potential leakage detected
        }
      }
    }

    const corpsId = rng() < identityDropoutRate ? UNK_CORPS_ID : row.corpsId;

    samples.push({
      xs: [slicedSeq, [...row.stat, ...trendFeatures], slicedMask, row.judgeIndices, corpsId, baselineRecapVector],
      ys: [...deltaTargets, ...recapValues, ...categoryTargets, normalizedTotal],
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
      baseline_recap: tf.tensor(sample.xs[5], [CAPTION_COUNT], "float32"),
    },
    ys: tf.tensor(sample.ys, undefined, "float32"),
  }));

  if (shuffle) {
    dataset = dataset.shuffle(Math.min(samples.length, 1000), seed.toString(), true);
  }

  return dataset.batch(batchSize).prefetch(2);
}

// Persistent buffers to reduce GC pressure
let sequenceBuffer: Float32Array | null = null;
let staticBuffer: Float32Array | null = null;
let maskBuffer: Float32Array | null = null;
let judgeIdsBuffer: Int32Array | null = null;
let corpsIdBuffer: Int32Array | null = null;
let baselineBuffer: Float32Array | null = null;
let ysBuffer: Float32Array | null = null;
let currentBufferSize = 0;

// PERFORMANCE: Batched tensor creation - creates tensors once per batch instead of per sample
function buildBatchTensors(batchSamples: Sample[]): { xs: BatchedInputs; ys: tf.Tensor } {
  const batchSize = batchSamples.length;

  if (batchSize > currentBufferSize) {
    sequenceBuffer = new Float32Array(batchSize * SEQ_LEN * FEAT_DIM);
    staticBuffer = new Float32Array(batchSize * TOTAL_STATIC_DIM);
    maskBuffer = new Float32Array(batchSize * SEQ_LEN);
    judgeIdsBuffer = new Int32Array(batchSize * CAPTION_COUNT);
    corpsIdBuffer = new Int32Array(batchSize);
    baselineBuffer = new Float32Array(batchSize * CAPTION_COUNT);
    ysBuffer = new Float32Array(batchSize * TARGET_DIM);
    currentBufferSize = batchSize;
  }

  const sequenceData = sequenceBuffer!.subarray(0, batchSize * SEQ_LEN * FEAT_DIM);
  const staticData = staticBuffer!.subarray(0, batchSize * TOTAL_STATIC_DIM);
  const maskData = maskBuffer!.subarray(0, batchSize * SEQ_LEN);
  const judgeIdsData = judgeIdsBuffer!.subarray(0, batchSize * CAPTION_COUNT);
  const corpsIdData = corpsIdBuffer!.subarray(0, batchSize);
  const baselineData = baselineBuffer!.subarray(0, batchSize * CAPTION_COUNT);
  const ysData = ysBuffer!.subarray(0, batchSize * TARGET_DIM);

  for (let i = 0; i < batchSize; i++) {
    const sample = batchSamples[i]!;

    // Assertions
    if (sample.xs[3].length !== CAPTION_COUNT) throw new Error(`Invalid judge_ids length at index ${i}`);
    if (sample.xs[5].length !== CAPTION_COUNT) throw new Error(`Invalid baseline_recap length at index ${i}`);

    // OPTIMIZATION: Write directly to typed arrays instead of .flat()
    const seq = sample.xs[0];
    for (let s = 0; s < SEQ_LEN; s++) {
      const step = seq[s]!;
      const offset = (i * SEQ_LEN + s) * FEAT_DIM;
      for (let f = 0; f < FEAT_DIM; f++) {
        sequenceData[offset + f] = step[f] ?? 0;
      }
    }

    // Static: [batchSize, TOTAL_STATIC_DIM]
    staticData.set(sample.xs[1], i * TOTAL_STATIC_DIM);

    // Mask: [batchSize, SEQ_LEN]
    maskData.set(sample.xs[2], i * SEQ_LEN);

    // Bounds check: Clamp judge and corps indices
    const judgeIds = sample.xs[3];
    for (let j = 0; j < CAPTION_COUNT; j++) {
      const id = judgeIds[j]!;
      // Phase 12/15: Range Safety Assertions for training. 
      // Note: JUDGE_COUNT is the length of the index map. Max valid index is JUDGE_COUNT - 1.
      // But usually embeddings use size=N and indices [0, N-1].
      if (id < 0 || id >= JUDGE_COUNT) {
        throw new Error(`Judge ID ${id} out of range (max valid index ${JUDGE_COUNT - 1})`);
      }
      judgeIdsData[i * CAPTION_COUNT + j] = id;
    }

    const rawCorpsId = sample.xs[4];
    if (rawCorpsId < 0 || rawCorpsId > CORPS_COUNT) throw new Error(`Corps ID ${rawCorpsId} out of range (max ${CORPS_COUNT})`);
    corpsIdData[i] = Math.max(0, Math.min(rawCorpsId, CORPS_COUNT - 1));

    // Baseline: [batchSize, CAPTION_COUNT]
    baselineData.set(sample.xs[5], i * CAPTION_COUNT);

    // Ys: [batchSize, TARGET_DIM]
    ysData.set(sample.ys, i * TARGET_DIM);
  }

  return {
    xs: {
      sequence: tf.tensor3d(sequenceData, [batchSize, SEQ_LEN, FEAT_DIM], "float32"),
      static: tf.tensor2d(staticData, [batchSize, TOTAL_STATIC_DIM], "float32"),
      mask: tf.tensor2d(maskData, [batchSize, SEQ_LEN], "float32"),
      judge_ids: tf.tensor2d(judgeIdsData, [batchSize, CAPTION_COUNT], "int32"),
      corps_id: tf.tensor2d(corpsIdData, [batchSize, 1], "int32"),
      baseline_recap: tf.tensor2d(baselineData, [batchSize, CAPTION_COUNT], "float32"),
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
  const deltaMeanTensor = tf.tensor1d(stats.deltaMean, "float32");
  const deltaStdTensor = tf.tensor1d(stats.deltaStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const categoryMeanTensor = tf.tensor1d(stats.categoryMean, "float32");
  const categoryStdTensor = tf.tensor1d(stats.categoryStd.map((v) => (v > 1e-6 ? v : 1)), "float32");

  // Tempered weighting: alpha=0.5 (square root of inverse variance weighting)
  const deltaWeightTensor = tf.pow(tf.tensor1d(stats.deltaWeights, "float32"), tf.scalar(0.5));
  const recapWeightTensor = tf.tensor1d(stats.recapWeights, "float32");
  const totalMeanTensor = tf.scalar(stats.totalMean);
  const totalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

  const lossFn = (yTrue: tf.Tensor, yPred: tf.Tensor, weights: { totalWeight: number, recapWeight: number, deltaWeight: number, categoryWeight: number, quantileWeight: number, consistencyWeight: number }, returnComponents = false) =>
    tf.tidy(() => {
      const deltaTrue = yTrue.slice([0, 0], [-1, CAPTION_COUNT]);
      const recapTrue = yTrue.slice([0, CAPTION_COUNT], [-1, RECAP_DIM]);
      const categoryTrue = yTrue.slice([0, CAPTION_COUNT + RECAP_DIM], [-1, CATEGORY_DIM]);
      const totalTrue = yTrue.slice([0, CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM], [-1, TOTAL_DIM]);

      const deltaPred = yPred.slice([0, 0], [-1, DELTA_DIM]);
      const recapPred = yPred.slice([0, DELTA_DIM], [-1, RECAP_DIM]);
      const categoryPred = yPred.slice([0, DELTA_DIM + RECAP_DIM], [-1, CATEGORY_DIM]);
      const totalPred = yPred.slice([0, DELTA_DIM + RECAP_DIM + CATEGORY_DIM], [-1, TOTAL_DIM]);

      const deltaPredQ10 = deltaPred.slice([0, 0], [-1, CAPTION_COUNT]);
      const deltaPredQ50 = deltaPred.slice([0, CAPTION_COUNT], [-1, CAPTION_COUNT]);
      const deltaPredQ90 = deltaPred.slice([0, CAPTION_COUNT * 2], [-1, CAPTION_COUNT]);

      const err10 = tf.sub(deltaTrue, deltaPredQ10);
      const err50 = tf.sub(deltaTrue, deltaPredQ50);
      const err90 = tf.sub(deltaTrue, deltaPredQ90);

      const q10Loss = tf.maximum(tf.mul(0.1, err10), tf.mul(-0.9, err10));
      const q50Loss = tf.maximum(tf.mul(0.5, err50), tf.mul(-0.5, err50));
      const q90Loss = tf.maximum(tf.mul(0.9, err90), tf.mul(-0.1, err90));

      const weightedCaptionMean = (lossByCap: tf.Tensor2D, weights: tf.Tensor1D) => {
        const perCap = tf.mean(lossByCap, 0);
        const denom = tf.maximum(tf.sum(weights), tf.scalar(1e-8));
        return tf.div(tf.sum(tf.mul(perCap, weights)), denom);
      };

      // Phase 7: Apply inverse-variance weighting to ALL quantiles
      const weightedQ10 = weightedCaptionMean(q10Loss as tf.Tensor2D, deltaWeightTensor as tf.Tensor1D);
      const weightedQ50 = weightedCaptionMean(q50Loss as tf.Tensor2D, deltaWeightTensor as tf.Tensor1D);
      const weightedQ90 = weightedCaptionMean(q90Loss as tf.Tensor2D, deltaWeightTensor as tf.Tensor1D);

      const deltaLoss = tf.add(
        tf.mul(tf.scalar(weights.deltaWeight), weightedQ50),
        tf.mul(tf.scalar(weights.quantileWeight), tf.add(weightedQ10, weightedQ90))
      );

      const recapError = tf.sub(recapTrue, recapPred);
      const recapSq = tf.square(recapError) as tf.Tensor2D;
      const recapLoss = tf.mul(tf.scalar(weights.recapWeight), weightedCaptionMean(recapSq, recapWeightTensor));

      const categoryError = tf.sub(categoryTrue, categoryPred);
      const categoryLoss = tf.mul(tf.scalar(weights.categoryWeight), tf.mean(tf.square(categoryError)));

      const totalError = tf.sub(totalTrue, totalPred);
      const totalLoss = tf.mul(tf.scalar(weights.totalWeight), tf.mean(tf.square(totalError)));

      // Hierarchical Consistency
      const recapDenorm = tf.add(tf.mul(recapPred, recapStdTensor), recapMeanTensor);
      const categoryDenorm = tf.add(tf.mul(categoryPred, categoryStdTensor), categoryMeanTensor);
      const totalDenorm = tf.add(tf.mul(totalPred, totalStdTensor), totalMeanTensor).reshape([-1]);

      // Level 1: Subcaptions -> Category
      const geRecapSum = tf.add(recapDenorm.slice([0, 0], [-1, 1]), recapDenorm.slice([0, 1], [-1, 1])).reshape([-1]);
      // Phase 16: Fix Visual/Music aggregation to half-sum
      const visualRecap = tf.mul(0.5, tf.sum(recapDenorm.slice([0, 2], [-1, 3]), 1));
      const musicRecap = tf.mul(0.5, tf.sum(recapDenorm.slice([0, 5], [-1, 3]), 1));

      const gePredValue = categoryDenorm.slice([0, 0], [-1, 1]).reshape([-1]);
      const visualPredValue = categoryDenorm.slice([0, 1], [-1, 1]).reshape([-1]);
      const musicPredValue = categoryDenorm.slice([0, 2], [-1, 1]).reshape([-1]);

      const l1Consistency = tf.addN([
        tf.mean(tf.abs(tf.sub(geRecapSum, gePredValue))),
        tf.mean(tf.abs(tf.sub(visualRecap, visualPredValue))),
        tf.mean(tf.abs(tf.sub(musicRecap, musicPredValue)))
      ]);

      // Level 2: Category -> Total
      const categorySum = tf.add(tf.add(gePredValue, visualPredValue), musicPredValue);
      const l2Consistency = tf.mean(tf.abs(tf.sub(categorySum, totalDenorm)));

      const consistencyLoss = tf.mul(tf.scalar(weights.consistencyWeight), tf.add(l1Consistency, l2Consistency));

      const q10Denorm = tf.add(tf.mul(deltaPredQ10, deltaStdTensor), deltaMeanTensor);
      const q90Denorm = tf.add(tf.mul(deltaPredQ90, deltaStdTensor), deltaMeanTensor);
      const widthPts = tf.sub(q90Denorm, q10Denorm);

      // Phase 4: Width Prior
      // Target width = 2.56 * sigma (Gaussian 90-10 interval)
      const targetWidth = tf.mul(deltaStdTensor, 2.56);
      const widthPriorError = tf.sub(widthPts, targetWidth);
      const widthPriorLoss = tf.mean(tf.square(widthPriorError));

      // Phase 4/14: Hybrid Width Floor
      // Floor = max(widthFloorPts, 0.2 * sigma)
      const sigmaFloor = tf.mul(deltaStdTensor, 0.2);
      const widthFloor = tf.maximum(tf.scalar(widthFloorPts), sigmaFloor);
      const widthShortfall = tf.relu(tf.sub(widthFloor, widthPts));
      const widthPenalty = tf.mean(tf.square(widthShortfall));

      const total = tf.addN([
        deltaLoss,
        recapLoss,
        categoryLoss,
        totalLoss,
        // consistencyLoss, // Removed from gradient (mathematically redundant due to architecture)
        // Gate width floor/prior by quantile weight to prevent destabilizing early phases
        tf.mul(tf.scalar(widthFloorWeight * (weights.quantileWeight > 0 ? 1 : 0)), widthPenalty),
        tf.mul(tf.scalar(weights.quantileWeight), widthPriorLoss) // Add width prior
      ]);

      return total;
    });

  const dispose = () => {
    recapMeanTensor.dispose();
    recapStdTensor.dispose();
    deltaMeanTensor.dispose();
    deltaStdTensor.dispose();
    deltaWeightTensor.dispose();
    recapWeightTensor.dispose();
    categoryMeanTensor.dispose();
    categoryStdTensor.dispose();
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
  const nonTestRows = allDataRows.filter((row) => row.split !== "test");
  const testRows = allDataRows.filter((row) => row.split === "test");

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

  // Phase 13: Feature Index Audit
  if (initialValSamples.length > 0) {
    const auditSample = initialValSamples[0]!;
    const lastValidIdx = auditSample.xs[2].lastIndexOf(1);
    if (lastValidIdx !== -1) {
      const step = auditSample.xs[0][lastValidIdx]!;
      let leaked = false;
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        const base = RECAP_OFFSET_IN_FEATS + idx * CAPTION_STRIDE;
        for (let j = 0; j < CAPTION_STRIDE; j++) {
          if ((step[base + j] ?? 0) !== 0) {
            leaked = true;
            console.error(`\nAUDIT FAILURE: Leak detector failed at caption ${idx}, offset ${j}`);
          }
        }
      }
      if (!leaked) {
        console.log(`\nAUDIT SUCCESS: Leakage prevention verified for caption blocks`);
      }
    }
  }


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
      `Baselines (monitoring forecast MAE): zero=${baselines.baselineZero.toFixed(4)}, ` +
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
  const staticInput = tf.input({ shape: [TOTAL_STATIC_DIM], name: "static" });
  const judgeIdsInput = tf.input({ shape: [CAPTION_COUNT], dtype: "int32", name: "judge_ids" });
  const corpsIdInput = tf.input({ shape: [1], dtype: "int32", name: "corps_id" });
  const baselineInput = tf.input({ shape: [CAPTION_COUNT], name: "baseline_recap" });

  // Judge Embeddings
  const judgeEmbedding = tf.layers.embedding({
    inputDim: JUDGE_COUNT,
    outputDim: 16,
    embeddingsRegularizer: tf.regularizers.l2({ l2: 1e-4 }), // Phase 3: Stronger L2
    name: "judge_embedding",
  }).apply(judgeIdsInput) as tf.SymbolicTensor;
  const judgeFlat = tf.layers.flatten().apply(judgeEmbedding) as tf.SymbolicTensor;

  // Corps Embedding
  const corpsEmbedding = tf.layers.embedding({
    inputDim: CORPS_COUNT,
    outputDim: 16,
    embeddingsRegularizer: tf.regularizers.l2({ l2: 1e-5 }),
    name: "corps_embedding",
  }).apply(corpsIdInput) as tf.SymbolicTensor;
  const corpsFlat = tf.layers.flatten().apply(corpsEmbedding) as tf.SymbolicTensor;

  /* Phase 9: Removed masking layer as we have explicit maskInput for attention.
     Masking layers can accidentally mask valid zero-feature steps. */
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
    .apply(seqInput) as tf.SymbolicTensor;


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
  // Phase 14: Weighted Sum Attention
  // Input 1: attentionWeights [B, SEQ_LEN, 1]
  // Input 2: attentionInput   [B, SEQ_LEN, H]
  // Dot along axis 1 (time) produces [B, 1, H]
  const context = tf.layers.dot({ axes: 1, name: "attention_dot" }).apply([attentionWeights, attentionInput]) as tf.SymbolicTensor;
  const contextFlat = tf.layers.flatten().apply(context) as tf.SymbolicTensor;

  // Phase 1: Add baseline to inputs
  const concat = tf.layers.concatenate().apply([contextFlat, staticInput, judgeFlat, corpsFlat, baselineInput]) as tf.SymbolicTensor;

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

  // Phase 2: Strength Head (from context)
  const strength = tf.layers.dense({ units: 16, activation: "relu", name: "strength" }).apply(contextFlat) as tf.SymbolicTensor;

  const skipConcat = tf.layers.concatenate().apply([d2Drop, staticInput, strength]) as tf.SymbolicTensor;

  // Phase 3: Judge Mixed Effects
  const judgeBias = tf.layers.dense({ units: CAPTION_COUNT, name: "judge_bias", kernelRegularizer: tf.regularizers.l2({ l2: 1e-4 }) }).apply(judgeFlat) as tf.SymbolicTensor;

  // Phase 12: Delta-Primary Architecture
  // The model primarily predicts DELTA. 
  // recap = baseline_recap + delta_q50
  // Derived Categories and Total ensure consistency by design.

  const deltaQ50Base = tf.layers.dense({
    units: CAPTION_COUNT,
    name: "delta_q50_base",
    kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg })
  }).apply(skipConcat) as tf.SymbolicTensor;

  const deltaQ50 = tf.layers.add({ name: "delta_q50" }).apply([deltaQ50Base, judgeBias]) as tf.SymbolicTensor;

  // Predict widths instead of absolute q10/q90 to enforce q10 < q50 < q90
  const q10WidthLayer = tf.layers.dense({
    units: CAPTION_COUNT,
    name: "q10_width_raw",
    biasInitializer: tf.initializers.constant({ value: -3 })
  });
  const q90WidthLayer = tf.layers.dense({
    units: CAPTION_COUNT,
    name: "q90_width_raw",
    biasInitializer: tf.initializers.constant({ value: -3 })
  });
  const widthConcat = tf.layers.concatenate({ name: "width_concat" }).apply([skipConcat, judgeFlat]) as tf.SymbolicTensor;
  const q10WidthRaw = q10WidthLayer.apply(widthConcat) as tf.SymbolicTensor;
  const q90WidthRaw = q90WidthLayer.apply(widthConcat) as tf.SymbolicTensor;

  const q10Width = tf.layers.activation({ activation: "softplus", name: "q10_width" }).apply(q10WidthRaw) as tf.SymbolicTensor;
  const q90Width = tf.layers.activation({ activation: "softplus", name: "q90_width" }).apply(q90WidthRaw) as tf.SymbolicTensor;

  // q10_delta = delta_q50 - q10_width
  const q10WidthNeg = new NegationLayer({ name: "q10_width_neg" }).apply(q10Width) as tf.SymbolicTensor;

  const q10Delta = tf.layers.add({ name: "q10_delta" }).apply([deltaQ50, q10WidthNeg]) as tf.SymbolicTensor;
  const q90Delta = tf.layers.add({ name: "q90_delta" }).apply([deltaQ50, q90Width]) as tf.SymbolicTensor;

  // Derivation of absolute recap: recap_norm = baseline_norm + A * delta_q50 + C
  const recapHead = new RecapLayer({ name: "recap_head", stats }).apply([deltaQ50, baselineInput]) as tf.SymbolicTensor;

  // Category Derivation
  const categoryHead = new CategoryLayer({ name: "category_head", stats }).apply(recapHead) as tf.SymbolicTensor;

  // Total Derivation
  const totalHead = new TotalLayer({ name: "total_head", stats }).apply(categoryHead) as tf.SymbolicTensor;

  const output = tf.layers
    .concatenate({ name: "output" })
    .apply([q10Delta, deltaQ50, q90Delta, recapHead, categoryHead, totalHead]) as tf.SymbolicTensor;

  const model = tf.model({ inputs: [seqInput, staticInput, maskInput, judgeIdsInput, corpsIdInput, baselineInput], outputs: output });

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

  // Phase 16: Derivation Exactness Check
  console.log("\n--- DERIVATION EXACTNESS CHECK ---");
  tf.tidy(() => {
    const testBaselineRecap = tf.zeros([1, CAPTION_COUNT]);
    const dummySeq = tf.zeros([1, SEQ_LEN, FEAT_DIM]);
    const dummyStatic = tf.zeros([1, TOTAL_STATIC_DIM]);
    const dummyMask = tf.ones([1, SEQ_LEN]);
    const dummyJudgeIds = tf.zeros([1, CAPTION_COUNT], "int32");
    const dummyCorpsId = tf.zeros([1, 1], "int32");

    const testOutputs = model.predict([
      dummySeq,
      dummyStatic,
      dummyMask,
      dummyJudgeIds,
      dummyCorpsId,
      testBaselineRecap
    ]) as tf.Tensor[];

    const outputTensor = (testOutputs as unknown) as tf.Tensor;
    if (!outputTensor || outputTensor.shape[1] !== 36) {
      throw new Error(`DERIVATION CHECK FAILED: Unexpected output shape ${outputTensor?.shape}`);
    }

    // output = [q10_delta(8), q50_delta(8), q90_delta(8), recap(8), cat(3), total(1)]
    const derivedRecapNorm = outputTensor.slice([0, 24], [-1, 8]);
    const derivedCatNorm = outputTensor.slice([0, 32], [-1, 3]);
    const derivedTotalNorm = outputTensor.slice([0, 35], [-1, 1]);

    const recapDataNorm = Array.from(derivedRecapNorm.dataSync());
    const catDataNorm = Array.from(derivedCatNorm.dataSync());
    const totDataNorm = Array.from(derivedTotalNorm.dataSync());

    // Denormalize Recap for point-space formula verification
    const recapPts = recapDataNorm.map((v, i) => v * stats.recapStd[i]! + stats.recapMean[i]!);
    const catPts = catDataNorm.map((v, i) => v * stats.categoryStd[i]! + stats.categoryMean[i]!);
    const totPts = totDataNorm[0]! * stats.totalStd + stats.totalMean;

    const expectedGE = recapPts[0]! + recapPts[1]!;
    const expectedVisual = (recapPts[2]! + recapPts[3]! + recapPts[4]!) / 2;
    const expectedMusic = (recapPts[5]! + recapPts[6]! + recapPts[7]!) / 2;
    const expectedTotal = expectedGE + expectedVisual + expectedMusic;

    console.log("Recap Points:", recapPts.map(v => v.toFixed(2)));
    console.log(`GE: Derived=${catPts[0]?.toFixed(2)}, Expected=${expectedGE.toFixed(2)}`);
    console.log(`Visual: Derived=${catPts[1]?.toFixed(2)}, Expected=${expectedVisual.toFixed(2)}`);
    console.log(`Music: Derived=${catPts[2]?.toFixed(2)}, Expected=${expectedMusic.toFixed(2)}`);
    console.log(`Total: Derived=${totPts.toFixed(2)}, Expected=${expectedTotal.toFixed(2)}`);

    if (Math.abs(catPts[0]! - expectedGE) > 0.05 ||
      Math.abs(catPts[1]! - expectedVisual) > 0.05 ||
      Math.abs(catPts[2]! - expectedMusic) > 0.05 ||
      Math.abs(totPts - expectedTotal) > 0.05) {
      throw new Error("DERIVATION CHECK FAILED: Architecture consistency mismatch!");
    }
  });
  console.log("DERIVATION CHECK SUCCESS\n");

  // Phase 16: Scale Sanity Test
  console.log("--- SCALE SANITY TEST ---");
  const sampleRow = trainRows[0];
  if (sampleRow) {
    const sum8 = sampleRow.recap.reduce((a, b) => a + b, 0);
    console.log(`Sample Row Total: ${sampleRow.total.toFixed(2)} (expecting DCI scale, not sum-of-8)`);
    console.log(`Sum-of-8: ${sum8.toFixed(2)}`);
    if (Math.abs(sampleRow.total - sum8) < 0.1 && sampleRow.recap.some(r => r > 0)) {
      console.warn("WARNING: total score is still sum-of-8! Fix logic in buildDataRows.");
    } else {
      console.log("SCALE SANITY SUCCESS: target total is on DCI scale.\n");
    }
  }

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

  const scheduler = new V8LossScheduler();
  const provider = new SequenceDataProviderV7(trainSubset, 0, args.batchSize);

  // PERFORMANCE: Cache validation samples outside the epoch loop (deterministic: seqLen=15, identityDropout=0.0)
  const cachedValSamples = buildSamples(valSubset, stats, 15, 0.0, args.seed + 999);
  console.log(`Cached ${cachedValSamples.length} validation samples (seqLen=15, identityDropout=0.0)`);

  // Phase 0 Guardrail: Check UNK_CORPS_ID usage
  const guardrailCheck = (samples: Sample[], rate: number) => {
    const droppedCount = samples.filter(s => s.xs[4] === UNK_CORPS_ID).length;
    const total = samples.length;
    const actualRate = droppedCount / total;
    // Only warn if we expect dropped but get none, or vice versa (loosely)
    if (rate > 0.01 && actualRate === 0) console.warn("Guardrail: identityDropoutRate > 0 but no corps dropped!");
    return actualRate;
  };

  // PERFORMANCE: Create stat tensors once and reuse across epochs
  const valDeltaMeanTensor = tf.tensor1d(stats.deltaMean, "float32");
  const valDeltaStdTensor = tf.tensor1d(stats.deltaStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const valRecapStdTensor = tf.tensor1d(stats.recapStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const valCategoryStdTensor = tf.tensor1d(stats.categoryStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const valTotalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

  for (let epoch = args.startEpoch; epoch < args.startEpoch + args.epochs; epoch++) {
    provider.setEpoch(epoch);
    const weights = scheduler.getWeights(epoch);
    // Phase 9: Increase consistency weight late-game
    if (epoch >= 400) {
      weights.consistencyWeight = FINAL_CONSISTENCY_WEIGHT;
    }
    const seqLen = provider.getSequenceLength();

    const epochSamples = buildSamples(provider.sampleRows(args.samplesPerEpoch, args.seed + epoch), stats, seqLen, weights.identityDropoutRate, args.seed + epoch);
    const dropRate = guardrailCheck(epochSamples, weights.identityDropoutRate);

    console.log(`\nEpoch ${epoch}: Weights ${JSON.stringify(weights)}, SeqLen ${seqLen}, ID_Drop ${dropRate.toFixed(3)}`);

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
            xs.corps_id,
            xs.baseline_recap,
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
      valDeltaMae: 0,
      valRecapMae: 0,
      valCategoryMae: 0, // Phase 6
      valTotalMae: 0,
      coverage: 0,
      widthNorm: 0,
      widthFloorPct: 0
    };

    const captionDeltaMaeSum = new Array(CAPTION_COUNT).fill(0);
    const captionRecapMaeSum = new Array(CAPTION_COUNT).fill(0);
    const captionCoverageWithin = new Array(CAPTION_COUNT).fill(0);
    const captionWidthSum = new Array(CAPTION_COUNT).fill(0);
    const captionCount = new Array(CAPTION_COUNT).fill(0);

    if (cachedValSamples.length) {
      // PERFORMANCE: Use batch generator with cached val samples
      let valLossSum = 0;
      let valMaeSum = 0;
      let valMaePointsSum = 0;
      let valDeltaMaeSum = 0;
      let valRecapMaeSum = 0;
      let valCategoryMaeSum = 0; // Phase 6
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
          xs.corps_id,
          xs.baseline_recap,
        ]) as tf.Tensor;
        const lossTensor = lossFn(ys, preds, weights) as tf.Tensor;
        const maeTensor = computeMaeFromPreds(preds, ys);

        const predQ10 = preds.slice([0, 0], [-1, CAPTION_COUNT]);
        const predQ50 = preds.slice([0, CAPTION_COUNT], [-1, CAPTION_COUNT]);
        const predQ90 = preds.slice([0, CAPTION_COUNT * 2], [-1, CAPTION_COUNT]);
        const deltaTrueTensor = ys.slice([0, 0], [-1, CAPTION_COUNT]);
        const predDenorm = tf.add(tf.mul(predQ50, valDeltaStdTensor), valDeltaMeanTensor);
        const trueDenorm = tf.add(tf.mul(deltaTrueTensor, valDeltaStdTensor), valDeltaMeanTensor);
        const maePointsTensor = tf.mean(tf.abs(tf.sub(predDenorm, trueDenorm)));

        const predRecap = preds.slice([0, DELTA_DIM], [-1, RECAP_DIM]);
        const trueRecap = ys.slice([0, CAPTION_COUNT], [-1, RECAP_DIM]);
        const recapMaePointsTensor = tf.mean(tf.mul(valRecapStdTensor, tf.abs(tf.sub(predRecap, trueRecap))));

        const predCategory = preds.slice([0, DELTA_DIM + RECAP_DIM], [-1, CATEGORY_DIM]);
        const trueCategory = ys.slice([0, CAPTION_COUNT + RECAP_DIM], [-1, CATEGORY_DIM]);
        const categoryMaePointsTensor = tf.mean(tf.mul(valCategoryStdTensor, tf.abs(tf.sub(predCategory, trueCategory))));

        const predTotal = preds.slice([0, DELTA_DIM + RECAP_DIM + CATEGORY_DIM], [-1, TOTAL_DIM]);
        const trueTotal = ys.slice([0, CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM], [-1, TOTAL_DIM]);
        const totalMaePointsTensor = tf.mean(tf.mul(valTotalStdTensor, tf.abs(tf.sub(predTotal, trueTotal))));

        const predQ10Denorm = tf.add(tf.mul(predQ10, valDeltaStdTensor), valDeltaMeanTensor);
        const predQ90Denorm = tf.add(tf.mul(predQ90, valDeltaStdTensor), valDeltaMeanTensor);
        const lower = tf.minimum(predQ10Denorm, predQ90Denorm);
        const upper = tf.maximum(predQ10Denorm, predQ90Denorm);
        const within = tf.logicalAnd(trueDenorm.greaterEqual(lower), trueDenorm.lessEqual(upper));
        const withinFloat = tf.cast(within, "float32");

        const widthNormTensor = tf.mean(tf.sub(predQ90Denorm, predQ10Denorm));
        const widthFloorMask = tf.less(tf.sub(predQ90Denorm, predQ10Denorm), tf.scalar(args.widthFloorPts));

        // Metric Stacking: ONE dataSync per batch
        const metricsStack = tf.stack([
          lossTensor.reshape([1]),
          maeTensor.reshape([1]),
          maePointsTensor.reshape([1]),
          recapMaePointsTensor.reshape([1]),
          categoryMaePointsTensor.reshape([1]),
          totalMaePointsTensor.reshape([1]),
          withinFloat.sum().reshape([1]),
          tf.mean(tf.sub(upper, lower)).reshape([1]),
          widthNormTensor.reshape([1]),
          tf.sum(tf.cast(widthFloorMask, "float32")).reshape([1])
        ]);
        const metrics = metricsStack.dataSync();
        metricsStack.dispose();

        const lossValue = metrics[0]!;
        const maeValue = metrics[1]!;
        const maePointsValue = metrics[2]!;
        const recapMae = metrics[3]!;
        const categoryMae = metrics[4]!;
        const totalMae = metrics[5]!;
        const withinCount = metrics[6]!;
        const intervalWidth = metrics[7]!;
        const widthNormValue = metrics[8]!;
        const widthFloorCountBatch = metrics[9]!;

        // Gated Per-caption stats
        if (epoch % 50 === 0 || epoch === 0) {
          const capMaeTensor = tf.abs(tf.sub(predDenorm, trueDenorm));
          const capMaeValues = capMaeTensor.mean(0).dataSync();
          const capWithinValues = withinFloat.sum(0).dataSync();
          const capWidthTensor = tf.sub(upper, lower);
          const capWidthValues = capWidthTensor.mean(0).dataSync();
          const capRecapTensor = tf.mul(valRecapStdTensor, tf.abs(tf.sub(predRecap, trueRecap)));
          const capRecapValues = capRecapTensor.mean(0).dataSync();

          for (let i = 0; i < CAPTION_COUNT; i++) {
            captionDeltaMaeSum[i] += (capMaeValues[i] ?? 0) * batchSize;
            captionRecapMaeSum[i] += (capRecapValues[i] ?? 0) * batchSize;
            captionCoverageWithin[i] += capWithinValues[i] ?? 0;
            captionWidthSum[i] += (capWidthValues[i] ?? 0) * batchSize;
          }
          capMaeTensor.dispose();
          capWidthTensor.dispose();
          capRecapTensor.dispose();
        }

        for (let i = 0; i < CAPTION_COUNT; i++) {
          captionCount[i] += batchSize;
        }

        valLossSum += lossValue * batchSize;
        valMaeSum += maeValue * batchSize;
        valMaePointsSum += maePointsValue * batchSize;
        valDeltaMaeSum += maePointsValue * batchSize; // Phase 11: delta is point-space error
        valRecapMaeSum += recapMae * batchSize;       // recap is head-space absolute error
        valCategoryMaeSum += categoryMae * batchSize;
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
        deltaTrueTensor.dispose();
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
      const valDeltaMae = valCountTotal ? valDeltaMaeSum / valCountTotal : 0;
      const valRecapMae = valCountTotal ? valRecapMaeSum / valCountTotal : 0;
      const valCategoryMae = valCountTotal ? valCategoryMaeSum / valCountTotal : 0; // Phase 6
      const valTotalMae = valCountTotal ? valTotalMaeSum / valCountTotal : 0;
      const coverage = coverageCount ? coverageWithin / coverageCount : 0;
      const widthNorm = valCountTotal ? widthNormSum / valCountTotal : 0;
      const widthFloorPct = (valCountTotal * CAPTION_COUNT) ? widthFloorCount / (valCountTotal * CAPTION_COUNT) : 0;

      // STABILITY: Ramped coverage penalty + squared shortfall + width cap
      const covW = coverageWeight(epoch, 148, 20, SCORE_COVERAGE_WEIGHT);
      const underCoverage = Math.max(0, SCORE_COVERAGE_TARGET - coverage);
      const covPenalty = underCoverage * underCoverage; // Quadratic cost

      const widthExcess = Math.max(0, widthNorm - WIDTH_TARGET_PTS);
      const widthPenaltyScore = widthExcess * 0.5;

      // Phase-aware monitoring
      let valScore: number;
      if (weights.deltaWeight === 0) {
        // Phase 1: Only monitor total/delta MAE
        valScore = valDeltaMae + valTotalMae;
      } else {
        // Phase 2+: Full score with ramped coverage/width penalties
        valScore = valMaePoints +
          weights.recapWeight * valDeltaMae +
          weights.totalWeight * valTotalMae +
          weights.categoryWeight * valCategoryMae + // Phase 6/7: include category
          covW * covPenalty +
          widthPenaltyScore;
      }

      monitoringStats = {
        valScore,
        valMaePoints,
        valDeltaMae,
        valRecapMae,
        valCategoryMae, // Phase 6
        valTotalMae,
        coverage,
        widthNorm,
        widthFloorPct
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
      `delta_mae_pts=${monitoringStats.valDeltaMae.toFixed(4)} ` +
      `recap_mae_pts=${monitoringStats.valRecapMae.toFixed(4)} ` +
      `cat_mae_pts=${monitoringStats.valCategoryMae.toFixed(4)} ` +
      `total_mae_pts=${monitoringStats.valTotalMae.toFixed(4)} ` +
      `mon_cov=${monitoringStats.coverage.toFixed(3)} ` +
      `mon_score=${monitoringStats.valScore.toFixed(4)} ` +
      `time=${elapsed}s`
    );

    // Periodic Per-Caption Logging
    if (weights.deltaWeight > 0 && ((epoch + 1) % 50 === 0 || epoch === 0)) {
      console.log(`\n--- CAPTION STATS (Epoch ${epoch}) ---`);
      for (let i = 0; i < CAPTION_COUNT; i++) {
        const capDeltaMae = captionCount[i] ? captionDeltaMaeSum[i]! / captionCount[i]! : 0;
        const capRecapMae = captionCount[i] ? captionRecapMaeSum[i]! / captionCount[i]! : 0;
        const capCov = captionCount[i] ? captionCoverageWithin[i]! / captionCount[i]! : 0;
        const capWidth = captionCount[i] ? captionWidthSum[i] / captionCount[i]! : 0;
        console.log(`${CAPTIONS[i]}: delta_pts=${capDeltaMae.toFixed(4)}, recap_pts=${capRecapMae.toFixed(4)}, cov=${capCov.toFixed(3)}, width=${capWidth.toFixed(4)}`);
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
  valDeltaMeanTensor.dispose();
  valDeltaStdTensor.dispose();
  valRecapStdTensor.dispose();
  valCategoryStdTensor.dispose(); // Phase 6
  valTotalStdTensor.dispose();

  console.log(`Saving final production model to ${runDir}...`);
  await saveModel(model, runDir);
  fs.writeFileSync(path.join(runDir, "training-args.json"), JSON.stringify(args, null, 2));

  // FINAL TEST EVALUATION PASS
  if (testRows.length > 0) {
    console.log("\n--- FINAL TEST EVALUATION ---");
    const testSamples = buildSamples(testRows, stats, SEQ_LEN, 0.0, 42); // 0.0 dropout for test
    let testMaePointsSum = 0;
    let testDeltaMaeSum = 0;
    let testCategoryMaeSum = 0; // Phase 6
    let testTotalMaeSum = 0;
    let testCoverageWithin = 0;
    let testWidthSum = 0;
    let testWidthFloorCount = 0;
    let testCount = 0;

    // Create stat tensors for test eval
    const testDeltaMeanTensor = tf.tensor1d(stats.deltaMean, "float32");
    const testDeltaStdTensor = tf.tensor1d(stats.deltaStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
    const testRecapStdTensor = tf.tensor1d(stats.recapStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
    const testCategoryStdTensor = tf.tensor1d(stats.categoryStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
    const testTotalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

    // PERFORMANCE: Use batch generator for test eval
    for (const batch of batchGenerator(testSamples, args.batchSize, false, 42)) {
      const xs = batch.xs;
      const ys = batch.ys;
      const batchSize = ys.shape[0] ?? 0;
      const preds = model.predict([xs.sequence, xs.static, xs.mask, xs.judge_ids, xs.corps_id, xs.baseline_recap]) as tf.Tensor;

      const predQ10 = preds.slice([0, 0], [-1, CAPTION_COUNT]);
      const predQ50 = preds.slice([0, CAPTION_COUNT], [-1, CAPTION_COUNT]);
      const predQ90 = preds.slice([0, CAPTION_COUNT * 2], [-1, CAPTION_COUNT]);
      const deltaTrueTensor = ys.slice([0, 0], [-1, CAPTION_COUNT]);
      const predDenorm = tf.add(tf.mul(predQ50, testDeltaStdTensor), testDeltaMeanTensor);
      const trueDenorm = tf.add(tf.mul(deltaTrueTensor, testDeltaStdTensor), testDeltaMeanTensor);

      const predRecap = preds.slice([0, DELTA_DIM], [-1, RECAP_DIM]);
      const trueRecap = ys.slice([0, CAPTION_COUNT], [-1, RECAP_DIM]);
      const predCategory = preds.slice([0, DELTA_DIM + RECAP_DIM], [-1, CATEGORY_DIM]);
      const trueCategory = ys.slice([0, CAPTION_COUNT + RECAP_DIM], [-1, CATEGORY_DIM]);
      const predTotal = preds.slice([0, DELTA_DIM + RECAP_DIM + CATEGORY_DIM], [-1, TOTAL_DIM]);
      const trueTotal = ys.slice([0, CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM], [-1, TOTAL_DIM]);

      const predQ10Denorm = tf.add(tf.mul(predQ10, testDeltaStdTensor), testDeltaMeanTensor);
      const predQ90Denorm = tf.add(tf.mul(predQ90, testDeltaStdTensor), testDeltaMeanTensor);
      const lower = tf.minimum(predQ10Denorm, predQ90Denorm);
      const upper = tf.maximum(predQ10Denorm, predQ90Denorm);
      const within = tf.logicalAnd(trueDenorm.greaterEqual(lower), trueDenorm.lessEqual(upper));
      const widthFloorMask = tf.less(tf.sub(predQ90Denorm, predQ10Denorm), tf.scalar(args.widthFloorPts));

      const metricsStack = tf.stack([
        tf.mean(tf.abs(tf.sub(predDenorm, trueDenorm))).reshape([1]),
        tf.mean(tf.mul(testRecapStdTensor, tf.abs(tf.sub(predRecap, trueRecap)))).reshape([1]),
        tf.mean(tf.mul(testCategoryStdTensor, tf.abs(tf.sub(predCategory, trueCategory)))).reshape([1]),
        tf.mean(tf.mul(testTotalStdTensor, tf.abs(tf.sub(predTotal, trueTotal)))).reshape([1]),
        tf.cast(within, "float32").sum().reshape([1]),
        tf.mean(tf.sub(upper, lower)).reshape([1]),
        tf.sum(tf.cast(widthFloorMask, "float32")).reshape([1])
      ]);
      const metrics = metricsStack.dataSync();
      metricsStack.dispose();

      const maePoints = metrics[0]!;
      const recapMae = metrics[1]!;
      const categoryMae = metrics[2]!;
      const totalMae = metrics[3]!;
      const withinCount = metrics[4]!;
      const intervalWidth = metrics[5]!;
      const widthFloorCountBatch = metrics[6]!;

      testMaePointsSum += maePoints * batchSize;
      testDeltaMaeSum += recapMae * batchSize;
      testCategoryMaeSum += categoryMae * batchSize;
      testTotalMaeSum += totalMae * batchSize;
      testCoverageWithin += withinCount;
      testWidthSum += intervalWidth * (batchSize * CAPTION_COUNT);
      testWidthFloorCount += widthFloorCountBatch;
      testCount += batchSize;

      preds.dispose();
      predQ10.dispose();
      predQ50.dispose();
      predQ90.dispose();
      deltaTrueTensor.dispose();
      predRecap.dispose();
      trueRecap.dispose();
      predCategory.dispose();
      trueCategory.dispose();
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
    testDeltaMeanTensor.dispose();
    testDeltaStdTensor.dispose();
    testRecapStdTensor.dispose();
    testCategoryStdTensor.dispose();
    testTotalStdTensor.dispose();

    const finalTestMae = testCount ? testMaePointsSum / testCount : 0;
    const finalTestDelta = testCount ? testDeltaMaeSum / testCount : 0;
    const finalTestCategory = testCount ? testCategoryMaeSum / testCount : 0;
    const finalTestTotal = testCount ? testTotalMaeSum / testCount : 0;
    const finalTestCov = (testCount * CAPTION_COUNT) ? testCoverageWithin / (testCount * CAPTION_COUNT) : 0;
    const finalTestWidth = (testCount * CAPTION_COUNT) ? testWidthSum / (testCount * CAPTION_COUNT) : 0;
    const finalTestWidthFloorPct = (testCount * CAPTION_COUNT) ? testWidthFloorCount / (testCount * CAPTION_COUNT) : 0;

    console.log(`TEST RESULTS: delta_mae_pts=${finalTestMae.toFixed(4)}, delta_recap_mae_pts=${finalTestDelta.toFixed(4)}, cat_mae_pts=${finalTestCategory.toFixed(4)}, total_mae_pts=${finalTestTotal.toFixed(4)}, coverage=${finalTestCov.toFixed(3)}, width=${finalTestWidth.toFixed(4)}, width_floor_pct=${finalTestWidthFloorPct.toFixed(3)}`);
    fs.writeFileSync(path.join(runDir, "test-results.json"), JSON.stringify({ finalTestMae, finalTestDelta, finalTestCategory, finalTestTotal, finalTestCov, finalTestWidth, finalTestWidthFloorPct }, null, 2));
  }

  console.log("Production training complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
