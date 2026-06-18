/**
 * trainModelV9-FIXED: Corrected Quantile Model with Split Heads
 *
 * FIXES OVER V9-improved:
 * 1. INCREASED CAPACITY: Dense 256→512, 128→256 (+200K+ params)
 * 2. SPLIT HEADS: Dedicated accuracyTrunk (128 units) for Mean, separate widthConcat for Quantiles
 * 3. PRIORITY: deltaWeight = 10.0 (10x accuracy priority), quantileWeight = 0.05-0.10
 * 4. GRADIENT ISOLATION: Mean head no longer competes with Width head for gradients
 *
 * TARGET: <0.2 MAE with honest uncertainty intervals
 * ESTIMATED TRAINING TIME: 6-8 hours
 */

import * as tf from "@tensorflow/tfjs-node";
import { createClient } from "@libsql/client";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const DB_PATH = "./dci-relational.db";
const MODEL_DIR = "./models/v9_subcaption_fixed";
const NORM_PATH = "./results/v9-subcaption-target-norm.json";
const JUDGE_INDEX_PATH = "./src/training/judgeIndexMap.json";
const CORPS_INDEX_PATH = "./src/training/corpsIndexMap.json";
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const CAPTION_COUNT = CAPTIONS.length;
const SEQ_LEN = 15;
const FEAT_DIM = 101;
const RAW_STATIC_DIM = 169;

const TREND_DIM = CAPTION_COUNT;
const CONTEXT_DIM = 0;
const TOTAL_STATIC_DIM = RAW_STATIC_DIM + TREND_DIM + CONTEXT_DIM;

const BATCH_SIZE = 32;
const EPOCHS = 800;
const EARLY_STOPPING_PATIENCE = 120;
const REDUCE_LR_PATIENCE = 60;
const PADDING_INDEX = 3;
// V9: WIDTH_FLOOR_PTS maintained, but logic inside loss function tightened
const WIDTH_FLOOR_PTS = 0.5;
const WIDTH_FLOOR_WEIGHT = 1.5;
const SCORE_COVERAGE_TARGET = 0.8;
const SCORE_COVERAGE_WEIGHT = 0.2; // V9: Slightly increased from 0.1 to balance the squeeze
const EMA_ALPHA = 0.3;
const RECAP_OFFSET_IN_FEATS = 21;
const CAPTION_STRIDE = 4;
const CAPTION_SCORE_SCALE = 20;
const SAMPLES_PER_EPOCH = 4096;

const WIDTH_TARGET_PTS = 2.5;
const UNK_CORPS_ID = 0;
const DELTA_DIM = CAPTION_COUNT * 3;
const BASELINE_DROPOUT_RATE = 0.1;
const BASELINE_NOISE_STD_PTS = 0.25;


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
const CATEGORY_DIM = 3;
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
      const hasAny = tf.any(boolMask, 1, true);
      const defaultMask = tf.oneHot(tf.cast(tf.zeros([hasAny.shape[0]], "int32"), "int32"), SEQ_LEN, 1.0, 0.0);
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

class AttentionPoolingLayer extends tf.layers.Layer {
  static className = "AttentionPoolingLayer";
  constructor(config?: any) {
    super(config || {});
  }

  computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape | tf.Shape[] {
    const shapes = inputShape as [number[], number[]];
    return [shapes[1][0], shapes[1][2]];
  }

  call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor | tf.Tensor[] {
    return tf.tidy(() => {
      const [weights, input] = inputs as [tf.Tensor, tf.Tensor];
      const weighted = tf.mul(weights, input);
      return tf.sum(weighted, 1);
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
    reduceLrPatience: Number(get("--reduce-lr-patience", `${REDUCE_LR_PATIENCE}`)),
    lstm1Units: Number(get("--lstm1-units", "128")),
    lstm2Units: Number(get("--lstm2-units", "64")),
    dropoutLstm: Number(get("--dropout-lstm", "0.2")),
    recurrentDropout: Number(get("--recurrent-dropout", "0.1")),
    dropoutDense1: Number(get("--dropout-dense1", "0.3")),
    dropoutDense2: Number(get("--dropout-dense2", "0.2")),
    l2Reg: Number(get("--l2-reg", "0.000025")),
    learningRate: Number(get("--lr", "0.0003")),
    minLr: Number(get("--min-lr", "0.00003")),
    warmupEpochs: Number(get("--warmup-epochs") || 10),
    startEpoch: Number(get("--start-epoch") || 0),
    clipNorm: Number(get("--clip-norm") || 1.0),
    seed: Number(get("--seed", "42")),
    swa: get("--swa", "true") === "true",
    swaStart: Number(get("--swa-start", "0.75")),
    swaInterval: Number(get("--swa-interval", "1")),
    snapshotEpochs: get("--snapshot-epochs", ""),
    useMha: get("--use-mha", "false") === "true",
    widthFloorPts: Number(get("--width-floor-pts", `${WIDTH_FLOOR_PTS}`)),
    widthFloorWeight: Number(get("--width-floor-weight", `${WIDTH_FLOOR_WEIGHT}`)),
    widthFloorStart: Number(get("--width-floor-start", "0.1")),
    widthFloorEnd: Number(get("--width-floor-end", `${WIDTH_FLOOR_WEIGHT}`)),
    rankingWeight: Number(get("--ranking-weight", "0.1")),
    valSplit: Number(get("--val-split", "0.05")),
    samplesPerEpoch: Number(get("--samples-per-epoch", `${SAMPLES_PER_EPOCH}`)),
    loadModel: get("--load-model"),
    baselineDropout: Number(get("--baseline-dropout", `${BASELINE_DROPOUT_RATE}`)),
    baselineNoiseStd: Number(get("--baseline-noise-std", `${BASELINE_NOISE_STD_PTS}`)),
    logCsv: get("--log-csv", "./results/lstm-v9-production-training-log.csv"),
    trialId: get("--trial-id"),
    noJudgeBias: get("--no-judge-bias", "false") === "true",
    noCorpsResidual: get("--no-corps-residual", "false") === "true",
    outputReport: get("--output-report", "eval_report.json") || "eval_report.json",
    baselineScope: get("--baseline-scope", "train") || "train",
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
  return maxW * t * t * (3 - 2 * t);
};

type DataRow = {
  seq: number[][];
  seqMask: boolean[];
  stat: number[];
  judgeIndices: number[];
  corpsId: number;
  recap: number[];
  total: number;
  agnosticShowId: number;
  division: string;
  split: string;
  contextFeatures: number[];
  date: string;
  showKey: string;
  globalBaseline: number[];
  trendSlopes: number[];
};


type TargetStats = {
  deltaMean: number[];
  deltaStd: number[];
  recapMean: number[];
  recapStd: number[];
  categoryMean: number[];
  categoryStd: number[];
  totalMean: number;
  totalStd: number;
  deltaWeights: number[];
  recapWeights: number[];
};

class V9LossScheduler {
  getWeights(epoch: number) {
    // Phase A: Baseline Correction (Epochs 0-40)
    if (epoch < 40) {
      return {
        totalWeight: 0.05,
        recapWeight: 1.0,
        deltaWeight: 0.2,
        categoryWeight: 0.05,
        quantileWeight: 0.02,
        consistencyWeight: 0.0,
        identityDropoutRate: 0.95
      };
    }

    // Phase B: Structure + Median Deltas (Epochs 40-120)
    if (epoch < 120) {
      const t = (epoch - 40) / 80;
      return {
        totalWeight: 0.00,
        recapWeight: 1.0 - 0.7 * t, // 1.0 -> 0.3
        deltaWeight: 0.2 + 0.8 * t, // 0.2 -> 1.0
        categoryWeight: 0.05,
        quantileWeight: 0.02 + 0.08 * t,    // 0.02 -> 0.10
        consistencyWeight: 0.0,
        identityDropoutRate: 0.95
      };
    }


    // Phase C: The Squeeze (Epochs 120+)
    // FIXED: Prioritize accuracy (deltaWeight) AND force interval tightening (quantileWeight)
    const t = Math.min(1.0, (epoch - 120) / 680);
    const idDrop = (epoch < 100) ? 1.0 : Math.max(0.05, 1.0 - 0.95 * ((epoch - 100) / 200));

    return {
      totalWeight: 0.10,
      recapWeight: 0.05,
      deltaWeight: 10.0,
      categoryWeight: 0.05,
      quantileWeight: 0.10 + 0.90 * t, // SQUEEZE: Ramp from 0.1 to 1.0 (prev was ~0.07)
      consistencyWeight: 0.0,
      identityDropoutRate: idDrop
    };
  }

  getScales(epoch: number) {
    const judgeBias = Math.min(1.0, epoch / 120);
    const corps = epoch < 80 ? 0 : Math.min(1.0, (epoch - 80) / 100);
    return { judgeBias, corps };
  }

  getWidthFloorWeight(epoch: number, startWeight: number, endWeight: number): number {
    if (epoch < 40) {
      return startWeight;
    }
    if (epoch < 120) {
      const t = (epoch - 40) / 80;
      const smooth = t * t * (3 - 2 * t);
      return startWeight + (endWeight - startWeight) * smooth;
    }
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


function buildDataRows(rows: Array<{ x_sequence_json: string; x_static_json: string; y_residuals_json: string; y_recap_json: string; judge_indices_json: string; division_name: string; corps_id: number; split: string; competition_slug?: string; competition_date: string; season: string }>) {
  const shows: Record<string, typeof rows> = {};
  for (const row of rows) {
    const key = `${row.season}_${row.competition_slug ?? "unknown"}_${row.competition_date}`;
    if (!shows[key]) shows[key] = [];
    shows[key].push(row);
  }

  const dataRows: DataRow[] = [];

  for (const showKey in shows) {
    const showRows = shows[showKey]!;
    const parsedShow = showRows.map(r => {
      const recap = JSON.parse(r.y_recap_json) as Record<string, number>;
      const total = ((recap["GE1"] ?? 0) + (recap["GE2"] ?? 0)) +
        (((recap["VP"] ?? 0) + (recap["VA"] ?? 0) + (recap["CG"] ?? 0)) / 2) +
        (((recap["MB"] ?? 0) + (recap["MA"] ?? 0) + (recap["MP"] ?? 0)) / 2);
      return { row: r, recap, total };
    });

    for (const { row, recap, total } of parsedShow) {

      const rawSeq = JSON.parse(row.x_sequence_json) as number[][];
      const seqMask = rawSeq.map((step) => step[PADDING_INDEX] !== 1);
      const seq = rawSeq.map((step) => (step[PADDING_INDEX] === 1 ? new Array(FEAT_DIM).fill(0) : step));
      const stat = JSON.parse(row.x_static_json) as number[];
      const judgeIndices = JSON.parse(row.judge_indices_json) as number[];
      const agnosticShowId = (row as any).agnostic_show_id ?? 0;

      if (seq.length !== SEQ_LEN || (seq[0] && seq[0].length !== FEAT_DIM)) continue;
      if (stat.length !== RAW_STATIC_DIM) continue;

      const recapValues: number[] = [];
      const contextFeatures: number[] = [];

      for (let i = 0; i < CAPTIONS.length; i++) {
        const cap = CAPTIONS[i]!;
        const val = recap[cap] ?? 0;
        recapValues.push(val);
      }

      dataRows.push({
        seq,
        seqMask,
        stat,
        judgeIndices,
        corpsId: row.corps_id ?? 0,
        recap: recapValues,
        total,
        agnosticShowId,
        division: row.division_name,
        split: row.split,
        contextFeatures,
        date: row.competition_date,
        showKey,
        globalBaseline: [],
        trendSlopes: [],
      });
    }
  }

  return dataRows;
}

function applyBaselines(rows: DataRow[], historyRows: DataRow[]) {
  const historySet = new Set(historyRows);
  const corpsMap: Record<number, DataRow[]> = {};
  for (const row of rows) {
    if (!corpsMap[row.corpsId]) corpsMap[row.corpsId] = [];
    corpsMap[row.corpsId]!.push(row);
  }

  const alpha = EMA_ALPHA;
  for (const corpsId in corpsMap) {
    const corpsRows = corpsMap[corpsId]!;
    corpsRows.sort((a, b) => {
      if (a.date < b.date) return -1;
      if (a.date > b.date) return 1;
      return a.showKey < b.showKey ? -1 : a.showKey > b.showKey ? 1 : 0;
    });

    const ema = new Array(CAPTION_COUNT).fill(null) as (number | null)[];
    const recapHistory: number[][] = Array.from({ length: CAPTION_COUNT }, () => []);

    for (const row of corpsRows) {
      row.globalBaseline = ema.map((value) => value ?? 0);

      const slopes: number[] = [];
      for (let i = 0; i < CAPTION_COUNT; i++) {
        const history = recapHistory[i]!;
        const last3 = history.slice(-3);
        const slope = last3.length >= 2
          ? (last3[last3.length - 1]! - last3[0]!) / (last3.length - 1) / 0.1
          : 0;
        slopes.push(slope);
      }
      row.trendSlopes = slopes;

      if (!historySet.has(row)) {
        continue;
      }

      for (let i = 0; i < CAPTION_COUNT; i++) {
        const val = row.recap[i];
        if (val !== undefined && val !== null) {
          if (ema[i] === null) {
            ema[i] = val;
          } else {
            ema[i] = alpha * val + (1 - alpha) * ema[i]!;
          }
          recapHistory[i]!.push(val);
          if (recapHistory[i]!.length > 3) recapHistory[i]!.shift();
        }
      }
    }
  }
}


function computeTargetStats(rows: DataRow[]): TargetStats {
  const deltaSeries = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const recapSeries = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const categorySeries = Array.from({ length: 3 }, () => [] as number[]);
  const totalSeries: number[] = [];

  for (const row of rows) {
    const baseline = row.globalBaseline;

    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      const rawRecap = row.recap[idx] ?? 0;
      const baselineRaw = baseline[idx] ?? 0;
      const deltaRaw = rawRecap - baselineRaw;

      deltaSeries[idx]!.push(deltaRaw);
      recapSeries[idx]!.push(rawRecap);
    }

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
  xs: [number[][], number[], number[], number[], number, number[], number, number, number];
  ys: number[];
};


function getRecapFromStep(step: number[], captionIndex: number): number {
  const normalizedScore = step[RECAP_OFFSET_IN_FEATS + 2 + captionIndex * CAPTION_STRIDE] ?? 0;
  return normalizedScore * CAPTION_SCORE_SCALE;
}


/**
 * Fit quadratic regression y = ax² + bx + c to historical scores
 * Returns predicted next value, or fallback if insufficient data
 */
function predictQuadratic(history: number[], fallback: number): number {
  if (history.length < 3) return fallback;

  // Use last 10 points max for fitting (too many can overfit to noise)
  const points = history.slice(-Math.min(10, history.length));
  const n = points.length;

  // Build normal equations for least squares: [a, b, c]
  // ∑x⁴  ∑x³  ∑x²    a     ∑x²y
  // ∑x³  ∑x²  ∑x     b  =  ∑xy
  // ∑x²  ∑x   n      c     ∑y

  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0;
  let sy = 0, sxy = 0, sx2y = 0;

  for (let i = 0; i < n; i++) {
    const x = i;
    const y = points[i]!;
    const x2 = x * x;
    const x3 = x2 * x;
    const x4 = x2 * x2;

    sx += x;
    sx2 += x2;
    sx3 += x3;
    sx4 += x4;
    sy += y;
    sxy += x * y;
    sx2y += x2 * y;
  }

  // Solve using Cramer's rule
  // Normal Equations:
  // | sx4 sx3 sx2 | | a |   | sx2y |
  // | sx3 sx2 sx1 | | b | = | sxy  |
  // | sx2 sx1 n   | | c |   | sy   |
  const sx1 = sx;
  const det = sx4 * (sx2 * n - sx1 * sx1) - sx3 * (sx3 * n - sx1 * sx2) + sx2 * (sx3 * sx1 - sx2 * sx2);
  if (Math.abs(det) < 1e-10) return fallback;

  const detA = sx2y * (sx2 * n - sx1 * sx1) - sxy * (sx3 * n - sx1 * sx2) + sy * (sx3 * sx1 - sx2 * sx2);
  const detB = sx4 * (sxy * n - sy * sx1) - sx3 * (sx2y * n - sy * sx2) + sx2 * (sx2y * sx1 - sxy * sx2);
  const detC = sx4 * (sx2 * sy - sx1 * sxy) - sx3 * (sx3 * sy - sx1 * sx2y) + sx2 * (sx3 * sxy - sx2 * sx2y);

  const a = detA / det;
  const b = detB / det;
  const c = detC / det;

  // Predict next point at x = n
  const xNext = n;
  return a * xNext * xNext + b * xNext + c;
}

function computeBaselineMae(samples: Sample[], stats: TargetStats) {
  let zeroSum = 0;
  let meanSum = 0;
  let emaSum = 0;
  let quadSum = 0;
  let count = 0;

  for (const sample of samples) {
    const seq = sample.xs[0];
    const mask = sample.xs[2];
    const steps = mask.length
      ? seq.filter((_, idx) => mask[idx] === 1)
      : seq.filter((step) => step.some((value) => value !== 0));

    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      const truthRecapNorm = sample.ys[CAPTION_COUNT + idx] ?? 0;
      const actual = denormalize(truthRecapNorm, stats.recapMean[idx]!, stats.recapStd[idx]!);

      const historyFull = steps.map((step) => getRecapFromStep(step, idx));
      const history = historyFull.length > 0 ? historyFull.slice(0, -1) : [];
      const ema = history.length ? computeEma(history, EMA_ALPHA) : 0;
      const meanPred = stats.recapMean[idx] ?? 0;
      const quadPred = predictQuadratic(history, meanPred);

      zeroSum += Math.abs(actual);
      meanSum += Math.abs(actual - meanPred);
      emaSum += Math.abs(actual - ema);
      quadSum += Math.abs(actual - quadPred);
      count += 1;
    }
  }

  return {
    baselineZero: count ? zeroSum / count : 0,
    baselineMean: count ? meanSum / count : 0,
    baselineEma: count ? emaSum / count : 0,
    baselineQuad: count ? quadSum / count : 0,
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
  const samples: Sample[] = [];
  const rng = seededRandom(seed);

  const agnosticShowSet = new Set<number>();
  for (const row of rows) agnosticShowSet.add(row.agnosticShowId);
  const UNIQUE_SHOW_COUNT = Math.max(1, Math.max(...Array.from(agnosticShowSet)) + 1);
  (globalThis as any).UNIQUE_SHOW_COUNT = UNIQUE_SHOW_COUNT;

  const showIdMap = new Map<string, number>();
  let showIdCounter = 0;

  for (const row of rows) {

    const slicedSeq = row.seq.slice(-seqLen);
    const slicedMask = row.seqMask.slice(-seqLen).map((v) => (v ? 1 : 0));

    while (slicedSeq.length < SEQ_LEN) {
      slicedSeq.unshift(new Array(FEAT_DIM).fill(0));
      slicedMask.unshift(0);
    }

    const lastValidIdx = slicedMask.lastIndexOf(1);
    let lastScoreBaseline: number[] | null = null;
    if (lastValidIdx !== -1) {
      const originalStep = slicedSeq[lastValidIdx]!;
      lastScoreBaseline = CAPTIONS.map((_, idx) => {
        const base = RECAP_OFFSET_IN_FEATS + idx * CAPTION_STRIDE;
        const normalizedScore = originalStep[base + 2] ?? 0;
        return normalizedScore * CAPTION_SCORE_SCALE;
      });

      const step = [...originalStep];
      for (let i = 0; i < CAPTION_COUNT; i++) {
        const base = RECAP_OFFSET_IN_FEATS + i * CAPTION_STRIDE;
        for (let j = 0; j < CAPTION_STRIDE; j++) {
          step[base + j] = 0;
        }
      }
      slicedSeq[lastValidIdx] = step;
    }

    const baselineRawVector = row.globalBaseline;
    const baselineNormVector: number[] = [];

    const baselineInputRaw = lastScoreBaseline ? [...lastScoreBaseline] : [...baselineRawVector];
    if (lastScoreBaseline) {
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        if (baselineInputRaw[idx] === 0) {
          baselineInputRaw[idx] = baselineRawVector[idx] ?? stats.recapMean[idx] ?? 0;
        }
      }
    }

    if (baselineDropoutRate > 0 && rng() < baselineDropoutRate) {
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        baselineInputRaw[idx] = stats.recapMean[idx] ?? 0;
      }
    }
    if (baselineNoiseStd > 0) {
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        baselineInputRaw[idx] += gaussianRandom(rng) * baselineNoiseStd;
      }
    }

    const deltaTargets: number[] = [];
    const recapValues: number[] = [];

    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      const baselineInput = baselineInputRaw[idx] ?? 0;
      const baselineNorm = normalizeValue(baselineInput, stats.recapMean[idx]!, stats.recapStd[idx]!);
      baselineNormVector.push(baselineNorm);

      const rawRecap = row.recap[idx] ?? 0;
      const deltaRaw = rawRecap - baselineInput;


      const normalizedDelta = normalizeValue(deltaRaw, stats.deltaMean[idx]!, stats.deltaStd[idx]!);
      deltaTargets.push(normalizedDelta);

      const normalizedRecap = normalizeValue(rawRecap, stats.recapMean[idx]!, stats.recapStd[idx]!);
      recapValues.push(normalizedRecap);
    }


    const geRaw = (row.recap[0] ?? 0) + (row.recap[1] ?? 0);
    const visualRaw = ((row.recap[2] ?? 0) + (row.recap[3] ?? 0) + (row.recap[4] ?? 0)) / 2;
    const musicRaw = ((row.recap[5] ?? 0) + (row.recap[6] ?? 0) + (row.recap[7] ?? 0)) / 2;

    const categoryTargets = [
      normalizeValue(geRaw, stats.categoryMean[0]!, stats.categoryStd[0]!),
      normalizeValue(visualRaw, stats.categoryMean[1]!, stats.categoryStd[1]!),
      normalizeValue(musicRaw, stats.categoryMean[2]!, stats.categoryStd[2]!)
    ];

    const normalizedTotal = normalizeValue(row.total, stats.totalMean, stats.totalStd || 1);

    const validSteps = slicedSeq.filter((_, i) => slicedMask[i] === 1);
    const historyLen = Math.max(0, validSteps.length - 1);

    const trendFeatures = row.trendSlopes;

    if (row.corpsId < 0 || row.corpsId >= CORPS_COUNT) {
      throw new Error(`corps_id out of range: ${row.corpsId}`);
    }
    if ((epoch === 0 || epoch % 50 === 0) && rng() < 1 / 64 && validSteps.length > 0) {
      const lastStep = validSteps[validSteps.length - 1]!;
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        const base = RECAP_OFFSET_IN_FEATS + idx * CAPTION_STRIDE;
        for (let j = 0; j < CAPTION_STRIDE; j++) {
          const value = lastStep[base + j] ?? 0;
          if (value !== 0) {
            console.error(`TREND ASSERTION FAILED: Last valid step has non-zero caption feature at caption ${idx}, offset ${j}: ${value}`);
          }
        }
      }
    }


    const corpsId = rng() < identityDropoutRate ? UNK_CORPS_ID : row.corpsId;
    const showId = (() => {
      const existing = showIdMap.get(row.showKey);
      if (existing !== undefined) return existing;
      const next = showIdCounter++;
      showIdMap.set(row.showKey, next);
      return next;
    })();

    const agnosticShowId = rng() < 0.2 ? 0 : row.agnosticShowId; // 20% dropout for show embedding

    samples.push({
      xs: [
        slicedSeq,
        [...row.stat, ...trendFeatures, ...row.contextFeatures],
        slicedMask,
        row.judgeIndices,
        corpsId,
        baselineNormVector,
        historyLen,
        showId,
        agnosticShowId
      ],
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
      history_len: tf.tensor([sample.xs[6]], [1], "float32"),
      show_id: tf.tensor([sample.xs[7]], [1], "int32"),
      agnostic_show_id: tf.tensor([sample.xs[8]], [1], "int32"),
    },

    ys: tf.tensor(sample.ys, undefined, "float32"),
  }));

  if (shuffle) {
    dataset = dataset.shuffle(Math.min(samples.length, 1000), seed.toString(), true);
  }

  return dataset.batch(batchSize).prefetch(2);
}

let sequenceBuffer: Float32Array | null = null;
let staticBuffer: Float32Array | null = null;
let maskBuffer: Float32Array | null = null;
let judgeIdsBuffer: Int32Array | null = null;
let corpsIdBuffer: Int32Array | null = null;
let baselineBuffer: Float32Array | null = null;
let historyLenBuffer: Float32Array | null = null;
let showIdBuffer: Int32Array | null = null;
let ysBuffer: Float32Array | null = null;
let currentBufferSize = 0;


function buildBatchTensors(batchSamples: Sample[], scales: { judgeBias: number, corps: number }): { xs: BatchedInputs; ys: tf.Tensor } {
  const batchSize = batchSamples.length;

  if (batchSize > currentBufferSize) {
    sequenceBuffer = new Float32Array(batchSize * SEQ_LEN * FEAT_DIM);
    staticBuffer = new Float32Array(batchSize * TOTAL_STATIC_DIM);
    maskBuffer = new Float32Array(batchSize * SEQ_LEN);
    judgeIdsBuffer = new Int32Array(batchSize * CAPTION_COUNT);
    corpsIdBuffer = new Int32Array(batchSize);
    baselineBuffer = new Float32Array(batchSize * CAPTION_COUNT);
    historyLenBuffer = new Float32Array(batchSize * 1);
    showIdBuffer = new Int32Array(batchSize);
    ysBuffer = new Float32Array(batchSize * TARGET_DIM);
    currentBufferSize = batchSize;
  }

  const sequenceData = sequenceBuffer!.subarray(0, batchSize * SEQ_LEN * FEAT_DIM);
  const staticData = staticBuffer!.subarray(0, batchSize * TOTAL_STATIC_DIM);
  const maskData = maskBuffer!.subarray(0, batchSize * SEQ_LEN);
  const judgeIdsData = judgeIdsBuffer!.subarray(0, batchSize * CAPTION_COUNT);
  const corpsIdData = corpsIdBuffer!.subarray(0, batchSize);
  const baselineData = baselineBuffer!.subarray(0, batchSize * CAPTION_COUNT);
  const historyLenData = historyLenBuffer!.subarray(0, batchSize * 1);
  const showIdData = showIdBuffer!.subarray(0, batchSize);
  const agnosticShowIdData = new Int32Array(batchSize); // Use a new buffer for simplicity or add to pre-allocation
  const ysData = ysBuffer!.subarray(0, batchSize * TARGET_DIM);


  for (let i = 0; i < batchSize; i++) {
    const sample = batchSamples[i]!;

    if (sample.xs[1].length !== TOTAL_STATIC_DIM) throw new Error(`Invalid static feature dim at index ${i}: got ${sample.xs[1].length}, expected ${TOTAL_STATIC_DIM}`);
    if (sample.xs[3].length !== CAPTION_COUNT) throw new Error(`Invalid judge_ids length at index ${i}`);
    if (sample.xs[5].length !== CAPTION_COUNT) throw new Error(`Invalid baseline_recap length at index ${i}`);

    const seq = sample.xs[0];
    for (let s = 0; s < SEQ_LEN; s++) {
      const step = seq[s]!;
      const offset = (i * SEQ_LEN + s) * FEAT_DIM;
      for (let f = 0; f < FEAT_DIM; f++) {
        sequenceData[offset + f] = step[f] ?? 0;
      }
    }

    staticData.set(sample.xs[1], i * TOTAL_STATIC_DIM);
    maskData.set(sample.xs[2], i * SEQ_LEN);

    const judgeIds = sample.xs[3];
    for (let j = 0; j < CAPTION_COUNT; j++) {
      const id = judgeIds[j]!;
      if (id < 0 || id >= JUDGE_COUNT) {
        throw new Error(`Judge ID ${id} out of range (max valid index ${JUDGE_COUNT - 1})`);
      }
      judgeIdsData[i * CAPTION_COUNT + j] = id;
    }

    const rawCorpsId = sample.xs[4];
    if (rawCorpsId < 0 || rawCorpsId >= CORPS_COUNT) throw new Error(`Corps ID ${rawCorpsId} out of range (max ${CORPS_COUNT - 1})`);
    corpsIdData[i] = Math.max(0, Math.min(rawCorpsId, CORPS_COUNT - 1));

    baselineData.set(sample.xs[5], i * CAPTION_COUNT);
    historyLenData[i] = sample.xs[6];
    showIdData[i] = sample.xs[7];
    agnosticShowIdData[i] = sample.xs[8];
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
      history_len: tf.tensor2d(historyLenData, [batchSize, 1], "float32"),
      show_id: tf.tensor2d(showIdData, [batchSize, 1], "int32"),
      agnostic_show_id: tf.tensor2d(agnosticShowIdData, [batchSize, 1], "int32"),
      judge_bias_scale: tf.fill([batchSize, 1], scales.judgeBias),
      corps_scale: tf.fill([batchSize, 1], scales.corps),
    },

    ys: tf.tensor2d(ysData, [batchSize, TARGET_DIM], "float32"),
  };
}

function* batchGenerator(samples: Sample[], batchSize: number, shuffle: boolean, seed: number, scales: { judgeBias: number, corps: number }): Generator<{ xs: BatchedInputs; ys: tf.Tensor; samples: Sample[] }> {
  const rng = seededRandom(seed);
  const showMap = new Map<number, Sample[]>();
  for (const sample of samples) {
    const showId = sample.xs[7];
    const bucket = showMap.get(showId) ?? [];
    bucket.push(sample);
    showMap.set(showId, bucket);
  }

  const showGroups = Array.from(showMap.values());
  const orderedShows = shuffle ? shuffleArray(showGroups, rng) : showGroups;
  let batch: Sample[] = [];

  for (const showSamples of orderedShows) {
    if (batch.length && batch.length + showSamples.length > batchSize) {
      yield { ...buildBatchTensors(batch, scales), samples: batch };
      batch = [];
    }

    if (showSamples.length > batchSize && batch.length === 0) {
      yield { ...buildBatchTensors(showSamples, scales), samples: showSamples };
      continue;
    }

    batch.push(...showSamples);
  }

  if (batch.length) {
    yield { ...buildBatchTensors(batch, scales), samples: batch };
  }
}


function createLoss(stats: TargetStats, widthFloorPts: number, rankingWeight: number) {

  const recapMeanTensor = tf.tensor1d(stats.recapMean, "float32");
  const recapStdTensor = tf.tensor1d(stats.recapStd.map((value) => (value > 1e-6 ? value : 1)), "float32");
  const deltaMeanTensor = tf.tensor1d(stats.deltaMean, "float32");
  const deltaStdTensor = tf.tensor1d(stats.deltaStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const categoryMeanTensor = tf.tensor1d(stats.categoryMean, "float32");
  const categoryStdTensor = tf.tensor1d(stats.categoryStd.map((v) => (v > 1e-6 ? v : 1)), "float32");

  const deltaWeightTensor = tf.pow(tf.tensor1d(stats.deltaWeights, "float32"), tf.scalar(0.5));
  const recapWeightTensor = tf.tensor1d(stats.recapWeights, "float32");
  const totalMeanTensor = tf.scalar(stats.totalMean);
  const totalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

  const lossFn = (yTrue: tf.Tensor, yPred: tf.Tensor, weights: { totalWeight: number, recapWeight: number, deltaWeight: number, categoryWeight: number, quantileWeight: number, consistencyWeight: number }, historyLen: tf.Tensor, showIds: tf.Tensor, scheduledWidthFloorWeight: number, returnComponents = false, regLoss?: tf.Tensor) =>

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

      const rankingLoss = (() => {
        const totalTrueFlat = totalTrue.reshape([-1]);
        const totalPredFlat = totalPred.reshape([-1]);
        const showIdsFlat = showIds.reshape([-1]).toInt();

        const diffTrue = tf.sub(totalTrueFlat.expandDims(1), totalTrueFlat.expandDims(0));
        const diffPred = tf.sub(totalPredFlat.expandDims(1), totalPredFlat.expandDims(0));

        const idRow = showIds.reshape([-1, 1]);
        const idCol = showIds.reshape([1, -1]);
        const sameShow = tf.equal(idRow, idCol);

        const idx = tf.range(0, totalTrueFlat.shape[0] ?? 0, 1, "int32");
        const row = idx.expandDims(1);
        const col = idx.expandDims(0);
        const lowerTri = tf.greater(row, col);

        const pairMask = tf.logicalAnd(sameShow, lowerTri);
        const maskFloat = tf.cast(pairMask, "float32");

        const zeroMask = tf.equal(diffTrue, 0);
        const gtMask = tf.greater(diffTrue, 0);
        const target = tf.add(
          tf.cast(gtMask, "float32"),
          tf.mul(tf.cast(zeroMask, "float32"), tf.scalar(0.5))
        );

        const predProb = tf.clipByValue(tf.sigmoid(diffPred), 1e-7, 1 - 1e-7);
        const lossMatrix = tf.neg(
          tf.add(
            tf.mul(target, tf.log(predProb)),
            tf.mul(tf.sub(tf.scalar(1), target), tf.log(tf.sub(tf.scalar(1), predProb)))
          )
        );

        const maskedLoss = tf.mul(lossMatrix, maskFloat);
        const denom = tf.maximum(tf.sum(maskFloat), tf.scalar(1));
        return tf.div(tf.sum(maskedLoss), denom);
      })();

      const q10Denorm = tf.add(tf.mul(deltaPredQ10, deltaStdTensor), deltaMeanTensor);

      const q90Denorm = tf.add(tf.mul(deltaPredQ90, deltaStdTensor), deltaMeanTensor);
      const widthPts = tf.sub(q90Denorm, q10Denorm);

      const hPlus1 = tf.add(historyLen, 1.0);
      const widthFactor = tf.add(1.0, tf.div(0.5, tf.sqrt(hPlus1)));

      // V9 SQUEEZE: Reduced from 1.64 (90%) to 1.28 (80%) to force tighter windows
      const baseWidth = tf.mul(deltaStdTensor, 1.28);
      const targetWidth = tf.mul(baseWidth, widthFactor);

      const widthPriorError = tf.sub(widthPts, targetWidth);
      const widthPriorLoss = tf.mean(tf.square(widthPriorError));

      const sigmaFloor = tf.mul(deltaStdTensor, 0.2);
      const widthFloor = tf.maximum(tf.scalar(widthFloorPts), sigmaFloor);
      const widthShortfall = tf.relu(tf.sub(widthFloor, widthPts));
      const widthPenalty = tf.mean(tf.square(widthShortfall));

      const total = tf.addN([
        deltaLoss,
        recapLoss,
        categoryLoss,
        totalLoss,
        tf.mul(tf.scalar(rankingWeight), rankingLoss),
        tf.mul(tf.scalar(scheduledWidthFloorWeight * (weights.quantileWeight > 0 ? 1 : 0)), widthPenalty),
        tf.mul(tf.scalar(weights.quantileWeight), widthPriorLoss),

        // Soft Coverage Loss
        // V9 CHANGE: Weight 0.1 -> 0.2
        tf.mul(tf.scalar(weights.quantileWeight * 0.2), (() => {
          const trueDenorm = tf.add(tf.mul(deltaTrue, deltaStdTensor), deltaMeanTensor);
          const sharpness = tf.scalar(2.0);

          const left = tf.sigmoid(tf.mul(tf.sub(trueDenorm, q10Denorm), sharpness));

          const right = tf.sigmoid(tf.mul(tf.sub(q90Denorm, trueDenorm), sharpness));

          const softHit = tf.mul(left, right);
          const softCoverage = tf.mean(softHit);

          // Target is 0.8
          return tf.relu(tf.sub(tf.scalar(0.8), softCoverage));
        })()),
        regLoss ?? tf.scalar(0)
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
  }

  const client = createClient({ url: `file:${DB_PATH}` });
  console.log("Loading V9 sequence data...");


  const result = await client.execute(`
    SELECT season, competition_slug, competition_date, corps_key, corps_id, x_sequence_json, x_static_json, judge_indices_json, y_residuals_json, y_recap_json, division_name, split
    FROM ml_sequence_rows_v9_subcaption

  `);

  const rawRows = result.rows as unknown as Array<{
    season: string;
    competition_slug: string;
    competition_date: string;
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
    throw new Error("Missing train data for V10 model.");
  }

  const stats = computeTargetStats(trainSubset);
  fs.writeFileSync(NORM_PATH, JSON.stringify(stats, null, 2));
  console.log(`Saved normalization stats to ${NORM_PATH}`);

  const initialTrainSamples = buildSamples(trainSubset, stats, SEQ_LEN, 1.0, args.seed, 0, 0, 0);
  const initialValSamples = buildSamples(valSubset, stats, SEQ_LEN, 1.0, args.seed + 1, 0, 0, 0);


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


  const baselines = initialValSamples.length ? computeBaselineMae(initialValSamples, stats) : { baselineZero: 0, baselineMean: 0, baselineEma: 0, baselineQuad: 0 };

  const testStep = initialTrainSamples[0]?.xs[0][0];
  if (testStep && testStep.length !== FEAT_DIM) {
    throw new Error(`Feature dimension mismatch: expected ${FEAT_DIM}, got ${testStep.length} `);
  }

  console.log(`V10 Splits -> Train: ${trainRows.length}, Val: ${valRows.length}, Test: ${testRows.length} `);
  if (args.maxRows) {
    console.log(`Using maxRows = ${args.maxRows} for quick training.`);
  }
  if (initialValSamples.length) {
    console.log(
      `Baselines(monitoring forecast MAE): zero = ${baselines.baselineZero.toFixed(4)}, ` +
      `mean = ${baselines.baselineMean.toFixed(4)}, ema = ${baselines.baselineEma.toFixed(4)}, ` +
      `quad = ${baselines.baselineQuad.toFixed(4)}`
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

  class LambdaScale extends tf.layers.Layer {
    static className = "LambdaScale";
    constructor(config?: any) {
      super(config || {});
    }
    computeOutputShape(inputShape: tf.Shape | tf.Shape[]): tf.Shape | tf.Shape[] {
      const shapes = inputShape as tf.Shape[];
      return shapes[0];
    }
    call(inputs: tf.Tensor | tf.Tensor[]): tf.Tensor | tf.Tensor[] {
      return tf.tidy(() => {
        const [tensor, scale] = inputs as [tf.Tensor, tf.Tensor];
        return tf.mul(tensor, scale);
      });
    }
    getConfig() { return { ...super.getConfig() }; }
  }
  tf.serialization.registerClass(LambdaScale);


  const seqInput = tf.input({ shape: [SEQ_LEN, FEAT_DIM], name: "sequence" });
  const staticInput = tf.input({ shape: [TOTAL_STATIC_DIM], name: "static" });
  const judgeIdsInput = tf.input({ shape: [CAPTION_COUNT], dtype: "int32", name: "judge_ids" });
  const corpsIdInput = tf.input({ shape: [1], dtype: "int32", name: "corps_id" });
  const baselineInput = tf.input({ shape: [CAPTION_COUNT], name: "baseline_recap" });

  const judgeBiasScaleInput = tf.input({ shape: [1], name: "judge_bias_scale" });
  const corpsScaleInput = tf.input({ shape: [1], name: "corps_scale" });
  const historyLenInput = tf.input({ shape: [1], name: "history_len" });
  const agnosticShowInput = tf.input({ shape: [1], dtype: "int32", name: "agnostic_show_id" });

  const judgeEmbedding = tf.layers.embedding({
    inputDim: JUDGE_COUNT,
    outputDim: 24, // IMPROVED: 16->24 for better judge-specific learning
    embeddingsRegularizer: tf.regularizers.l2({ l2: 1e-3 }),
    name: "judge_embedding",
  }).apply(judgeIdsInput) as tf.SymbolicTensor;
  const judgeFlat = tf.layers.flatten().apply(judgeEmbedding) as tf.SymbolicTensor;

  const corpsEmbedding = tf.layers.embedding({
    inputDim: CORPS_COUNT,
    outputDim: 20, // IMPROVED: 16->20 for richer corps representations
    embeddingsRegularizer: tf.regularizers.l2({ l2: 1e-5 }),
    name: "corps_embedding",
  }).apply(corpsIdInput) as tf.SymbolicTensor;
  const corpsFlat = tf.layers.flatten().apply(corpsEmbedding) as tf.SymbolicTensor;

  const showEmbedding = tf.layers.embedding({
    inputDim: (globalThis as any).UNIQUE_SHOW_COUNT || 1000,
    outputDim: 12, // IMPROVED: 8->12 for better show-type patterns
    embeddingsRegularizer: tf.regularizers.l2({ l2: 1e-4 }),
    name: "agnostic_show_embedding",
  }).apply(agnosticShowInput) as tf.SymbolicTensor;
  const showFlat = tf.layers.flatten().apply(showEmbedding) as tf.SymbolicTensor;

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
  const contextFlat = new AttentionPoolingLayer({ name: "attention_pool" }).apply([attentionWeights, attentionInput]) as tf.SymbolicTensor;

  const lastStepFlat = new LastStepLayer({ name: "last_step" }).apply(seqInput) as tf.SymbolicTensor;

  const concat = tf.layers.concatenate().apply([contextFlat, staticInput, judgeFlat, baselineInput, lastStepFlat, showFlat]) as tf.SymbolicTensor;


  const d1 = tf.layers
    .dense({
      units: 512, // FIXED: 256→512 for more capacity
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
    })
    .apply(concat) as tf.SymbolicTensor;

  const d1Drop = tf.layers.dropout({ rate: args.dropoutDense1 }).apply(d1) as tf.SymbolicTensor;

  const d2 = tf.layers
    .dense({
      units: 256, // FIXED: 128→256 for more capacity
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
    })
    .apply(d1Drop) as tf.SymbolicTensor;

  const d2Drop = tf.layers.dropout({ rate: args.dropoutDense2 }).apply(d2) as tf.SymbolicTensor;

  const strength = tf.layers.dense({ units: 24, activation: "relu", name: "strength" }).apply(contextFlat) as tf.SymbolicTensor; // IMPROVED: 16->24

  const skipConcat = tf.layers.concatenate().apply([d2Drop, staticInput, strength]) as tf.SymbolicTensor;

  // FIXED: Dedicated accuracy trunk with separate gradients from width/uncertainty
  const accuracyTrunk = tf.layers.dense({
    units: 128,
    activation: "relu",
    name: "accuracy_trunk",
    kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg })
  }).apply(skipConcat) as tf.SymbolicTensor;
  const accuracyDrop = tf.layers.dropout({ rate: 0.2 }).apply(accuracyTrunk) as tf.SymbolicTensor;

  const judgeBiasRaw = tf.layers.dense({ units: CAPTION_COUNT, name: "judge_bias_raw", kernelRegularizer: tf.regularizers.l2({ l2: 1e-4 }) }).apply(judgeFlat) as tf.SymbolicTensor;
  const judgeBias = new LambdaScale({ name: "judge_bias_gated" }).apply([judgeBiasRaw, judgeBiasScaleInput]) as tf.SymbolicTensor;

  const deltaQ50Base = tf.layers.dense({
    units: CAPTION_COUNT,
    name: "delta_q50_base",
    kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg })
  }).apply(accuracyDrop) as tf.SymbolicTensor; // FIXED: Uses accuracyTrunk instead of skipConcat

  const corpsCorrRaw = tf.layers.dense({
    units: CAPTION_COUNT,
    name: "corps_corr_raw",
    kernelRegularizer: tf.regularizers.l2({ l2: 1e-4 })
  }).apply(corpsFlat) as tf.SymbolicTensor;
  const corpsCorr = new LambdaScale({ name: "corps_corr_gated" }).apply([corpsCorrRaw, corpsScaleInput]) as tf.SymbolicTensor;

  const deltaQ50 = tf.layers.add({ name: "delta_q50" }).apply([deltaQ50Base, judgeBias, corpsCorr]) as tf.SymbolicTensor;

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
  const widthConcat = tf.layers.concatenate({ name: "width_concat" }).apply([skipConcat, judgeFlat, historyLenInput]) as tf.SymbolicTensor;
  const q10WidthRaw = q10WidthLayer.apply(widthConcat) as tf.SymbolicTensor;
  const q90WidthRaw = q90WidthLayer.apply(widthConcat) as tf.SymbolicTensor;

  const q10Width = tf.layers.activation({ activation: "softplus", name: "q10_width" }).apply(q10WidthRaw) as tf.SymbolicTensor;
  const q90Width = tf.layers.activation({ activation: "softplus", name: "q90_width" }).apply(q90WidthRaw) as tf.SymbolicTensor;

  const q10WidthNeg = new NegationLayer({ name: "q10_width_neg" }).apply(q10Width) as tf.SymbolicTensor;

  const q10Delta = tf.layers.add({ name: "q10_delta" }).apply([deltaQ50, q10WidthNeg]) as tf.SymbolicTensor;
  const q90Delta = tf.layers.add({ name: "q90_delta" }).apply([deltaQ50, q90Width]) as tf.SymbolicTensor;

  const recapHead = new RecapLayer({ name: "recap_head", stats }).apply([deltaQ50, baselineInput]) as tf.SymbolicTensor;

  const categoryHead = new CategoryLayer({ name: "category_head", stats }).apply(recapHead) as tf.SymbolicTensor;

  const totalHead = new TotalLayer({ name: "total_head", stats }).apply(categoryHead) as tf.SymbolicTensor;

  const output = tf.layers
    .concatenate({ name: "output" })
    .apply([q10Delta, deltaQ50, q90Delta, recapHead, categoryHead, totalHead]) as tf.SymbolicTensor;

  const model = tf.model({ inputs: [seqInput, staticInput, maskInput, judgeIdsInput, corpsIdInput, baselineInput, historyLenInput, judgeBiasScaleInput, corpsScaleInput, agnosticShowInput], outputs: output });

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
        console.warn(`Could not find model.json or weights.bin in ${args.loadModel} `);
      }
    } else {
      console.warn(`Load model path does not exist: ${args.loadModel} `);
    }
  }

  const optimizer = tf.train.adam(args.learningRate);
  model.summary();

  console.log("\n--- DERIVATION EXACTNESS CHECK ---");
  tf.tidy(() => {
    const testBaselineRecap = tf.zeros([1, CAPTION_COUNT]);
    const dummySeq = tf.zeros([1, SEQ_LEN, FEAT_DIM]);
    const dummyStatic = tf.zeros([1, TOTAL_STATIC_DIM]);
    const dummyMask = tf.ones([1, SEQ_LEN]);
    const dummyJudgeIds = tf.zeros([1, CAPTION_COUNT], "int32");
    const dummyCorpsId = tf.zeros([1, 1], "int32");
    const dummyScale = tf.ones([1, 1]);

    const testOutputs = model.predict([
      dummySeq,
      dummyStatic,
      dummyMask,
      dummyJudgeIds,
      dummyCorpsId,
      testBaselineRecap,
      dummyScale,
      dummyScale,
      dummyScale,
      tf.zeros([1, 1], "int32") // agnosticShowInput
    ]) as tf.Tensor[];

    const outputTensor = (testOutputs as unknown) as tf.Tensor;
    if (!outputTensor || outputTensor.shape[1] !== 36) {
      throw new Error(`DERIVATION CHECK FAILED: Unexpected output shape ${outputTensor?.shape} `);
    }

    const derivedRecapNorm = outputTensor.slice([0, 24], [-1, 8]);
    const derivedCatNorm = outputTensor.slice([0, 32], [-1, 3]);
    const derivedTotalNorm = outputTensor.slice([0, 35], [-1, 1]);

    const recapDataNorm = Array.from(derivedRecapNorm.dataSync());
    const catDataNorm = Array.from(derivedCatNorm.dataSync());
    const totDataNorm = Array.from(derivedTotalNorm.dataSync());

    const recapPts = recapDataNorm.map((v, i) => v * stats.recapStd[i]! + stats.recapMean[i]!);
    const catPts = catDataNorm.map((v, i) => v * stats.categoryStd[i]! + stats.categoryMean[i]!);
    const totPts = totDataNorm[0]! * stats.totalStd + stats.totalMean;

    const expectedGE = recapPts[0]! + recapPts[1]!;
    const expectedVisual = (recapPts[2]! + recapPts[3]! + recapPts[4]!) / 2;
    const expectedMusic = (recapPts[5]! + recapPts[6]! + recapPts[7]!) / 2;
    const expectedTotal = expectedGE + expectedVisual + expectedMusic;

    console.log("Recap Points:", recapPts.map(v => v.toFixed(2)));
    console.log(`GE: Derived = ${catPts[0]?.toFixed(2)}, Expected = ${expectedGE.toFixed(2)} `);
    console.log(`Visual: Derived = ${catPts[1]?.toFixed(2)}, Expected = ${expectedVisual.toFixed(2)} `);
    console.log(`Music: Derived = ${catPts[2]?.toFixed(2)}, Expected = ${expectedMusic.toFixed(2)} `);
    console.log(`Total: Derived = ${totPts.toFixed(2)}, Expected = ${expectedTotal.toFixed(2)} `);

    if (Math.abs(catPts[0]! - expectedGE) > 0.05 ||
      Math.abs(catPts[1]! - expectedVisual) > 0.05 ||
      Math.abs(catPts[2]! - expectedMusic) > 0.05 ||
      Math.abs(totPts - expectedTotal) > 0.05) {
      throw new Error("DERIVATION CHECK FAILED: Architecture consistency mismatch!");
    }
  });
  console.log("DERIVATION CHECK SUCCESS\n");

  console.log("--- SCALE SANITY TEST ---");
  const sampleRow = trainRows[0];
  if (sampleRow) {
    const sum8 = sampleRow.recap.reduce((a, b) => a + b, 0);
    console.log(`Sample Row Total: ${sampleRow.total.toFixed(2)} (expecting DCI scale, not sum - of - 8)`);
    console.log(`Sum - of - 8: ${sum8.toFixed(2)} `);
    if (Math.abs(sampleRow.total - sum8) < 0.1 && sampleRow.recap.some(r => r > 0)) {
      console.warn("WARNING: total score is still sum-of-8! Fix logic in buildDataRows.");
    } else {
      console.log("SCALE SANITY SUCCESS: target total is on DCI scale.\n");
    }
  }

  console.log("\n=== V9-IMPROVED: Enhanced Model for 0.2 MAE Target ===");
  console.log(
    `Hyperparameters: lstm1=${args.lstm1Units}, lstm2=${args.lstm2Units}, dropout=${args.dropoutLstm}, ` +
    `lr=${args.learningRate}, batch=${args.batchSize}, width_floor_pts=${args.widthFloorPts}, ` +
    `width_floor_schedule=${args.widthFloorStart}->${args.widthFloorEnd}, baseline_dropout=${args.baselineDropout}, ` +
    `baseline_noise_std=${args.baselineNoiseStd}`
  );
  console.log(`Model Capacity: ${args.lstm1Units * 2}→${args.lstm2Units * 2} BiLSTM, Dense 256→128, Judge Emb 24, Corps Emb 20, Show Emb 12`);


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
  let currentLR = args.learningRate;
  let epochsSinceImprovement = 0;

  const scheduler = new V9LossScheduler();
  const provider = new SequenceDataProviderV9(trainSubset, 0, args.batchSize);


  const cachedValSamples = buildSamples(valSubset, stats, 15, 0.0, args.seed + 999, 0, 0, 0);

  console.log(`Cached ${cachedValSamples.length} validation samples(seqLen = 15, identityDropout = 0.0)`);

  const guardrailCheck = (samples: Sample[], rate: number) => {
    const droppedCount = samples.filter(s => s.xs[4] === UNK_CORPS_ID).length;
    const total = samples.length;
    const actualRate = droppedCount / total;
    if (rate > 0.01 && actualRate === 0) console.warn("Guardrail: identityDropoutRate > 0 but no corps dropped!");
    return actualRate;
  };

  const valDeltaMeanTensor = tf.tensor1d(stats.deltaMean, "float32");
  const valDeltaStdTensor = tf.tensor1d(stats.deltaStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const valRecapMeanTensor = tf.tensor1d(stats.recapMean, "float32");
  const valRecapStdTensor = tf.tensor1d(stats.recapStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const valCategoryStdTensor = tf.tensor1d(stats.categoryStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
  const valTotalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);


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

    const dropRate = guardrailCheck(epochSamples, weights.identityDropoutRate);

    const currentWidthFloorWeight = scheduler.getWidthFloorWeight(epoch, args.widthFloorStart, args.widthFloorEnd);
    console.log(`\nEpoch ${epoch}: Weights ${JSON.stringify(weights)}, Scales ${JSON.stringify(scales)}, SeqLen ${seqLen}, ID_Drop ${dropRate.toFixed(3)}, WFW ${currentWidthFloorWeight.toFixed(3)} `);

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
            xs.judge_ids,
            xs.corps_id,
            xs.baseline_recap,
            xs.history_len,
            xs.judge_bias_scale,
            xs.corps_scale,
            xs.agnostic_show_id
          ]) as tf.Tensor;
          const regLosses: tf.Tensor[] = [];
          for (const layer of model.layers) {
            if (layer.losses && layer.losses.length) {
              regLosses.push(...(layer.losses as unknown as tf.Tensor[]));
            }
          }
          const tensorLosses = regLosses.filter((loss) => loss instanceof tf.Tensor);
          const regLoss = tensorLosses.length > 0 ? tf.addN(tensorLosses) : tf.scalar(0);
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
      gradList.forEach((grad: tf.Tensor) => grad.dispose());
      clipped.forEach((grad) => grad.dispose());
      Object.values(xs).forEach((t) => t.dispose());
      ys.dispose();
    }

    let monitoringStats = {
      valScore: 0,
      valDeltaMae: 0,
      valRecapMae: 0,
      valCategoryMae: 0,
      valTotalMae: 0,
      valInertiaMae: 0,
      valQuadMae: 0,
      vsInertia: 0,
      vsQuadratic: 0,
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
      let valLossSum = 0;
      let valMaeSum = 0;
      let valDeltaMaeSum = 0;
      let valRecapMaeSum = 0;
      let valCategoryMaeSum = 0;
      let valTotalMaeSum = 0;
      let valInertiaMaeSum = 0;
      let valQuadMaeSum = 0;

      let coverageCount = 0;
      let coverageWithin = 0;
      let intervalWidthSum = 0;
      let widthNormSum = 0;
      let widthFloorCount = 0;
      let valCountTotal = 0;

      const historyBuckets = {
        counts: [0, 0, 0, 0, 0],
        maeSum: [0, 0, 0, 0, 0],
        baselineDevSum: [0, 0, 0, 0, 0],
        baselineErrorSum: [0, 0, 0, 0, 0]
      };

      for (const batch of batchGenerator(cachedValSamples, args.batchSize, false, args.seed, scales)) {
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
          xs.history_len,
          xs.judge_bias_scale,
          xs.corps_scale,
          xs.agnostic_show_id
        ]) as tf.Tensor;
        const scheduledWFW = scheduler.getWidthFloorWeight(epoch, args.widthFloorStart, args.widthFloorEnd);
        const lossTensor = lossFn(ys, preds, weights, xs.history_len, xs.show_id, scheduledWFW) as tf.Tensor;

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
        const predRecapDenorm = tf.add(tf.mul(predRecap, valRecapStdTensor), valRecapMeanTensor);
        const trueRecapDenorm = tf.add(tf.mul(trueRecap, valRecapStdTensor), valRecapMeanTensor);
        const baseRecapDenorm = tf.add(tf.mul(xs.baseline_recap, valRecapStdTensor), valRecapMeanTensor);
        const recapMaePointsTensor = tf.mean(tf.abs(tf.sub(predRecapDenorm, trueRecapDenorm)));
        const inertiaMaePointsTensor = tf.mean(tf.abs(tf.sub(trueRecapDenorm, baseRecapDenorm)));


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

        const metrics = tf.tidy(() => {
          const metricsStack = tf.stack([
            lossTensor.reshape([1]),
            maeTensor.reshape([1]),
            maePointsTensor.reshape([1]), // Delta MAE Pts
            recapMaePointsTensor.reshape([1]), // Recap MAE Pts
            categoryMaePointsTensor.reshape([1]),
            totalMaePointsTensor.reshape([1]),
            inertiaMaePointsTensor.reshape([1]),
            withinFloat.sum().reshape([1]),
            tf.mean(tf.sub(upper, lower)).reshape([1]),
            widthNormTensor.reshape([1]),
            tf.sum(tf.cast(widthFloorMask, "float32")).reshape([1])
          ]);
          return metricsStack.dataSync();
        });

        const lossValue = metrics[0]!;
        const maeValue = metrics[1]!;
        const deltaMaePts = metrics[2]!;
        const recapMaePts = metrics[3]!;
        const categoryMaePts = metrics[4]!;
        const totalMaePts = metrics[5]!;
        const inertiaMaePts = metrics[6]!;
        const withinCount = metrics[7]!;
        const intervalWidth = metrics[8]!;
        const widthNormValue = metrics[9]!;
        const widthFloorCountBatch = metrics[10]!;


        const batchBucketData = tf.tidy(() => {
          const historyLens = xs.history_len;
          const maePtsPerSample = tf.mean(tf.abs(tf.sub(predDenorm, trueDenorm)), 1);

          const baselineErrPerSample = tf.mean(tf.abs(tf.sub(trueRecapDenorm, baseRecapDenorm)), 1);

          const baseDevPerSample = tf.mean(tf.abs(tf.sub(predRecapDenorm, baseRecapDenorm)), 1);


          return {
            h: historyLens,
            mae: maePtsPerSample,
            baseErr: baselineErrPerSample,
            baseDev: baseDevPerSample
          };
        });

        const hData = batchBucketData.h.dataSync();
        const maeData = batchBucketData.mae.dataSync();
        const bErrData = batchBucketData.baseErr.dataSync();
        const bDevData = batchBucketData.baseDev.dataSync();
        batchBucketData.h.dispose();
        batchBucketData.mae.dispose();
        batchBucketData.baseErr.dispose();
        batchBucketData.baseDev.dispose();

        for (let i = 0; i < batchSize; i++) {
          const h = hData[i]!;
          let bucket = 4;
          if (h < 0.5) bucket = 0;
          else if (h < 1.5) bucket = 1;
          else if (h < 2.5) bucket = 2;
          else if (h < 5.5) bucket = 3;

          historyBuckets.counts[bucket]++;
          historyBuckets.maeSum[bucket] += maeData[i]!;
          historyBuckets.baselineErrorSum[bucket] += bErrData[i]!;
          historyBuckets.baselineDevSum[bucket] += bDevData[i]!;
        }

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
            captionCount[i] += batchSize;
          }
          capMaeTensor.dispose();
          capWidthTensor.dispose();
          capRecapTensor.dispose();
        }

        valLossSum += lossValue * batchSize;
        valMaeSum += maeValue * batchSize;
        valDeltaMaeSum += deltaMaePts * batchSize;
        valRecapMaeSum += recapMaePts * batchSize;
        valCategoryMaeSum += categoryMaePts * batchSize;
        valTotalMaeSum += totalMaePts * batchSize;
        valInertiaMaeSum += inertiaMaePts * batchSize;

        // Compute quadratic baseline MAE on CPU
        for (let sampleIdx = 0; sampleIdx < batchSize; sampleIdx++) {
          const sample = batch.samples[sampleIdx]!;
          const seq = sample.xs[0];
          const mask = sample.xs[2];
          const steps = mask.length
            ? seq.filter((_, idx) => mask[idx] === 1)
            : seq.filter((step) => step.some((value) => value !== 0));

          for (let capIdx = 0; capIdx < CAPTION_COUNT; capIdx++) {
            const truthRecapNorm = sample.ys[CAPTION_COUNT + capIdx] ?? 0;
            const actual = denormalize(truthRecapNorm, stats.recapMean[capIdx]!, stats.recapStd[capIdx]!);

            const historyFull = steps.map((step) => getRecapFromStep(step, capIdx));
            const history = historyFull.length > 0 ? historyFull.slice(0, -1) : [];
            const meanPred = stats.recapMean[capIdx] ?? 0;
            const quadPred = predictQuadratic(history, meanPred);

            valQuadMaeSum += Math.abs(actual - quadPred);
          }
        }

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
        predRecapDenorm.dispose();
        trueRecapDenorm.dispose();
        baseRecapDenorm.dispose();
        recapMaePointsTensor.dispose();
        inertiaMaePointsTensor.dispose();

        predTotal.dispose();
        trueTotal.dispose();
        totalMaePointsTensor.dispose();

        predCategory.dispose();
        trueCategory.dispose();
        categoryMaePointsTensor.dispose();

        preds.dispose();
        Object.values(xs).forEach((t) => t.dispose());
        ys.dispose();
      }


      const valDeltaMae = valCountTotal ? valDeltaMaeSum / valCountTotal : 0;
      const valRecapMae = valCountTotal ? valRecapMaeSum / valCountTotal : 0;
      const valCategoryMae = valCountTotal ? valCategoryMaeSum / valCountTotal : 0;
      const valTotalMae = valCountTotal ? valTotalMaeSum / valCountTotal : 0;
      const valInertiaMae = valCountTotal ? valInertiaMaeSum / valCountTotal : 0;
      const valQuadMae = (valCountTotal * CAPTION_COUNT) ? valQuadMaeSum / (valCountTotal * CAPTION_COUNT) : 0;
      const vsInertia = valInertiaMae - valRecapMae;
      const vsQuadratic = valQuadMae - valRecapMae;
      const coverage = coverageCount ? coverageWithin / coverageCount : 0;
      const widthNorm = valCountTotal ? widthNormSum / valCountTotal : 0;
      const widthFloorPct = (valCountTotal * CAPTION_COUNT) ? widthFloorCount / (valCountTotal * CAPTION_COUNT) : 0;


      console.log("\nHistory Bucket Diagnostics (Avg Abs Error per sample, normalized units):");
      const bLabels = ["0", "1", "2", "3-5", "6+"];
      console.log("Hist | Count | MAE_Pred | MAE_Base | PredDevFromBase");
      console.log("-----|-------|----------|----------|----------------");
      for (let i = 0; i < 5; i++) {
        const c = historyBuckets.counts[i];
        if (c > 0) {
          console.log(
            `${bLabels[i]!.padEnd(4)} | ${c.toString().padEnd(5)} | ` +
            `${(historyBuckets.maeSum[i]! / c).toFixed(4).padEnd(8)} | ` +
            `${(historyBuckets.baselineErrorSum[i]! / c).toFixed(4).padEnd(8)} | ` +
            `${(historyBuckets.baselineDevSum[i]! / c).toFixed(4)} `
          );
        }
      }
      console.log("");

      const covW = coverageWeight(epoch, 80, 20, SCORE_COVERAGE_WEIGHT);

      const underCoverage = Math.max(0, SCORE_COVERAGE_TARGET - coverage);
      const covPenalty = underCoverage * underCoverage;

      const widthExcess = Math.max(0, widthNorm - WIDTH_TARGET_PTS);
      const widthPenaltyScore = widthExcess * 0.5;

      let valScore: number;
      if (epoch < 40) {
        valScore = valDeltaMae + valTotalMae;
      } else {
        valScore = weights.deltaWeight * valDeltaMae +
          weights.recapWeight * valRecapMae +
          weights.totalWeight * valTotalMae +
          weights.categoryWeight * valCategoryMae +
          covW * covPenalty +
          widthPenaltyScore;
      }


      monitoringStats = {
        valScore,
        valDeltaMae,
        valRecapMae,
        valCategoryMae,
        valTotalMae,
        valInertiaMae,
        valQuadMae,
        vsInertia,
        vsQuadratic,
        coverage,
        widthNorm,
        widthFloorPct
      };

      if (epoch === 40 || epoch === 120) {
        console.log(`\n--- PHASE TRANSITION (Epoch ${epoch}): Resetting Best Score & Patience ---`);
        bestScore = Number.POSITIVE_INFINITY;
        patience = 0;
        epochsSinceImprovement = 0;
      }
    }

    if (args.swa && epoch >= swaStartEpoch && (epoch - swaStartEpoch) % swaInterval === 0) {
      const currentWeights = model.getWeights().map((t) => t.clone());
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
      const snapshotDir = path.join(MODEL_DIR, runId, `snapshot_${epoch + 1} `);
      await saveModel(model, snapshotDir);
      console.log(`Saved snapshot to ${snapshotDir} `);
    }

    const trainLoss = trainCount ? trainLossSum / trainCount : 0;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(
      `Epoch ${epoch}: loss = ${trainLoss.toFixed(6)} ` +
      `delta_mae_pts = ${monitoringStats.valDeltaMae.toFixed(4)} ` +
      `recap_mae_pts = ${monitoringStats.valRecapMae.toFixed(4)} ` +
      `cat_mae_pts = ${monitoringStats.valCategoryMae.toFixed(4)} ` +
      `total_mae_pts = ${monitoringStats.valTotalMae.toFixed(4)} ` +
      `vs_inertia_pts = ${monitoringStats.vsInertia.toFixed(4)} ` +
      `vs_quad_pts = ${monitoringStats.vsQuadratic.toFixed(4)} ` +
      `mon_cov = ${monitoringStats.coverage.toFixed(3)} ` +
      `mon_score = ${monitoringStats.valScore.toFixed(4)} ` +
      `time = ${elapsed} s`
    );

    if (weights.deltaWeight > 0 && (epoch % 50 === 0 || epoch === 0)) {
      console.log(`\n-- - CAPTION STATS(Epoch ${epoch})-- - `);
      for (let i = 0; i < CAPTION_COUNT; i++) {
        const capDeltaMae = captionCount[i] ? captionDeltaMaeSum[i]! / captionCount[i]! : 0;
        const capRecapMae = captionCount[i] ? captionRecapMaeSum[i]! / captionCount[i]! : 0;
        const capCov = captionCount[i] ? captionCoverageWithin[i]! / captionCount[i]! : 0;
        const capWidth = captionCount[i] ? captionWidthSum[i] / captionCount[i]! : 0;
        console.log(`${CAPTIONS[i]}: delta_pts = ${capDeltaMae.toFixed(4)}, recap_pts = ${capRecapMae.toFixed(4)}, cov = ${capCov.toFixed(3)}, width = ${capWidth.toFixed(4)} `);
      }
      console.log("----------------------------------\n");
    }

    const improved = monitoringStats.valScore < bestScore - 1e-4;

    if (improved || !initialValSamples.length) {
      bestScore = monitoringStats.valScore;
      patience = 0;
      epochsSinceImprovement = 0;
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
        console.log(`Saved BEST checkpoint @epoch ${epoch} score = ${bestScore.toFixed(4)} -> ${bestDir} `);
      }
    } else {
      patience += 1;
      epochsSinceImprovement += 1;

      if (epochsSinceImprovement >= args.reduceLrPatience && currentLR > args.minLr) {
        currentLR *= 0.5;
        const nextLR = Math.max(currentLR, args.minLr);
        setLearningRate(nextLR);
        currentLR = nextLR;
        console.log(`\n--- NO IMPROVEMENT FOR ${args.reduceLrPatience} EPOCHS: Reducing LR to ${currentLR.toFixed(6)} ---`);
        epochsSinceImprovement = 0;
      }

      if (patience >= args.patience) {
        console.log(`Early stopping at epoch ${epoch} `);
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

  valDeltaMeanTensor.dispose();
  valDeltaStdTensor.dispose();
  valRecapMeanTensor.dispose();
  valRecapStdTensor.dispose();
  valCategoryStdTensor.dispose();
  valTotalStdTensor.dispose();


  console.log(`Saving final production model to ${runDir}...`);
  await saveModel(model, runDir);
  fs.writeFileSync(path.join(runDir, "training-args.json"), JSON.stringify(args, null, 2));

  if (testRows.length > 0) {
    console.log("\n--- FINAL TEST EVALUATION ---");
    const testSamples = buildSamples(testRows, stats, SEQ_LEN, 0.0, 42, 0, 0, 0);

    let testDeltaMaeSum = 0;
    let testRecapMaeSum = 0;
    let testCategoryMaeSum = 0;
    let testTotalMaeSum = 0;
    let testCoverageWithin = 0;
    let testWidthSum = 0;
    let testWidthFloorCount = 0;
    let testCount = 0;

    const testDeltaMeanTensor = tf.tensor1d(stats.deltaMean, "float32");
    const testDeltaStdTensor = tf.tensor1d(stats.deltaStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
    const testRecapStdTensor = tf.tensor1d(stats.recapStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
    const testCategoryStdTensor = tf.tensor1d(stats.categoryStd.map((v) => (v > 1e-6 ? v : 1)), "float32");
    const testTotalStdTensor = tf.scalar(stats.totalStd > 1e-6 ? stats.totalStd : 1);

    const testScales = {
      judgeBias: args.noJudgeBias ? 0 : 1.0,
      corps: args.noCorpsResidual ? 0 : 1.0
    };
    for (const batch of batchGenerator(testSamples, args.batchSize, false, 42, testScales)) {
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
        xs.history_len,
        xs.judge_bias_scale,
        xs.corps_scale,
        xs.agnostic_show_id
      ]) as tf.Tensor;

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

      const metrics = tf.tidy(() => {
        const metricsStack = tf.stack([
          tf.mean(tf.abs(tf.sub(predDenorm, trueDenorm))).reshape([1]),
          tf.mean(tf.mul(testRecapStdTensor, tf.abs(tf.sub(predRecap, trueRecap)))).reshape([1]),
          tf.mean(tf.mul(testCategoryStdTensor, tf.abs(tf.sub(predCategory, trueCategory)))).reshape([1]),
          tf.mean(tf.mul(testTotalStdTensor, tf.abs(tf.sub(predTotal, trueTotal)))).reshape([1]),
          tf.cast(within, "float32").sum().reshape([1]),
          tf.mean(tf.sub(upper, lower)).reshape([1]),
          tf.sum(tf.cast(widthFloorMask, "float32")).reshape([1])
        ]);
        return metricsStack.dataSync();
      });

      const maePoints = metrics[0]!;
      const recapMae = metrics[1]!;
      const categoryMae = metrics[2]!;
      const totalMae = metrics[3]!;
      const withinCount = metrics[4]!;
      const intervalWidth = metrics[5]!;
      const widthFloorCountBatch = metrics[6]!;

      testDeltaMaeSum += maePoints * batchSize;
      testRecapMaeSum += recapMae * batchSize;
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

    const finalTestDeltaPts = testCount ? testDeltaMaeSum / testCount : 0;
    const finalTestRecapPts = testCount ? testRecapMaeSum / testCount : 0;
    const finalTestCategory = testCount ? testCategoryMaeSum / testCount : 0;
    const finalTestTotal = testCount ? testTotalMaeSum / testCount : 0;
    const finalTestCov = (testCount * CAPTION_COUNT) ? testCoverageWithin / (testCount * CAPTION_COUNT) : 0;
    const finalTestWidth = (testCount * CAPTION_COUNT) ? testWidthSum / (testCount * CAPTION_COUNT) : 0;
    const finalTestWidthFloorPct = (testCount * CAPTION_COUNT) ? testWidthFloorCount / (testCount * CAPTION_COUNT) : 0;

    console.log(`TEST RESULTS: delta_mae_pts = ${finalTestDeltaPts.toFixed(4)}, recap_mae_pts = ${finalTestRecapPts.toFixed(4)}, cat_mae_pts = ${finalTestCategory.toFixed(4)}, total_mae_pts = ${finalTestTotal.toFixed(4)}, coverage = ${finalTestCov.toFixed(3)}, width = ${finalTestWidth.toFixed(4)}, width_floor_pct = ${finalTestWidthFloorPct.toFixed(3)} `);

    const report = {
      metrics: {
        delta_mae_pts: finalTestDeltaPts,
        recap_mae_pts: finalTestRecapPts,
        category_mae_pts: finalTestCategory,
        total_mae_pts: finalTestTotal,
        coverage: finalTestCov,
        width: finalTestWidth,
        width_floor_pct: finalTestWidthFloorPct
      },
      config: args,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(path.join(runDir, args.outputReport), JSON.stringify(report, null, 2));
    if (args.outputReport !== "test-results.json") {
      fs.writeFileSync(path.join(runDir, "test-results.json"), JSON.stringify(report.metrics, null, 2));
    }
  }

  console.log("Production training complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
