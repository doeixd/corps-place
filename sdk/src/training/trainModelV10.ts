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
const MODEL_DIR = "./models/v10_curriculum";
const NORM_PATH = "./results/v10-curriculum-target-norm.json";
const JUDGE_INDEX_PATH = "./src/training/judgeIndexMap.json";
const CORPS_INDEX_PATH = "./src/training/corpsIndexMap.json";
const SHOW_INDEX_PATH = "./src/training/showIndexMap.json";
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const CAPTION_COUNT = CAPTIONS.length;
const SEQ_LEN = 15;
const CONTEXT_DIM = 0;
const RAW_STATIC_DIM = 136; // 132 + 4 new temporal features
const TREND_DIM = CAPTION_COUNT;
const TOTAL_STATIC_DIM = RAW_STATIC_DIM + TREND_DIM + CONTEXT_DIM; // 144


// Note: STATIC_DIM in buildDataRows refers to the DB column, while model expects TOTAL_STATIC_DIM 
const BATCH_SIZE = 32;
const EPOCHS = 500;
const EARLY_STOPPING_PATIENCE = 50;
const PADDING_INDEX = 3;
const CONSISTENCY_WEIGHT = 0.2;
const FINAL_CONSISTENCY_WEIGHT = 0.5; // Phase 9
const WIDTH_FLOOR_PTS = 0.5;
const WIDTH_FLOOR_WEIGHT = 1.5;
const SCORE_COVERAGE_TARGET = 0.8;
const SCORE_COVERAGE_WEIGHT = 0.1;
const EMA_ALPHA = 0.3;
const RECAP_OFFSET_IN_FEATS = 19; // Shifted by 1 due to gap_to_winner_prev
const FEAT_DIM = 102; // 99 + 3 new features in V10
const CAPTION_STRIDE = 4;
const CAPTION_SCORE_SCALE = 20;
const SAMPLES_PER_EPOCH = 4096;

const WIDTH_TARGET_PTS = 2.5;
const UNK_CORPS_ID = 0;
const DELTA_DIM = CAPTION_COUNT * 3; // Quantiles for delta
const BASELINE_DROPOUT_RATE = 0.1;
const BASELINE_NOISE_STD_PTS = 0.25;

// Phase 10: Index Maps for Embeddings
const judgeIndexMap = JSON.parse(fs.readFileSync(JUDGE_INDEX_PATH, "utf-8"));
const corpsIndexMap = JSON.parse(fs.readFileSync(CORPS_INDEX_PATH, "utf-8"));
const showIndexMap = JSON.parse(fs.readFileSync(SHOW_INDEX_PATH, "utf-8"));
const JUDGE_COUNT = Object.keys(judgeIndexMap).length + 1;
const CORPS_COUNT = Object.keys(corpsIndexMap).length + 1;
const SHOW_COUNT = Object.keys(showIndexMap).length + 1;


const denormalize = (value: number, mean: number, std: number) => value * (std > 1e-6 ? std : 1) + mean;

function seededRandom(seed: number) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function gaussianRandom(rng: () => number) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
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
const TARGET_DIM = 4; // [yScoreResid, yContentResid, yAchievementResid, yTotal]


export type BatchedInputs = {
  sequence: tf.Tensor;
  static: tf.Tensor;
  mask: tf.Tensor;
  judge_id: tf.Tensor;
  corps_id: tf.Tensor;
  baseline_score: tf.Tensor;
  caption_id: tf.Tensor;
  history_len: tf.Tensor;
  judge_bias_scale: tf.Tensor;
  corps_scale: tf.Tensor;
  show_id: tf.Tensor;
  agnostic_show_id: tf.Tensor;
};

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

      // Fallback: If a row has ALL zeros in mask, we want to avoid softmaxing [-inf, -inf...].
      // Strategy: If sum(mask) == 0, set mask[0] = true.
      // This forces attention to the first step (which is likely padding/zero) but avoids NaN.
      // We can use tf.any(boolMask, axis=1) to find valid rows.
      const hasAny = tf.any(boolMask, 1, true); // [B, 1]
      // Create a safety mask: [B, SEQ_LEN] where index 0 is True if hasAny is False
      // However, modifying the tensor conditionally is tricky in TFJS without slight overhead.
      // Simpler: Just add a tiny epsilon to the first element's score or mask?
      // Better: Use tf.where to replace the mask for empty rows.

      // Fix: OneHot takes indices.
      const defaultMask = tf.oneHot(tf.cast(tf.zeros([hasAny.shape[0]], "int32"), "int32"), SEQ_LEN, 1.0, 0.0);

      // Fix for TFJS "Select" kernel crash (broadcasting issue): Use arithmetic instead of tf.where
      // If row has ANY (hasAny=true), term is 0. If empty (hasAny=false), term is defaultMask.
      const injection = tf.mul(defaultMask, tf.cast(tf.logicalNot(hasAny), "float32"));
      const safeMask = tf.add(mask, injection);
      const safeBoolMask = tf.cast(safeMask, "bool");

      const negInf = tf.fill(scores.shape, -1e9);
      const masked = tf.where(safeBoolMask, scores, negInf);

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

// Issue 5 Fix: Replace tf.layers.dot with explicit multiply+reduceSum for rank-3 safety
class AttentionPoolingLayer extends tf.layers.Layer {
  static className = "AttentionPoolingLayer";
  constructor(config?: any) {
    super(config || {});
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape | tf.Shape[] {
    // Input: [[B, T, 1], [B, T, H]] -> Output: [B, H]
    const shapes = inputShape as [number[], number[]];
    return [shapes[1][0], shapes[1][2]]; // [B, H]
  }

  call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor | tf.Tensor[] {
    return tf.tidy(() => {
      const [weights, input] = inputs as [tf.Tensor, tf.Tensor];
      // weights: [B, T, 1], input: [B, T, H]
      const weighted = tf.mul(weights, input); // [B, T, H]
      return tf.sum(weighted, 1); // [B, H]
    });
  }

  getConfig() { return { ...super.getConfig() }; }
}
tf.serialization.registerClass(AttentionPoolingLayer);

class LastStepLayer extends tf.layers.Layer {
  static className = "LastStepLayer";
  constructor(config?: any) {
    super(config || {});
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape | tf.Shape[] {
    const shape = Array.isArray(inputShape) && Array.isArray(inputShape[0])
      ? (inputShape[0] as number[])
      : (inputShape as number[]);
    return [shape[0] ?? null, shape[2] ?? FEAT_DIM];
  }

  call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor | tf.Tensor[] {
    return tf.tidy(() => {
      const seq = Array.isArray(inputs) ? inputs[0] : inputs;
      return (seq as tf.Tensor).slice([0, SEQ_LEN - 1, 0], [-1, 1, -1]).squeeze([1]);
    });
  }

  getConfig() { return { ...super.getConfig() }; }
}

tf.serialization.registerClass(LastStepLayer);

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
    widthFloorStart: Number(get("--width-floor-start", "0.1")),
    widthFloorEnd: Number(get("--width-floor-end", `${WIDTH_FLOOR_WEIGHT}`)),
    rankingWeight: Number(get("--ranking-weight", "0.1")),
    valSplit: Number(get("--val-split", "0.05")), // Increased to 5% for more stable monitoring
    samplesPerEpoch: Number(get("--samples-per-epoch", `${SAMPLES_PER_EPOCH}`)),
    loadModel: get("--load-model"),
    baselineDropout: Number(get("--baseline-dropout", `${BASELINE_DROPOUT_RATE}`)),
    baselineNoiseStd: Number(get("--baseline-noise-std", `${BASELINE_NOISE_STD_PTS}`)),
    // Logging

    logCsv: get("--log-csv", "./results/lstm-v6-production-training-log.csv"),
    trialId: get("--trial-id"),
    noJudgeBias: get("--no-judge-bias", "false") === "true",
    noCorpsResidual: get("--no-corps-residual", "false") === "true",
    outputReport: get("--output-report", "eval_report.json") || "eval_report.json",
    baselineScope: get("--baseline-scope", "train") || "train",
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

const coverageWeight = (epoch: number, start: number, ramp: number, maxW: number) => {
  if (epoch < start) return 0;
  const t = Math.min(1, (epoch - start) / Math.max(1, ramp));
  // smoothstep ramp
  return maxW * t * t * (3 - 2 * t);
};

export interface DataRow {
  seq: Float32Array; // Flattened [15 * 102]
  seqMask: boolean[];
  stat: Float32Array;
  judgeIndex: number;
  captionId: string;
  corpsId: number;
  yJudgeScore: number;
  yJudgeContent: number | null;
  yJudgeAchievement: number | null;
  yTotal: number;
  agnosticShowId: number;
  division: string;
  split: string;
  date: string;
  showKey: string;
  globalBaseline: Float32Array;
}


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

class V8LossScheduler2 {
  getWeights(epoch: number) {
    // Phase A: Baseline Correction (Epochs 0-40)
    // Focus: Learning to trust the baseline and making small corrections.
    // High recap weight forces the "Base + Delta" structure to stabilize.
    if (epoch < 40) {
      return {
        totalWeight: 0.05,
        recapWeight: 1.0,
        deltaWeight: 0.2,
        categoryWeight: 0.05,
        quantileWeight: 0.02,
        consistencyWeight: 0.0, // Milestone 4: Removed consistency loss
        identityDropoutRate: 0.95
      };
    }

    // Phase B: Structure + Median Deltas (Epochs 40-120)
    // Transition: Ramp down recap, ramp up delta. Introduce quantiles gently.
    if (epoch < 120) {
      const t = (epoch - 40) / 80; // 0 to 1
      return {
        totalWeight: 0.01,
        recapWeight: 1.0 - 0.7 * t, // 1.0 -> 0.3
        deltaWeight: 0.2 + 0.8 * t, // 0.2 -> 1.0
        categoryWeight: 0.05,
        quantileWeight: 0.02 + 0.08 * t,    // 0.02 -> 0.10
        consistencyWeight: 0.0,
        identityDropoutRate: 0.95
      };
    }


    // Phase C: Uncertainty + Coverage (Epochs 120+)
    // Focus: Full quantile distribution and fine-tuning.
    // Identity Dropout ramps down later to allow learning specific corps styles.
    const t = Math.min(1.0, (epoch - 120) / 280); // 120 -> 400
    const idDrop = (epoch < 250) ? 1.0 : Math.max(0.1, 1.0 - 0.9 * ((epoch - 250) / 150)); // 250->400 ramp down

    return {
      totalWeight: 0.01,
      recapWeight: 0.3 * (1.0 - t), // 0.3 -> 0.0 (Removal of redundant supervision)
      deltaWeight: 1.0,
      categoryWeight: 0.05,
      quantileWeight: 0.2 + 0.15 * t, // 0.2 -> 0.35
      consistencyWeight: 0.0,
      identityDropoutRate: idDrop
    };
  }

  getScales(epoch: number) {
    const judgeBias = Math.min(1.0, epoch / 120);
    const corps = epoch < 120 ? 0 : Math.min(1.0, (epoch - 120) / 100);
    return { judgeBias, corps };
  }

  /**
   * Width Floor Weight Schedule:
   * - Phase A (0-40): Low weight (startWeight) - allow exploration
   * - Phase B (40-120): Smoothstep ramp from start to end
   * - Phase C (120+): Full weight (endWeight) - aggressively tighten
   */
  getWidthFloorWeight(epoch: number, startWeight: number, endWeight: number): number {
    // Phase A: Exploration - use starting weight
    if (epoch < 40) {
      return startWeight;
    }

    // Phase B: Smoothstep ramp from start to end
    if (epoch < 120) {
      const t = (epoch - 40) / 80; // 0 to 1
      const smooth = t * t * (3 - 2 * t); // smoothstep
      return startWeight + (endWeight - startWeight) * smooth;
    }

    // Phase C: Full tightening - use ending weight
    return endWeight;
  }
}

class SequenceDataProviderV9 {
  private worldRows: DataRow[];
  private openRows: DataRow[];
  private worldShows: DataRow[][];
  private openShows: DataRow[][];
  private allShows: DataRow[][];

  constructor(
    private rows: DataRow[],
    private epoch: number,
    private batchSize: number = BATCH_SIZE
  ) {
    this.worldRows = this.rows.filter(r => r.division === "World Class");
    this.openRows = this.rows.filter(r => r.division === "Open Class");
    this.worldShows = this.groupByShow(this.worldRows);
    this.openShows = this.groupByShow(this.openRows);
    this.allShows = this.groupByShow(this.rows);
  }

  setEpoch(epoch: number) {
    this.epoch = epoch;
  }

  getSequenceLength(): number {
    if (this.epoch < 40) return 5;
    return 15;
  }

  sampleRows(count: number, seed: number): DataRow[] {
    if (this.openShows.length === 0) {
      return this.flattenShows(this.sampleShows(this.allShows, count, seed));
    }

    const openCount = Math.floor(count * 0.25);
    const worldCount = count - openCount;

    const worldSample = this.sampleShows(this.worldShows, worldCount, seed);
    const openSample = this.sampleShows(this.openShows, openCount, seed + 1);
    const merged = this.shuffle([...worldSample, ...openSample], seed + 2);

    return this.flattenShows(merged);
  }

  private groupByShow(rows: DataRow[]): DataRow[][] {
    const showMap = new Map<string, DataRow[]>();
    for (const row of rows) {
      const bucket = showMap.get(row.showKey) ?? [];
      bucket.push(row);
      showMap.set(row.showKey, bucket);
    }
    return Array.from(showMap.values());
  }

  private sampleShows(shows: DataRow[][], targetCount: number, seed: number): DataRow[][] {
    if (shows.length === 0) return [];
    const rng = this.seededRandom(seed);
    const shuffled = this.shuffle([...shows], seed);
    const picked: DataRow[][] = [];
    let count = 0;
    for (const show of shuffled) {
      picked.push(show);
      count += show.length;
      if (count >= targetCount) break;
    }
    return picked;
  }

  private flattenShows(shows: DataRow[][]): DataRow[] {
    return shows.flat();
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


export function buildDataRows(
  scoreRows: Array<{
    season: string;
    competition_slug: string;
    competition_date: string;
    division_name: string;
    corps_key: string;
    corps_id: number;
    caption_id: string;
    judge_index: number;
    y_judge_score: number;
    y_judge_content: number | null;
    y_judge_achievement: number | null;
    y_total: number;
    agnostic_show_id: number;
    split: string;
  }>,
  sequenceMap: Map<string, { seq: Float32Array; stat: Float32Array; seqMask: boolean[] }>
): DataRow[] {
  const dataRows: DataRow[] = [];
  let missingCount = 0;

  for (const row of scoreRows) {
    const key = `${row.season}_${row.competition_slug}_${row.competition_date}_${row.corps_key}`;
    const seqData = sequenceMap.get(key);

    if (!seqData) {
      missingCount++;
      continue;
    }

    dataRows.push({
      seq: seqData.seq,
      seqMask: seqData.seqMask,
      stat: seqData.stat,
      judgeIndex: row.judge_index,
      captionId: row.caption_id,
      corpsId: row.corps_id,
      yJudgeScore: row.y_judge_score,
      yJudgeContent: row.y_judge_content,
      yJudgeAchievement: row.y_judge_achievement,
      yTotal: row.y_total,
      agnosticShowId: row.agnostic_show_id,
      division: row.division_name,
      split: row.split,
      date: row.competition_date,
      showKey: row.competition_slug,
      globalBaseline: new Float32Array(CAPTION_COUNT),
    });
  }

  if (missingCount > 0) {
    console.warn(`Warning: Dropped ${missingCount} rows due to missing sequence data.`);
  }

  return dataRows;
}

function applyBaselines(rows: DataRow[], historyRows: DataRow[]) {
  const corpsMap: Record<number, DataRow[]> = {};
  for (const row of rows) {
    if (!corpsMap[row.corpsId]) corpsMap[row.corpsId] = [];
    corpsMap[row.corpsId]!.push(row);
  }

  const alpha = EMA_ALPHA;
  for (const corpsId in corpsMap) {
    const corpsRows = corpsMap[corpsId]!;
    // Group by showKey to get per-show averages
    const shows: Record<string, DataRow[]> = {};
    for (const r of corpsRows) {
      if (!shows[r.showKey]) shows[r.showKey] = [];
      shows[r.showKey]!.push(r);
    }

    const sortedShowKeys = Object.keys(shows).sort((a, b) => {
      const dateA = shows[a]![0]!.date;
      const dateB = shows[b]![0]!.date;
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return a.localeCompare(b);
    });

    const ema = new Float32Array(CAPTION_COUNT).fill(15);
    const historySet = new Set(historyRows);

    for (const key of sortedShowKeys) {
      const showRows = shows[key]!;
      for (const r of showRows) {
        r.globalBaseline = new Float32Array(ema);
      }

      // Update EMA using averages from this show
      const showCaps: Record<string, number[]> = {};
      let isHistory = false;
      for (const r of showRows) {
        if (historySet.has(r)) isHistory = true;
        if (!showCaps[r.captionId]) showCaps[r.captionId] = [];
        showCaps[r.captionId]!.push(r.yJudgeScore);
      }

      if (isHistory) {
        for (let i = 0; i < CAPTION_COUNT; i++) {
          const cap = CAPTIONS[i]!;
          const scores = showCaps[cap];
          if (scores && scores.length > 0) {
            const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
            if (avg > 5) {
              ema[i] = alpha * avg + (1 - alpha) * ema[i]!;
            }
          }
        }
      }
    }
  }
}


function computeTargetStats(rows: DataRow[]): TargetStats {
  const deltaSeries = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const scoreSeries = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const totalSeries: number[] = [];

  for (const row of rows) {
    const capIdx = CAPTIONS.indexOf(row.captionId as any);
    if (capIdx === -1) continue;

    const baseline = row.globalBaseline[capIdx] ?? 15;
    deltaSeries[capIdx]!.push(row.yJudgeScore - baseline);
    scoreSeries[capIdx]!.push(row.yJudgeScore);
    totalSeries.push(row.yTotal);
  }

  return {
    deltaMean: deltaSeries.map(mean),
    deltaStd: deltaSeries.map(s => Math.max(0.1, std(s))),
    recapMean: scoreSeries.map(mean),
    recapStd: scoreSeries.map(s => Math.max(0.1, std(s))),
    categoryMean: [0, 0, 0], // Placeholders for now
    categoryStd: [1, 1, 1],
    totalMean: mean(totalSeries),
    totalStd: Math.max(1, std(totalSeries)),
    deltaWeights: deltaSeries.map(s => {
      const dev = std(s);
      // V10 Fix: Restore inverse variance weighting to balance gradients across captions
      return dev > 0.1 ? 1.0 / dev : 10.0;
    }),
    recapWeights: new Array(CAPTION_COUNT).fill(1),
  };
}

function normalizeValue(value: number, meanValue: number, stdValue: number) {
  if (!Number.isFinite(stdValue) || stdValue < 1e-6) return 0;
  return (value - meanValue) / stdValue;
}

export type Sample = {
  xs: [
    Float32Array, // 0: sequence (Flattened [15 * 102])
    Float32Array, // 1: static
    Float32Array, // 2: mask
    number,       // 3: judge_index
    number,       // 4: corps_id
    number,       // 5: baseline_score
    number,       // 6: caption_id_index
    number,       // 7: history_len
    number,       // 8: judge_bias_scale (dummy placeholder for buildSamples, filled in batch)
    number,       // 9: corps_scale (dummy)
    number,       // 10: show_id
    number,       // 11: agnostic_show_id
  ];
  ys: Float32Array; // [yScoreResidNorm, yContentResidNorm, yAchievementResidNorm, yTotalNorm]
};


function getRecapFromStep(step: number[], captionIndex: number): number {
  // Per-caption block: [captionScore-baseline, captionRank, normalizedScore, normalizedDelta]
  // Use normalizedScore and denormalize to points.
  const normalizedScore = step[RECAP_OFFSET_IN_FEATS + 2 + captionIndex * CAPTION_STRIDE] ?? 0;
  return normalizedScore * CAPTION_SCORE_SCALE;
}


function computeBaselineMae(samples: Sample[], stats: TargetStats) {
  let zeroSum = 0;
  let meanSum = 0;
  let emaSum = 0;
  let count = 0;

  for (const sample of samples) {
    const seq = sample.xs[0];
    const mask = sample.xs[2];
    const capIdx = sample.xs[6];
    const baseline = sample.xs[5];

    // Truth Recap (absolute)
    // ys[0] is normalizeValue(yScoreResid, stats.deltaMean[capIdx], stats.deltaStd[capIdx])
    const resid = denormalize(sample.ys[0]!, stats.deltaMean[capIdx]!, stats.deltaStd[capIdx]!);
    const actual = resid + baseline;

    // Flattened seq: [SEQ_LEN * FEAT_DIM]
    const validSteps: number[][] = [];
    for (let i = 0; i < SEQ_LEN; i++) {
      if (mask[i] === 1) {
        const step: number[] = Array.from(seq.subarray(i * FEAT_DIM, (i + 1) * FEAT_DIM));
        validSteps.push(step);
      }
    }

    const historyFull = validSteps.map((step) => getRecapFromStep(step, capIdx));
    // Phase 11: Fix leakage. Exclude the last valid step (the label target).
    const history = historyFull.length > 0 ? historyFull.slice(0, -1) : [];
    const ema = history.length ? computeEma(history, EMA_ALPHA) : baseline;
    const meanPred = stats.recapMean[capIdx] ?? 0;

    zeroSum += Math.abs(actual);
    meanSum += Math.abs(actual - meanPred);
    emaSum += Math.abs(actual - ema);
    count += 1;
  }

  return {
    baselineZero: count ? zeroSum / count : 0,
    baselineMean: count ? meanSum / count : 0,
    baselineEma: count ? emaSum / count : 0,
  };
}

function buildSamples(
  rows: DataRow[],
  stats: TargetStats,
  seqLen: number,
  identityDropoutRate: number,
  seed: number,
  epoch: number = 0,
  baselineDropoutRate: number = BASELINE_DROPOUT_RATE,
  baselineNoiseStd: number = BASELINE_NOISE_STD_PTS
): Sample[] {
  const rng = seededRandom(seed);
  const samples: Sample[] = [];
  const shows = Array.from(new Set(rows.map(r => r.showKey)));

  for (const row of rows) {
    const capIdx = CAPTIONS.indexOf(row.captionId as any);
    if (capIdx === -1) continue;

    // Slicing flattened seq: [SEQ_LEN * FEAT_DIM]
    // row.seq is already length SEQ_LEN * FEAT_DIM. If we wanted to slice fewer, we'd need to compute offsets.
    // Given the current architecture, we just pass the full SEQ_LEN based Float32Array.
    const slicedSeq = new Float32Array(row.seq);
    const slicedMask = new Float32Array(SEQ_LEN);
    for (let i = 0; i < SEQ_LEN; i++) {
      slicedMask[i] = row.seqMask[i] ? 1 : 0;
    }

    // Zero out the caption features for the target show (last step)
    const lastValidIdx = row.seqMask.lastIndexOf(true);
    if (lastValidIdx !== -1) {
      const offset = lastValidIdx * FEAT_DIM;
      for (let i = 0; i < CAPTION_COUNT; i++) {
        const base = RECAP_OFFSET_IN_FEATS + i * CAPTION_STRIDE;
        for (let j = 0; j < CAPTION_STRIDE; j++) {
          slicedSeq[offset + base + j] = 0;
        }
      }
    }

    let baseline = row.globalBaseline[capIdx] ?? 15;
    if (rng() < baselineDropoutRate) {
      baseline = 15;
    } else if (baselineNoiseStd > 0) {
      baseline += gaussianRandom(rng) * baselineNoiseStd;
    }

    const yScoreResid = row.yJudgeScore - baseline;
    const yContentResid = row.yJudgeContent ? (row.yJudgeContent - (baseline / 2)) : 0;
    const yAchievementResid = row.yJudgeAchievement ? (row.yJudgeAchievement - (baseline / 2)) : 0;

    const ys = new Float32Array([
      normalizeValue(yScoreResid, stats.deltaMean[capIdx]!, stats.deltaStd[capIdx]!),
      normalizeValue(yContentResid, stats.deltaMean[capIdx]! / 2, stats.deltaStd[capIdx]! / 2),
      normalizeValue(yAchievementResid, stats.deltaMean[capIdx]! / 2, stats.deltaStd[capIdx]! / 2),
      normalizeValue(row.yTotal, stats.totalMean, stats.totalStd)
    ]);

    const historyLen = row.seqMask.filter(m => m).length;
    const showId = shows.indexOf(row.showKey);
    const corpsId = rng() < identityDropoutRate ? UNK_CORPS_ID : row.corpsId;

    samples.push({
      xs: [
        slicedSeq,
        row.stat,
        slicedMask,
        row.judgeIndex,
        corpsId,
        baseline,
        capIdx,
        historyLen,
        1.0,
        1.0,
        showId,
        row.agnosticShowId
      ],
      ys
    });
  }

  return samples;
}


// Persistent buffers to reduce GC pressure
let sequenceBuffer: Float32Array | null = null;
let staticBuffer: Float32Array | null = null;
let maskBuffer: Float32Array | null = null;
let judgeIndexBuffer: Int32Array | null = null;
let captionIdBuffer: Int32Array | null = null;
let corpsIdBuffer: Int32Array | null = null;
let baselineBuffer: Float32Array | null = null;
let historyLenBuffer: Float32Array | null = null;
let showIdBuffer: Int32Array | null = null;
let agnosticShowIdBuffer: Int32Array | null = null;
let ysBuffer: Float32Array | null = null;
let judgeBiasScaleBuffer: Float32Array | null = null;
let corpsScaleBuffer: Float32Array | null = null;
let currentBufferSize = 0;


// PERFORMANCE: Batched tensor creation - creates tensors once per batch instead of per sample
function buildBatchTensors(batchSamples: Sample[], scales: { judgeBias: number, corps: number }): { xs: BatchedInputs; ys: tf.Tensor } {
  const batchSize = batchSamples.length;

  if (batchSize > currentBufferSize) {
    sequenceBuffer = new Float32Array(batchSize * SEQ_LEN * FEAT_DIM);
    staticBuffer = new Float32Array(batchSize * TOTAL_STATIC_DIM);
    maskBuffer = new Float32Array(batchSize * SEQ_LEN);
    judgeIndexBuffer = new Int32Array(batchSize);
    captionIdBuffer = new Int32Array(batchSize);
    corpsIdBuffer = new Int32Array(batchSize);
    baselineBuffer = new Float32Array(batchSize);
    historyLenBuffer = new Float32Array(batchSize);
    showIdBuffer = new Int32Array(batchSize);
    ysBuffer = new Float32Array(batchSize * TARGET_DIM);
    judgeBiasScaleBuffer = new Float32Array(batchSize);
    corpsScaleBuffer = new Float32Array(batchSize);
    agnosticShowIdBuffer = new Int32Array(batchSize);
    currentBufferSize = batchSize;
  }

  const sequenceData = sequenceBuffer!.subarray(0, batchSize * SEQ_LEN * FEAT_DIM);
  const staticData = staticBuffer!.subarray(0, batchSize * TOTAL_STATIC_DIM);
  const maskData = maskBuffer!.subarray(0, batchSize * SEQ_LEN);
  const judgeIndexData = judgeIndexBuffer!.subarray(0, batchSize);
  const captionIdData = captionIdBuffer!.subarray(0, batchSize);
  const corpsIdData = corpsIdBuffer!.subarray(0, batchSize);
  const baselineData = baselineBuffer!.subarray(0, batchSize);
  const historyLenData = historyLenBuffer!.subarray(0, batchSize);
  const showIdData = showIdBuffer!.subarray(0, batchSize);
  const ysData = ysBuffer!.subarray(0, batchSize * TARGET_DIM);
  const judgeBiasScaleData = judgeBiasScaleBuffer!.subarray(0, batchSize);
  const corpsScaleData = corpsScaleBuffer!.subarray(0, batchSize);
  const agnosticShowIdData = agnosticShowIdBuffer!.subarray(0, batchSize);

  for (let i = 0; i < batchSize; i++) {
    const sample = batchSamples[i]!;

    sequenceData.set(sample.xs[0], i * SEQ_LEN * FEAT_DIM);
    staticData.set(sample.xs[1], i * TOTAL_STATIC_DIM);
    maskData.set(sample.xs[2], i * SEQ_LEN);
    judgeIndexData[i] = sample.xs[3];
    corpsIdData[i] = sample.xs[4];
    baselineData[i] = sample.xs[5];
    captionIdData[i] = sample.xs[6];
    historyLenData[i] = sample.xs[7];
    judgeBiasScaleData[i] = scales.judgeBias;
    corpsScaleData[i] = scales.corps;
    showIdData[i] = sample.xs[10];
    agnosticShowIdData[i] = sample.xs[11];
    ysData.set(sample.ys, i * TARGET_DIM);
  }

  return {
    xs: {
      sequence: tf.tensor3d(sequenceData, [batchSize, SEQ_LEN, FEAT_DIM], "float32"),
      static: tf.tensor2d(staticData, [batchSize, TOTAL_STATIC_DIM], "float32"),
      mask: tf.tensor2d(maskData, [batchSize, SEQ_LEN], "float32"),
      judge_id: tf.tensor1d(judgeIndexData, "int32"),
      corps_id: tf.tensor1d(corpsIdData, "int32"),
      baseline_score: tf.tensor1d(baselineData, "float32"),
      caption_id: tf.tensor1d(captionIdData, "int32"),
      history_len: tf.tensor1d(historyLenData, "float32"),
      judge_bias_scale: tf.tensor1d(judgeBiasScaleData, "float32"),
      corps_scale: tf.tensor1d(corpsScaleData, "float32"),
      show_id: tf.tensor1d(showIdData, "int32"),
      agnostic_show_id: tf.tensor1d(agnosticShowIdData, "int32"),
    },
    ys: tf.tensor2d(ysData, [batchSize, TARGET_DIM], "float32"),
  };
}

function* batchGenerator(samples: Sample[], batchSize: number, shuffle: boolean, seed: number, scales: { judgeBias: number, corps: number }): Generator<{ xs: BatchedInputs; ys: tf.Tensor }> {
  const rng = seededRandom(seed);
  const showMap = new Map<number, Sample[]>();
  for (const sample of samples) {
    const showId = sample.xs[10];
    const bucket = showMap.get(showId) ?? [];
    bucket.push(sample);
    showMap.set(showId, bucket);
  }

  const showGroups = Array.from(showMap.values());
  const orderedShows = shuffle ? shuffleArray(showGroups, rng) : showGroups;
  let batch: Sample[] = [];

  for (const showSamples of orderedShows) {
    if (batch.length && batch.length + showSamples.length > batchSize) {
      yield buildBatchTensors(batch, scales);
      batch = [];
    }
    if (showSamples.length > batchSize && batch.length === 0) {
      yield buildBatchTensors(showSamples, scales);
      continue;
    }
    batch.push(...showSamples);
  }
  if (batch.length) yield buildBatchTensors(batch, scales);
}


function createLoss(stats: TargetStats, widthFloorPts: number, rankingWeight: number) {

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

  const lossFn = (yTrue: tf.Tensor, yPred: tf.Tensor, weights: { totalWeight: number, recapWeight: number, deltaWeight: number, categoryWeight: number, quantileWeight: number, consistencyWeight: number }, historyLen: tf.Tensor, showIds: tf.Tensor, scheduledWidthFloorWeight: number, returnComponents = false, regLoss?: tf.Tensor) =>
    tf.tidy(() => {
      // yTrue: [yScoreResidNorm, yContentResidNorm, yAchievementResidNorm, yTotalNorm]
      const scoreTrue = yTrue.slice([0, 0], [-1, 1]);
      const contentTrue = yTrue.slice([0, 1], [-1, 1]);
      const achievementTrue = yTrue.slice([0, 2], [-1, 1]);
      const totalTrue = yTrue.slice([0, 3], [-1, 1]);

      // yPred: [q10, q50, q90, content, achievement, total]
      const q10 = yPred.slice([0, 0], [-1, 1]);
      const q50 = yPred.slice([0, 1], [-1, 1]);
      const q90 = yPred.slice([0, 2], [-1, 1]);
      const contentPred = yPred.slice([0, 3], [-1, 1]);
      const achievementPred = yPred.slice([0, 4], [-1, 1]);
      const totalPred = yPred.slice([0, 5], [-1, 1]);

      const err10 = tf.sub(scoreTrue, q10);
      const err50 = tf.sub(scoreTrue, q50);
      const err90 = tf.sub(scoreTrue, q90);

      const q10Loss = tf.mean(tf.maximum(tf.mul(0.1, err10), tf.mul(-0.9, err10)));
      const q50Loss = tf.mean(tf.maximum(tf.mul(0.5, err50), tf.mul(-0.5, err50)));
      const q90Loss = tf.mean(tf.maximum(tf.mul(0.9, err90), tf.mul(-0.1, err90)));

      const judgeScoreLoss = tf.add(
        tf.mul(tf.scalar(weights.deltaWeight), q50Loss),
        tf.mul(tf.scalar(weights.quantileWeight), tf.add(q10Loss, q90Loss))
      );

      const contentLoss = tf.mean(tf.square(tf.sub(contentTrue, contentPred)));
      const achievementLoss = tf.mean(tf.square(tf.sub(achievementTrue, achievementPred)));
      const subcaptionLoss = tf.add(contentLoss, achievementLoss);

      const totalLoss = tf.mul(tf.scalar(weights.totalWeight), tf.mean(tf.square(tf.sub(totalTrue, totalPred))));

      const rankingLoss = (() => {
        const totalTrueFlat = totalTrue.reshape([-1]);
        const totalPredFlat = totalPred.reshape([-1]);
        const showIdsFlat = showIds.reshape([-1]).toInt();

        const diffTrue = tf.sub(totalTrueFlat.expandDims(1), totalTrueFlat.expandDims(0));
        const diffPred = tf.sub(totalPredFlat.expandDims(1), totalPredFlat.expandDims(0));

        const idRow = showIdsFlat.expandDims(1);
        const idCol = showIdsFlat.expandDims(0);
        const sameShow = tf.equal(idRow, idCol);

        const idx = tf.range(0, totalTrueFlat.shape[0] ?? 0, 1, "int32");
        const row = idx.expandDims(1);
        const col = idx.expandDims(0);
        const lowerTri = tf.greater(row, col);

        const pairMask = tf.logicalAnd(sameShow, lowerTri);
        const maskFloat = tf.cast(pairMask, "float32");

        const gtMask = tf.greater(diffTrue, 0);
        const zeroMask = tf.equal(diffTrue, 0);
        const target = tf.add(tf.cast(gtMask, "float32"), tf.mul(tf.cast(zeroMask, "float32"), 0.5));

        const predProb = tf.clipByValue(tf.sigmoid(diffPred), 1e-7, 1 - 1e-7);
        const lossMatrix = tf.neg(tf.add(tf.mul(target, tf.log(predProb)), tf.mul(tf.sub(1, target), tf.log(tf.sub(1, predProb)))));

        const maskedLoss = tf.mul(lossMatrix, maskFloat);
        const denom = tf.maximum(tf.sum(maskFloat), 1);
        return tf.div(tf.sum(maskedLoss), denom);
      })();

      // Width Penalty
      const hPlus1 = tf.add(historyLen, 1.0);
      const widthFactor = tf.add(1.0, tf.div(0.5, tf.sqrt(hPlus1)));
      // V10 Fix: Target 90% CI (1.64 sigma) instead of 2.56, enabling "The Squeeze"
      const targetWidth = tf.mul(1.64, widthFactor);
      const widthPts = tf.sub(q90, q10);
      const widthPriorError = tf.sub(widthPts, targetWidth);
      const widthPriorLoss = tf.mean(tf.square(widthPriorError));

      const widthFloor = tf.maximum(tf.scalar(widthFloorPts), 0.1);
      const widthPenalty = tf.mean(tf.square(tf.relu(tf.sub(widthFloor, widthPts))));

      const total = tf.addN([
        judgeScoreLoss,
        subcaptionLoss,
        totalLoss,
        tf.mul(tf.scalar(rankingWeight), rankingLoss),
        tf.mul(tf.scalar(scheduledWidthFloorWeight * (weights.quantileWeight > 0 ? 1 : 0)), widthPenalty),
        tf.mul(tf.scalar(weights.quantileWeight), widthPriorLoss),
        regLoss ?? tf.scalar(0)
      ]);

      if (returnComponents) {
        return {
          total,
          judgeScore: judgeScoreLoss,
          subcaption: subcaptionLoss,
          totalScore: totalLoss,
          ranking: rankingLoss,
          widthPenalty,
          widthPrior: widthPriorLoss
        };
      }

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
  console.log("Loading V10 sequence data...");

  console.log("Loading V10 sequence data (Distinct Sequences first)...");

  // 1. Fetch Distinct Sequences
  const seqResult = await client.execute(`
    SELECT DISTINCT season, competition_slug, competition_date, corps_key, x_sequence_json, x_static_json
    FROM ml_sequence_rows_v10
  `);

  console.log(`Loaded ${seqResult.rows.length} distinct sequences. Parsing...`);
  const sequenceMap = new Map<string, { seq: Float32Array; stat: Float32Array; seqMask: boolean[] }>();

  for (const row of seqResult.rows as any[]) {
    const key = `${row.season}_${row.competition_slug}_${row.competition_date}_${row.corps_key}`;

    const seqRaw = JSON.parse(row.x_sequence_json) as number[][];
    const statRaw = JSON.parse(row.x_static_json) as number[];

    const seq = new Float32Array(SEQ_LEN * FEAT_DIM);
    for (let i = 0; i < seqRaw.length; i++) {
      const step = seqRaw[i]!;
      for (let j = 0; j < step.length; j++) {
        seq[i * FEAT_DIM + j] = step[j] ?? 0;
      }
    }
    const stat = new Float32Array(statRaw);
    const seqMask = seqRaw.map((step) => step.some((val) => val !== 0));

    sequenceMap.set(key, { seq, stat, seqMask });
  }

  // 2. Fetch Score Rows (Metadata only, no heavy JSON)
  console.log("Loading Score Rows...");
  const scoreResult = await client.execute(`
    SELECT season, competition_slug, competition_date, division_name, corps_key, corps_id, caption_id, judge_id, judge_index, y_judge_score, y_judge_content, y_judge_achievement, y_total, agnostic_show_id, split
    FROM ml_sequence_rows_v10
  `);

  const scoreRows = scoreResult.rows as unknown as Array<{
    season: string;
    competition_slug: string;
    competition_date: string;
    division_name: string;
    corps_key: string;
    corps_id: number;
    caption_id: string;
    judge_id: string;
    judge_index: number;
    y_judge_score: number;
    y_judge_content: number | null;
    y_judge_achievement: number | null;
    y_total: number;
    agnostic_show_id: number;
    split: string;
  }>;
  client.close();

  const allDataRows = buildDataRows(scoreRows, sequenceMap);
  const nonTestRows = allDataRows.filter((row) => row.split !== "test");

  const testRows = allDataRows.filter((row) => row.split === "test");

  // Determine train/val via custom split for better production monitoring
  const valRng = seededRandom(args.seed);
  const shuffled = shuffleArray([...nonTestRows], valRng);
  const valCount = Math.max(1, Math.floor(shuffled.length * args.valSplit));

  const valRows = shuffled.slice(0, valCount);
  const trainRows = shuffled.slice(valCount);

  const baselineScope = args.baselineScope.toLowerCase();
  const baselineHistoryRows = baselineScope === "global" ? allDataRows : trainRows;
  if (baselineScope !== "global" && baselineScope !== "train") {
    console.warn(`Unknown baseline scope '${args.baselineScope}', defaulting to 'train'.`);
  }
  applyBaselines(allDataRows, baselineHistoryRows);

  const trainSubset = args.maxRows ? trainRows.slice(0, args.maxRows) : trainRows;

  const valSubset = args.maxRows ? valRows.slice(0, Math.min(args.maxRows, valRows.length)) : valRows;

  if (!trainSubset.length) {
    throw new Error("Missing train data for V7 model.");
  }

  const stats = computeTargetStats(trainSubset);
  fs.writeFileSync(NORM_PATH, JSON.stringify(stats, null, 2));
  console.log(`Saved normalization stats to ${NORM_PATH}`);

  // Default to full sequence length for initial sample building if needed (but we build per epoch now)
  const initialTrainSamples = buildSamples(trainSubset, stats, SEQ_LEN, 1.0, args.seed, 0, 0, 0);
  const initialValSamples = buildSamples(valSubset, stats, SEQ_LEN, 1.0, args.seed + 1, 0, 0, 0);


  // Phase 13: Feature Index Audit
  if (initialValSamples.length > 0) {
    const auditSample = initialValSamples[0]!;
    const lastValidIdx = auditSample.xs[2].lastIndexOf(1);
    if (lastValidIdx !== -1) {
      const stepOffset = lastValidIdx * FEAT_DIM;
      const step = auditSample.xs[0].subarray(stepOffset, stepOffset + FEAT_DIM);
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

  const testSeq = initialTrainSamples[0]?.xs[0];
  if (testSeq && testSeq.length !== SEQ_LEN * FEAT_DIM) {
    throw new Error(`Feature dimension mismatch: expected ${SEQ_LEN * FEAT_DIM}, got ${testSeq.length} `);
  }

  console.log(`V7 Splits -> Train: ${trainRows.length}, Val: ${valRows.length}, Test: ${testRows.length} `);
  if (args.maxRows) {
    console.log(`Using maxRows = ${args.maxRows} for quick training.`);
  }
  if (initialValSamples.length) {
    console.log(
      `Baselines(monitoring forecast MAE): zero = ${baselines.baselineZero.toFixed(4)}, ` +
      `mean = ${baselines.baselineMean.toFixed(4)}, ema = ${baselines.baselineEma.toFixed(4)} `
    );
  }

  const { lossFn, dispose: disposeLoss } = createLoss(stats, args.widthFloorPts, args.rankingWeight);


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


  function createModel(): tf.LayersModel {
    const sequenceInput = tf.input({ shape: [SEQ_LEN, FEAT_DIM], name: "sequence" });
    const staticInput = tf.input({ shape: [TOTAL_STATIC_DIM], name: "static" });
    const maskInput = tf.input({ shape: [SEQ_LEN], name: "mask" });
    const judgeIdInput = tf.input({ shape: [1], name: "judge_id", dtype: "int32" });
    const corpsIdInput = tf.input({ shape: [1], name: "corps_id", dtype: "int32" });
    const baselineInput = tf.input({ shape: [1], name: "baseline_score" });
    const captionIdInput = tf.input({ shape: [1], name: "caption_id", dtype: "int32" });
    const judgeBiasScaleInput = tf.input({ shape: [1], name: "judge_bias_scale" });
    const corpsScaleInput = tf.input({ shape: [1], name: "corps_scale" });

    const judgeEmbedding = tf.layers.embedding({
      inputDim: JUDGE_COUNT,
      outputDim: 8,
      name: "judge_embedding",
      embeddingsInitializer: "glorotNormal",
    }).apply(judgeIdInput) as tf.SymbolicTensor;

    const captionEmbedding = tf.layers.embedding({
      inputDim: CAPTION_COUNT,
      outputDim: 4,
      name: "caption_embedding",
      embeddingsInitializer: "glorotNormal",
    }).apply(captionIdInput) as tf.SymbolicTensor;

    const corpsEmbedding = tf.layers.embedding({
      inputDim: CORPS_COUNT,
      outputDim: 16,
      name: "corps_embedding",
      embeddingsInitializer: "glorotNormal",
    }).apply(corpsIdInput) as tf.SymbolicTensor;

    const agnosticShowIdInput = tf.input({ shape: [1], name: "agnostic_show_id", dtype: "int32" });
    const showEmbedding = tf.layers.embedding({
      inputDim: SHOW_COUNT,
      outputDim: 8,
      name: "show_embedding",
      embeddingsInitializer: "glorotNormal",
    }).apply(agnosticShowIdInput) as tf.SymbolicTensor;

    const flatJudgeEmbed = tf.layers.flatten().apply(judgeEmbedding) as tf.SymbolicTensor;
    const flatCapEmbed = tf.layers.flatten().apply(captionEmbedding) as tf.SymbolicTensor;
    const flatCorpsEmbed = tf.layers.flatten().apply(corpsEmbedding) as tf.SymbolicTensor;
    const flatShowEmbed = tf.layers.flatten().apply(showEmbedding) as tf.SymbolicTensor;

    const lstm = tf.layers.lstm({
      units: 128,
      returnSequences: false,
      name: "lstm_core"
    }).apply(sequenceInput, { mask: maskInput }) as tf.SymbolicTensor;

    const concatenated = tf.layers.concatenate().apply([
      lstm,
      staticInput,
      flatJudgeEmbed,
      flatCapEmbed,
      flatCorpsEmbed,
      flatShowEmbed,
      baselineInput
    ]) as tf.SymbolicTensor;

    let x = tf.layers.dense({ units: 256, activation: "relu", name: "dense_1" }).apply(concatenated) as tf.SymbolicTensor;
    x = tf.layers.dropout({ rate: 0.2 }).apply(x) as tf.SymbolicTensor;
    x = tf.layers.dense({ units: 128, activation: "relu", name: "dense_2" }).apply(x) as tf.SymbolicTensor;

    // Outputs: [q10, q50, q90, content, achievement, total]
    const outputs = tf.layers.dense({ units: 6, name: "final_output" }).apply(x) as tf.SymbolicTensor;

    return tf.model({
      inputs: [
        sequenceInput,
        staticInput,
        maskInput,
        judgeIdInput,
        corpsIdInput,
        baselineInput,
        captionIdInput,
        judgeBiasScaleInput,
        corpsScaleInput,
        agnosticShowIdInput
      ],
      outputs: outputs,
    });
  }

  const model = createModel();

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
    `Hyperparameters: lstm=128, dropout=0.2, ` +
    `lr=${args.learningRate}, batch=${args.batchSize}, width_floor_pts=${args.widthFloorPts}, ` +
    `width_floor_schedule=${args.widthFloorStart}->${args.widthFloorEnd}`
  );


  const setLearningRate = (lr: number) => {
    const opt = optimizer as unknown as { setLearningRate?: (value: number) => void; learningRate?: number };
    if (opt.setLearningRate) opt.setLearningRate(lr);
    else if (opt.learningRate != null) opt.learningRate = lr;
  };

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

  const scheduler = new V8LossScheduler2();
  const provider = new SequenceDataProviderV9(trainSubset, 0, args.batchSize);

  // PERFORMANCE: Cache validation samples outside the epoch loop
  const cachedValSamples = buildSamples(valSubset, stats, 15, 0.0, args.seed + 999, 0, 0, 0);
  console.log(`Cached ${cachedValSamples.length} validation samples`);

  const statTensors = {
    deltaMean: tf.tensor1d(stats.deltaMean),
    deltaStd: tf.tensor1d(stats.deltaStd),
    totalMean: tf.scalar(stats.totalMean),
    totalStd: tf.scalar(stats.totalStd)
  };

  for (let epoch = args.startEpoch; epoch < args.startEpoch + args.epochs; epoch++) {
    provider.setEpoch(epoch);
    const weights = scheduler.getWeights(epoch);
    const scales = scheduler.getScales(epoch);
    if (args.noJudgeBias) scales.judgeBias = 0;
    if (args.noCorpsResidual) scales.corps = 0;

    const seqLen = provider.getSequenceLength();
    const epochSamples = buildSamples(
      provider.sampleRows(args.samplesPerEpoch, args.seed + epoch),
      stats,
      seqLen,
      weights.identityDropoutRate,
      args.seed + epoch,
      epoch,
      args.baselineDropout,
      args.baselineNoiseStd
    );

    const currentWidthFloorWeight = scheduler.getWidthFloorWeight(epoch, args.widthFloorStart, args.widthFloorEnd);
    console.log(`\nEpoch ${epoch}: Weights ${JSON.stringify(weights)}, Scales ${JSON.stringify(scales)}, SeqLen ${seqLen}, WFW ${currentWidthFloorWeight.toFixed(3)}`);

    const warmup = Math.max(0, Math.min(args.warmupEpochs, args.epochs));
    let lr: number;
    if (epoch < warmup) {
      lr = (args.learningRate * (epoch + 1)) / Math.max(1, warmup);
    } else {
      const progress = warmup >= args.epochs ? 1 : (epoch - warmup) / Math.max(1, args.epochs - warmup);
      lr = args.minLr + 0.5 * (args.learningRate - args.minLr) * (1 + Math.cos(Math.PI * progress));
    }
    setLearningRate(lr);

    let trainLossSum = 0;
    let trainCount = 0;

    for (const batch of batchGenerator(epochSamples, args.batchSize, true, args.seed + epoch, scales)) {
      const xs = batch.xs;
      const ys = batch.ys;
      const batchSize = ys.shape[0] ?? 0;

      const { value, grads } = tf.variableGrads(() =>
        tf.tidy(() => {
          const preds = model.predict([
            xs.sequence,
            xs.static,
            xs.mask,
            xs.judge_id,
            xs.corps_id,
            xs.baseline_score,
            xs.caption_id,
            xs.judge_bias_scale,
            xs.corps_scale,
            xs.agnostic_show_id
          ]) as tf.Tensor;
          let regLoss = tf.scalar(0);
          for (const layer of model.layers) {
            if (layer.losses && layer.losses.length) {
              regLoss = tf.add(regLoss, tf.addN(layer.losses as any[]));
            }
          }
          const scheduledWFW = scheduler.getWidthFloorWeight(epoch, args.widthFloorStart, args.widthFloorEnd);
          return lossFn(ys, preds, weights, xs.history_len, xs.show_id, scheduledWFW, false, regLoss) as tf.Scalar;
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
      gradList.forEach((g) => g.dispose());
      clipped.forEach((g) => g.dispose());
      Object.values(xs).forEach((t) => t.dispose());
      ys.dispose();
    }

    let monitoringStats = {
      valScore: 0,
      valMaePoints: 0,
      coverage: 0,
      width: 0,
      totalMae: 0
    };

    if (cachedValSamples.length) {
      let valLossSum = 0;
      let valMaePtsSum = 0;
      let valCovSum = 0;
      let valWidthSum = 0;
      let valTotalMaeSum = 0;
      let valCountTotal = 0;

      for (const batch of batchGenerator(cachedValSamples, args.batchSize, false, args.seed, scales)) {
        const { xs, ys } = batch;
        const batchSize = ys.shape[0] ?? 0;

        const preds = model.predict([
          xs.sequence,
          xs.static,
          xs.mask,
          xs.judge_id,
          xs.corps_id,
          xs.baseline_score,
          xs.caption_id,
          xs.judge_bias_scale,
          xs.corps_scale,
          xs.agnostic_show_id
        ]) as tf.Tensor;

        const scheduledWFW = scheduler.getWidthFloorWeight(epoch, args.widthFloorStart, args.widthFloorEnd);
        const lossTensor = lossFn(ys, preds, weights, xs.history_len, xs.show_id, scheduledWFW) as tf.Tensor;

        const metrics = tf.tidy(() => {
          const q10 = preds.slice([0, 0], [-1, 1]).squeeze([1]);
          const q50 = preds.slice([0, 1], [-1, 1]).squeeze([1]);
          const q90 = preds.slice([0, 2], [-1, 1]).squeeze([1]);
          const totalPred = preds.slice([0, 5], [-1, 1]).squeeze([1]);

          const scoreTrue = ys.slice([0, 0], [-1, 1]).squeeze([1]);
          const totalTrue = ys.slice([0, 3], [-1, 1]).squeeze([1]);

          const batchMean = tf.gather(statTensors.deltaMean, xs.caption_id);
          const batchStd = tf.gather(statTensors.deltaStd, xs.caption_id);

          const q50Points = tf.add(tf.mul(q50, batchStd), batchMean);
          const truePoints = tf.add(tf.mul(scoreTrue, batchStd), batchMean);
          const maePoints = tf.abs(tf.sub(q50Points, truePoints)).mean();

          const q10Points = tf.add(tf.mul(q10, batchStd), batchMean);
          const q90Points = tf.add(tf.mul(q90, batchStd), batchMean);
          const within = tf.logicalAnd(tf.greaterEqual(truePoints, q10Points), tf.lessEqual(truePoints, q90Points));
          const coverage = tf.cast(within, "float32").mean();
          const width = tf.sub(q90Points, q10Points).mean();

          const totalDenorm = tf.add(tf.mul(totalPred, statTensors.totalStd), statTensors.totalMean);
          const totalTrueDenorm = tf.add(tf.mul(totalTrue, statTensors.totalStd), statTensors.totalMean);
          const totalMae = tf.abs(tf.sub(totalDenorm, totalTrueDenorm)).mean();

          return { maePoints, coverage, width, totalMae };
        });

        const lossVal = lossTensor.dataSync()[0] ?? 0;
        valLossSum += lossVal * batchSize;
        valMaePtsSum += metrics.maePoints.dataSync()[0]! * batchSize;
        valCovSum += metrics.coverage.dataSync()[0]! * batchSize;
        valWidthSum += metrics.width.dataSync()[0]! * batchSize;
        valTotalMaeSum += metrics.totalMae.dataSync()[0]! * batchSize;
        valCountTotal += batchSize;

        lossTensor.dispose();
        Object.values(metrics).forEach(t => t.dispose());
        preds.dispose();
        Object.values(xs).forEach((t) => t.dispose());
        ys.dispose();
      }

      const valMaePoints = valMaePtsSum / valCountTotal;
      const coverage = valCovSum / valCountTotal;
      const width = valWidthSum / valCountTotal;
      const totalMae = valTotalMaeSum / valCountTotal;

      monitoringStats = {
        valScore: valMaePoints + 0.1 * totalMae + Math.pow(Math.max(0, 0.8 - coverage), 2),
        valMaePoints,
        coverage,
        width,
        totalMae
      };
    }

    if (args.swa && epoch >= swaStartEpoch && (epoch - swaStartEpoch) % swaInterval === 0) {
      const currentWeights = model.getWeights();
      if (!swaWeights) {
        swaWeights = currentWeights.map((t) => t.clone());
        swaCount = 1;
      } else {
        const nextCount = swaCount + 1;
        const updated: tf.Tensor[] = swaWeights.map((avg, idx) => {
          const w = tf.add(tf.mul(avg, swaCount), currentWeights[idx]!);
          const next = tf.div(w, nextCount);
          avg.dispose();
          return next;
        });
        swaWeights = updated;
        swaCount = nextCount;
      }
      currentWeights.forEach((t) => t.dispose());
    }

    const trainLoss = trainCount ? trainLossSum / trainCount : 0;
    console.log(
      `Epoch ${epoch}: loss=${trainLoss.toFixed(6)} mae=${monitoringStats.valMaePoints.toFixed(4)} totalMae=${monitoringStats.totalMae.toFixed(4)} cov=${monitoringStats.coverage.toFixed(3)} width=${monitoringStats.width.toFixed(2)} score=${monitoringStats.valScore.toFixed(4)}`
    );

    if (monitoringStats.valScore < bestScore - 1e-4) {
      bestScore = monitoringStats.valScore;
      patience = 0;
      if (bestWeights) bestWeights.forEach((t) => t.dispose());
      bestWeights = model.getWeights().map((t) => t.clone());
      const now = Date.now();
      if (now - lastBestSaveMs > MIN_BEST_SAVE_INTERVAL_MS) {
        await saveModel(model, bestDir);
        lastBestSaveMs = now;
        console.log(`Saved BEST @epoch ${epoch}`);
      }
    } else {
      if (++patience >= args.patience) break;
    }
  }

  if (args.swa && swaWeights) {
    model.setWeights(swaWeights);
  } else if (bestWeights) {
    model.setWeights(bestWeights);
  }

  model.save(`file://${runDir}`);
  console.log("Training complete.");
}

main().catch(console.error);

