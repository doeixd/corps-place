import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@libsql/client";
import * as tf from "@tensorflow/tfjs-node";

/**
 * Comprehensive Model Evaluation for V5
 *
 * Compares all model types:
 * - Baselines: zero, EMA, linear
 * - Classical ML: XGBoost, LightGBM, Ridge
 * - Deep Learning: LSTM V5
 *
 * Outputs:
 * - Detailed metrics by model, caption, stratum
 * - Statistical significance tests
 * - Comparison tables in markdown
 */

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const DB_PATH = "./dci-relational.db";
const RESULTS_DIR = "./results";

type Caption = (typeof CAPTIONS)[number];

interface Prediction {
  p10: number;
  p50: number;
  p90: number;
}

interface Metrics {
  count: number;
  mae: number;
  rmse: number;
  ql10: number;
  ql50: number;
  ql90: number;
  coverage_p10: number;
  coverage_p50: number;
  coverage_p90: number;
  coverage_p10_p90: number;
  intervalWidth: number;
  calibrationError: number;
  r2: number;
}

interface RankingMetrics {
  events: number;
  rank_mae: number;
  rank_correlation: number;
  top3_accuracy: number;
  top5_accuracy: number;
  finals_accuracy: number;
  pairwise_accuracy: number;
}

interface ModelResults {
  name: string;
  overall: Metrics;
  byCaption: Record<Caption, Metrics>;
  total: Metrics;
  ranking: RankingMetrics;
}


interface Row {
  x_sequence_json: string;
  x_static_json: string;
  y_residuals_json: string;
  season: string;
  corps_key: string;
  competition_slug: string;
  competition_date: string;
}


// Utility functions
function pinballLoss(q: number, actual: number, pred: number): number {
  const e = actual - pred;
  return Math.max(q * e, (q - 1) * e);
}

function emptyMetrics(): Metrics {
  return {
    count: 0,
    mae: NaN,
    rmse: NaN,
    ql10: NaN,
    ql50: NaN,
    ql90: NaN,
    coverage_p10: NaN,
    coverage_p50: NaN,
    coverage_p90: NaN,
    coverage_p10_p90: NaN,
    intervalWidth: NaN,
    calibrationError: NaN,
    r2: NaN,
  };
}

function emptyRankingMetrics(): RankingMetrics {
  return {
    events: 0,
    rank_mae: NaN,
    rank_correlation: NaN,
    top3_accuracy: NaN,
    top5_accuracy: NaN,
    finals_accuracy: NaN,
    pairwise_accuracy: NaN,
  };
}

function computeMetrics(actuals: number[], predictions: Prediction[]): Metrics {
  const n = actuals.length;
  if (n === 0) {
    return emptyMetrics();
  }


  let maeSum = 0;
  let mseSum = 0;
  let ql10Sum = 0;
  let ql50Sum = 0;
  let ql90Sum = 0;
  let belowP10 = 0;
  let belowP50 = 0;
  let belowP90 = 0;
  let withinInterval = 0;

  let intervalWidthSum = 0;
  let actualSum = 0;
  let actualSqSum = 0;
  let predSum = 0;

  for (let i = 0; i < n; i++) {
    const actual = actuals[i]!;
    const pred = predictions[i]!;

    maeSum += Math.abs(actual - pred.p50);
    mseSum += (actual - pred.p50) ** 2;
    ql10Sum += pinballLoss(0.1, actual, pred.p10);
    ql50Sum += pinballLoss(0.5, actual, pred.p50);
    ql90Sum += pinballLoss(0.9, actual, pred.p90);

    if (actual <= pred.p10) belowP10++;
    if (actual <= pred.p50) belowP50++;
    if (actual <= pred.p90) belowP90++;
    if (actual >= pred.p10 && actual <= pred.p90) withinInterval++;


    intervalWidthSum += pred.p90 - pred.p10;
    actualSum += actual;
    actualSqSum += actual * actual;
    predSum += pred.p50;
  }

  const mae = maeSum / n;
  const rmse = Math.sqrt(mseSum / n);
  const ql10 = ql10Sum / n;
  const ql50 = ql50Sum / n;
  const ql90 = ql90Sum / n;
  const coverage_p10 = belowP10 / n;
  const coverage_p50 = belowP50 / n;
  const coverage_p90 = belowP90 / n;
  const coverage_p10_p90 = withinInterval / n;
  const intervalWidth = intervalWidthSum / n;
  const calibrationError =
    (Math.abs(coverage_p10 - 0.1) + Math.abs(coverage_p50 - 0.5) + Math.abs(coverage_p90 - 0.9)) / 3;

  // R² calculation
  const actualMean = actualSum / n;
  const ssTot = actualSqSum - n * actualMean * actualMean;
  const ssRes = mseSum;
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return {
    count: n,
    mae,
    rmse,
    ql10,
    ql50,
    ql90,
    coverage_p10,
    coverage_p50,
    coverage_p90,
    coverage_p10_p90,
    intervalWidth,
    calibrationError,
    r2,
  };
}


function computeMetricsFromErrors(errors: number[]): Metrics {
  if (errors.length === 0) {
    return emptyMetrics();
  }

  let maeSum = 0;
  let mseSum = 0;
  for (const error of errors) {
    maeSum += Math.abs(error);
    mseSum += error * error;
  }

  const count = errors.length;
  const mae = maeSum / count;
  const rmse = Math.sqrt(mseSum / count);
  const ql50 = mae * 0.5;

  return {
    count,
    mae,
    rmse,
    ql10: NaN,
    ql50,
    ql90: NaN,
    coverage_p10: NaN,
    coverage_p50: NaN,
    coverage_p90: NaN,
    coverage_p10_p90: NaN,
    intervalWidth: NaN,
    calibrationError: NaN,
    r2: NaN,
  };
}

function loadErrorArray(filePath: string): number[] | null {
  if (!fs.existsSync(filePath)) {
    console.warn(`Error file not found: ${filePath}`);
    return null;
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    absErrors?: number[];
    errors?: number[];
  };
  const errors = payload.absErrors ?? payload.errors ?? [];
  if (errors.length === 0) {
    console.warn(`No errors found in ${filePath}`);
    return null;
  }

  return errors;
}

function loadAbsErrorArray(filePath: string): number[] | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    absErrors?: number[];
    errors?: number[];
  };
  const absErrors = payload.absErrors ?? payload.errors?.map((value) => Math.abs(value)) ?? [];
  if (absErrors.length === 0) return null;
  return absErrors;
}

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - prob : prob;
}

type SignificanceRow = {
  model: string;
  baseline: string;
  meanDiff: number;
  pValue: number;
  ciLower: number;
  ciUpper: number;
  n: number;
};

function bootstrapCi(diffs: number[], nSamples: number): { lower: number; upper: number } {
  const means: number[] = [];
  for (let i = 0; i < nSamples; i++) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j++) {
      const idx = Math.floor(Math.random() * diffs.length);
      sum += diffs[idx]!;
    }
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  const lower = means[Math.floor(0.025 * means.length)] ?? 0;
  const upper = means[Math.floor(0.975 * means.length)] ?? 0;
  return { lower, upper };
}

function computeSignificance(aErrors: number[], bErrors: number[], label: string, baseline: string): SignificanceRow | null {
  if (aErrors.length === 0 || bErrors.length === 0 || aErrors.length !== bErrors.length) {
    console.warn(`Skipping significance for ${label}; mismatched arrays.`);
    return null;
  }

  const diffs = aErrors.map((value, idx) => value - bErrors[idx]!);
  const meanDiff = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const diffMean = meanDiff;
  let variance = 0;
  for (const value of diffs) {
    variance += (value - diffMean) ** 2;
  }
  variance = diffs.length > 1 ? variance / (diffs.length - 1) : 0;
  const stdDiff = Math.sqrt(variance);
  const tStat = stdDiff === 0 ? 0 : meanDiff / (stdDiff / Math.sqrt(diffs.length));
  const pValue = 2 * (1 - normalCdf(Math.abs(tStat)));
  const ci = bootstrapCi(diffs, 1000);

  return {
    model: label,
    baseline,
    meanDiff,
    pValue,
    ciLower: ci.lower,
    ciUpper: ci.upper,
    n: diffs.length,
  };
}

function buildErrorModelResult(name: string, filePath: string): ModelResults | null {
  const errors = loadErrorArray(filePath);
  if (!errors) return null;

  const byCaption = {} as Record<Caption, Metrics>;
  for (const caption of CAPTIONS) {
    byCaption[caption] = emptyMetrics();
  }

  return {
    name,
    overall: computeMetricsFromErrors(errors),
    byCaption,
    total: emptyMetrics(),
    ranking: emptyRankingMetrics(),
  };
}

function formatNumber(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "N/A";
}

function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "N/A";
}

function spearmanCorrelation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const n = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return NaN;
  return cov / Math.sqrt(varX * varY);
}

type RankingRow = {
  competitionKey: string;
  corpsKey: string;
  actualTotal: number;
  predictedTotal: number;
};

function computeRankingMetrics(rows: RankingRow[]): RankingMetrics {
  if (!rows.length) return emptyRankingMetrics();

  const grouped = new Map<string, RankingRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.competitionKey) ?? [];
    list.push(row);
    grouped.set(row.competitionKey, list);
  }

  let rankMaeSum = 0;
  let rankMaeCount = 0;
  let spearmanSum = 0;
  let spearmanCount = 0;
  let top3Hits = 0;
  let top3Count = 0;
  let top5Hits = 0;
  let top5Count = 0;
  let finalsHits = 0;
  let finalsCount = 0;
  let pairwiseHits = 0;
  let pairwiseCount = 0;

  for (const group of grouped.values()) {
    if (group.length < 2) continue;

    const actualSorted = [...group].sort((a, b) => b.actualTotal - a.actualTotal);
    const predictedSorted = [...group].sort((a, b) => b.predictedTotal - a.predictedTotal);

    const actualRanks = new Map<string, number>();
    const predictedRanks = new Map<string, number>();

    actualSorted.forEach((row, idx) => actualRanks.set(row.corpsKey, idx + 1));
    predictedSorted.forEach((row, idx) => predictedRanks.set(row.corpsKey, idx + 1));

    const actualRankList: number[] = [];
    const predictedRankList: number[] = [];

    for (const row of group) {
      const actualRank = actualRanks.get(row.corpsKey)!;
      const predictedRank = predictedRanks.get(row.corpsKey)!;
      rankMaeSum += Math.abs(actualRank - predictedRank);
      rankMaeCount += 1;
      actualRankList.push(actualRank);
      predictedRankList.push(predictedRank);
    }

    const corr = spearmanCorrelation(actualRankList, predictedRankList);
    if (Number.isFinite(corr)) {
      spearmanSum += corr;
      spearmanCount += 1;
    }

    const actualTop3 = actualSorted.slice(0, 3).map((row) => row.corpsKey);
    const predictedTop3 = predictedSorted.slice(0, 3).map((row) => row.corpsKey);
    if (actualTop3.length === 3) {
      const actualSet = new Set(actualTop3);
      top3Hits += predictedTop3.reduce((sum, key) => sum + (actualSet.has(key) ? 1 : 0), 0) / 3;
      top3Count += 1;
    }

    const actualTop5 = actualSorted.slice(0, 5).map((row) => row.corpsKey);
    const predictedTop5 = predictedSorted.slice(0, 5).map((row) => row.corpsKey);
    if (actualTop5.length === 5) {
      const actualSet = new Set(actualTop5);
      top5Hits += predictedTop5.reduce((sum, key) => sum + (actualSet.has(key) ? 1 : 0), 0) / 5;
      top5Count += 1;
    }

    const actualFinals = actualSorted.slice(0, 12).map((row) => row.corpsKey);
    const predictedFinals = predictedSorted.slice(0, 12).map((row) => row.corpsKey);
    if (actualFinals.length === 12) {
      const actualSet = new Set(actualFinals);
      finalsHits += predictedFinals.reduce((sum, key) => sum + (actualSet.has(key) ? 1 : 0), 0) / 12;
      finalsCount += 1;
    }

    for (let i = 0; i < actualSorted.length; i++) {
      for (let j = i + 1; j < actualSorted.length; j++) {
        const a = actualSorted[i]!;
        const b = actualSorted[j]!;
        const predRankA = predictedRanks.get(a.corpsKey)!;
        const predRankB = predictedRanks.get(b.corpsKey)!;
        pairwiseCount += 1;
        if (predRankA < predRankB) pairwiseHits += 1;
      }
    }
  }

  if (rankMaeCount === 0) return emptyRankingMetrics();

  return {
    events: Array.from(grouped.values()).filter((group) => group.length >= 2).length,
    rank_mae: rankMaeSum / rankMaeCount,
    rank_correlation: spearmanCount > 0 ? spearmanSum / spearmanCount : NaN,
    top3_accuracy: top3Count > 0 ? top3Hits / top3Count : NaN,
    top5_accuracy: top5Count > 0 ? top5Hits / top5Count : NaN,
    finals_accuracy: finalsCount > 0 ? finalsHits / finalsCount : NaN,
    pairwise_accuracy: pairwiseCount > 0 ? pairwiseHits / pairwiseCount : NaN,
  };
}

// Baseline models

class BaselineZero {
  predict(): Prediction {
    return { p10: 0, p50: 0, p90: 0 };
  }
}

class BaselineLast {
  private history: number[] = [];

  update(value: number) {
    this.history.push(value);
  }

  predict(): Prediction {
    const value = this.history.length ? this.history[this.history.length - 1]! : 0;
    return { p10: value, p50: value, p90: value };
  }

  reset() {
    this.history = [];
  }
}

class BaselineEMA {

  private history: number[] = [];
  private alpha = 0.3;

  update(value: number) {
    this.history.push(value);
  }

  predict(): Prediction {
    if (this.history.length === 0) {
      return { p10: 0, p50: 0, p90: 0 };
    }

    let ema = this.history[0]!;
    for (let i = 1; i < this.history.length; i++) {
      ema = this.alpha * this.history[i]! + (1 - this.alpha) * ema;
    }

    // Rough uncertainty estimate
    const width = 0.5;
    return { p10: ema - width, p50: ema, p90: ema + width };
  }

  reset() {
    this.history = [];
  }
}

class BaselineLinear {
  private history: number[] = [];

  update(value: number) {
    this.history.push(value);
  }

  predict(): Prediction {
    if (this.history.length < 2) {
      const val = this.history.length > 0 ? this.history[0]! : 0;
      return { p10: val - 0.5, p50: val, p90: val + 0.5 };
    }

    // Linear regression on last 3 points
    const window = this.history.slice(Math.max(0, this.history.length - 3));
    const n = window.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += window[i]!;
      sumXY += i * window[i]!;
      sumX2 += i * i;
    }

    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) {
      const val = window[n - 1]!;
      return { p10: val - 0.5, p50: val, p90: val + 0.5 };
    }

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    const nextVal = slope * n + intercept;


    return { p10: nextVal - 0.5, p50: nextVal, p90: nextVal + 0.5 };
  }

  reset() {
    this.history = [];
  }
}

// LSTM model loader
async function loadLSTMModel(modelDir: string) {
  const modelPath = path.join(modelDir, "model.json");
  if (!fs.existsSync(modelPath)) {
    console.warn(`LSTM model not found at ${modelPath}`);
    return null;
  }

  console.log(`Loading LSTM model from ${modelDir}...`);
  const model = await tf.loadLayersModel(`file://${modelPath}`);
  return model;
}

// Evaluate baseline models
async function evaluateBaselines(rows: Row[]): Promise<Record<string, ModelResults>> {
  console.log("\nEvaluating baseline models...");

  const results: Record<string, ModelResults> = {
    baseline_zero: {
      name: "Baseline Zero",
      overall: {} as Metrics,
      byCaption: {} as Record<Caption, Metrics>,
      total: {} as Metrics,
      ranking: {} as RankingMetrics,
    },
    baseline_last: {
      name: "Baseline Last",
      overall: {} as Metrics,
      byCaption: {} as Record<Caption, Metrics>,
      total: {} as Metrics,
      ranking: {} as RankingMetrics,
    },
    baseline_ema: {
      name: "Baseline EMA",
      overall: {} as Metrics,
      byCaption: {} as Record<Caption, Metrics>,
      total: {} as Metrics,
      ranking: {} as RankingMetrics,
    },
    baseline_linear: {
      name: "Baseline Linear",
      overall: {} as Metrics,
      byCaption: {} as Record<Caption, Metrics>,
      total: {} as Metrics,
      ranking: {} as RankingMetrics,
    },
  };


  // For each baseline, generate predictions and compute metrics
  for (const [modelKey, modelResult] of Object.entries(results)) {
    console.log(`  Evaluating ${modelResult.name}...`);

    // Organize by corps/sequence for temporal baselines
    const corpusSequences = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.season}_${row.corps_key}`;
      if (!corpusSequences.has(key)) corpusSequences.set(key, []);
      corpusSequences.get(key)!.push(row);
    }

    const allActuals: number[] = [];
    const allPredictions: Prediction[] = [];
    const totalActuals: number[] = [];
    const totalPredictions: Prediction[] = [];
    const rankingRows: RankingRow[] = [];
    const captionActuals: Record<Caption, number[]> = {} as Record<Caption, number[]>;
    const captionPredictions: Record<Caption, Prediction[]> = {} as Record<Caption, Prediction[]>;


    for (const caption of CAPTIONS) {
      captionActuals[caption] = [];
      captionPredictions[caption] = [];
    }

    for (const [_key, corpusRows] of corpusSequences.entries()) {
      const sortedRows = [...corpusRows].sort(
        (a, b) => new Date(a.competition_date).getTime() - new Date(b.competition_date).getTime()
      );
      const lastModels: Record<Caption, BaselineLast> = {} as Record<Caption, BaselineLast>;
      const emaModels: Record<Caption, BaselineEMA> = {} as Record<Caption, BaselineEMA>;
      const linearModels: Record<Caption, BaselineLinear> = {} as Record<Caption, BaselineLinear>;

      for (const caption of CAPTIONS) {
        lastModels[caption] = new BaselineLast();
        emaModels[caption] = new BaselineEMA();
        linearModels[caption] = new BaselineLinear();
      }

      for (const row of sortedRows) {
        const residuals = JSON.parse(row.y_residuals_json) as Record<Caption, number>;
        let totalActual = 0;
        let totalPred10 = 0;
        let totalPred50 = 0;
        let totalPred90 = 0;

        for (const caption of CAPTIONS) {
          const actual = residuals[caption] ?? 0;

          let pred: Prediction;
          if (modelKey === "baseline_zero") {
            pred = new BaselineZero().predict();
          } else if (modelKey === "baseline_last") {
            pred = lastModels[caption]!.predict();
            lastModels[caption]!.update(actual);
          } else if (modelKey === "baseline_ema") {
            pred = emaModels[caption]!.predict();
            emaModels[caption]!.update(actual);
          } else {
            // baseline_linear
            pred = linearModels[caption]!.predict();
            linearModels[caption]!.update(actual);
          }

          totalActual += actual;
          totalPred10 += pred.p10;
          totalPred50 += pred.p50;
          totalPred90 += pred.p90;

          allActuals.push(actual);
          allPredictions.push(pred);
          captionActuals[caption]!.push(actual);
          captionPredictions[caption]!.push(pred);
        }

        totalActuals.push(totalActual);
        totalPredictions.push({ p10: totalPred10, p50: totalPred50, p90: totalPred90 });
        rankingRows.push({
          competitionKey: `${row.season}_${row.competition_slug}`,
          corpsKey: row.corps_key,
          actualTotal: totalActual,
          predictedTotal: totalPred50,
        });
      }

    }

    // Compute metrics
    modelResult.overall = computeMetrics(allActuals, allPredictions);
    modelResult.total = computeMetrics(totalActuals, totalPredictions);
    modelResult.ranking = computeRankingMetrics(rankingRows);
    for (const caption of CAPTIONS) {
      modelResult.byCaption[caption] = computeMetrics(captionActuals[caption]!, captionPredictions[caption]!);
    }
  }


  return results;
}


// Evaluate LSTM model
async function evaluateLSTM(rows: Row[], modelDir: string): Promise<ModelResults | null> {
  console.log(`\nEvaluating LSTM model from ${modelDir}...`);


  const model = await loadLSTMModel(modelDir);
  if (!model) return null;

  const allActuals: number[] = [];
  const allPredictions: Prediction[] = [];
  const totalActuals: number[] = [];
  const totalPredictions: Prediction[] = [];
  const rankingRows: RankingRow[] = [];
  const captionActuals: Record<Caption, number[]> = {} as Record<Caption, number[]>;
  const captionPredictions: Record<Caption, Prediction[]> = {} as Record<Caption, Prediction[]>;


  for (const caption of CAPTIONS) {
    captionActuals[caption] = [];
    captionPredictions[caption] = [];
  }

  // Prepare batch prediction
  const xSeq: number[][][] = [];
  const xStatic: number[][] = [];
  const yTargets: Record<Caption, number>[] = [];

  for (const row of rows) {
    const seq = JSON.parse(row.x_sequence_json) as number[][];
    const stat = JSON.parse(row.x_static_json) as number[];
    const residuals = JSON.parse(row.y_residuals_json) as Record<Caption, number>;

    xSeq.push(seq);
    xStatic.push(stat);
    yTargets.push(residuals);
  }

  const seqTensor = tf.tensor3d(xSeq);
  const staticTensor = tf.tensor2d(xStatic);

  const output = model.predict([seqTensor, staticTensor]) as tf.Tensor;
  const outputData = await output.array() as number[][];

  seqTensor.dispose();
  staticTensor.dispose();
  output.dispose();

  // Parse predictions
  for (let i = 0; i < rows.length; i++) {
    const predRow = outputData[i]!;
    const actualRow = yTargets[i]!;
    let totalActual = 0;
    let totalPred10 = 0;
    let totalPred50 = 0;
    let totalPred90 = 0;

    for (let j = 0; j < CAPTIONS.length; j++) {
      const caption = CAPTIONS[j]!;
      const p10 = predRow[j * 3]!;
      const p50 = predRow[j * 3 + 1]!;
      const p90 = predRow[j * 3 + 2]!;
      const actual = actualRow[caption] ?? 0;

      const pred: Prediction = { p10, p50, p90 };

      totalActual += actual;
      totalPred10 += p10;
      totalPred50 += p50;
      totalPred90 += p90;

      allActuals.push(actual);
      allPredictions.push(pred);
      captionActuals[caption]!.push(actual);
      captionPredictions[caption]!.push(pred);
    }

    totalActuals.push(totalActual);
    totalPredictions.push({ p10: totalPred10, p50: totalPred50, p90: totalPred90 });
    const row = rows[i]!;
    rankingRows.push({
      competitionKey: `${row.season}_${row.competition_slug}`,
      corpsKey: row.corps_key,
      actualTotal: totalActual,
      predictedTotal: totalPred50,
    });
  }


  const overall = computeMetrics(allActuals, allPredictions);
  const total = computeMetrics(totalActuals, totalPredictions);
  const ranking = computeRankingMetrics(rankingRows);
  const byCaption = {} as Record<Caption, Metrics>;
  for (const caption of CAPTIONS) {
    byCaption[caption] = computeMetrics(captionActuals[caption]!, captionPredictions[caption]!);
  }

  return {
    name: "LSTM V5 Fixed",
    overall,
    byCaption,
    total,
    ranking,
  };
}


// Generate comparison table
function generateComparisonTable(results: Record<string, ModelResults>, significance: SignificanceRow[]): string {
  let table = "# Model Comparison - V5\n\n";

  table += "## Overall Performance\n\n";
  table += "| Model | MAE | RMSE | QL | p10 cov | p50 cov | p90 cov | Width | R² |\n";
  table += "|-------|-----|------|----|---------|---------|---------| ------|----|\n";

  for (const [_key, result] of Object.entries(results)) {
    const m = result.overall;
    table += `| ${result.name} | ${formatNumber(m.mae, 4)} | ${formatNumber(m.rmse, 4)} | ${formatNumber(m.ql50, 4)} | ${formatPercent(m.coverage_p10)} | ${formatPercent(m.coverage_p50)} | ${formatPercent(m.coverage_p90)} | ${formatNumber(m.intervalWidth, 3)} | ${formatNumber(m.r2, 3)} |\n`;
  }

  table += "\n## Total Residual Performance\n\n";
  table += "| Model | MAE | RMSE | QL | p10 cov | p50 cov | p90 cov | Width | R² |\n";
  table += "|-------|-----|------|----|---------|---------|---------| ------|----|\n";

  for (const [_key, result] of Object.entries(results)) {
    const m = result.total;
    table += `| ${result.name} | ${formatNumber(m.mae, 4)} | ${formatNumber(m.rmse, 4)} | ${formatNumber(m.ql50, 4)} | ${formatPercent(m.coverage_p10)} | ${formatPercent(m.coverage_p50)} | ${formatPercent(m.coverage_p90)} | ${formatNumber(m.intervalWidth, 3)} | ${formatNumber(m.r2, 3)} |\n`;
  }

  table += "\n## Ranking Metrics\n\n";
  table += "| Model | Rank MAE | Spearman | Top3 | Top5 | Finals | Pairwise |\n";
  table += "|-------|----------|----------|------|------|--------|----------|\n";

  for (const [_key, result] of Object.entries(results)) {
    const m = result.ranking;
    table += `| ${result.name} | ${formatNumber(m.rank_mae, 3)} | ${formatNumber(m.rank_correlation, 3)} | ${formatPercent(m.top3_accuracy)} | ${formatPercent(m.top5_accuracy)} | ${formatPercent(m.finals_accuracy)} | ${formatPercent(m.pairwise_accuracy)} |\n`;
  }

  table += "\n## Per-Caption Performance (MAE)\n\n";
  table += "| Model | " + CAPTIONS.join(" | ") + " |\n";
  table += "|-------" + "| -----".repeat(CAPTIONS.length) + " |\n";

  for (const [_key, result] of Object.entries(results)) {
    const captionMAEs = CAPTIONS.map((cap) => formatNumber(result.byCaption[cap]?.mae ?? NaN, 4));
    table += `| ${result.name} | ${captionMAEs.join(" | ")} |\n`;
  }

  if (significance.length) {
    table += "\n## Significance vs Baselines (Abs Error)\n\n";
    table += "| Model | Baseline | Mean Δ | p-value | 95% CI | n |\n";
    table += "|-------|----------|--------|---------|--------|---|\n";
    for (const row of significance) {
      table += `| ${row.model} | ${row.baseline} | ${formatNumber(row.meanDiff, 4)} | ${formatNumber(row.pValue, 4)} | [${formatNumber(row.ciLower, 4)}, ${formatNumber(row.ciUpper, 4)}] | ${row.n} |\n`;
    }
  }

  return table;
}


async function main() {
  console.log("=" .repeat(60));
  console.log("Comprehensive Model Evaluation - V5");
  console.log("=".repeat(60));

  // Load validation data
  const client = createClient({ url: `file:${DB_PATH}` });
  console.log("\nLoading validation data...");

  const result = await client.execute(`
    SELECT season, corps_key, competition_slug, competition_date, x_sequence_json, x_static_json, y_residuals_json
    FROM ml_sequence_rows_v5
    WHERE split = 'val'
    ORDER BY competition_date ASC

  `);

  const rows = result.rows as unknown as Row[];
  console.log(`Loaded ${rows.length} validation sequences`);

  client.close();

  // Evaluate all models
  const allResults: Record<string, ModelResults> = {};

  // Baselines
  const baselineResults = await evaluateBaselines(rows);
  Object.assign(allResults, baselineResults);

  // LSTM
  const lstmResult = await evaluateLSTM(rows, "./models/v5_fixed_bilstm");
  if (lstmResult) {
    allResults.lstm_v5 = lstmResult;
  }

  const errorModelConfigs = [
    { key: "xgb_v5", name: "XGBoost Quantile V5", path: path.join(RESULTS_DIR, "xgb-errors-val.json") },
    { key: "lgb_v5", name: "LightGBM Quantile V5", path: path.join(RESULTS_DIR, "lgb-errors-val.json") },
    { key: "ridge_v5", name: "Ridge Per Caption V5", path: path.join(RESULTS_DIR, "ridge-errors-val.json") },
  ];

  for (const config of errorModelConfigs) {
    const modelResult = buildErrorModelResult(config.name, config.path);
    if (modelResult) {
      allResults[config.key] = modelResult;
    }
  }

  const baselineErrorFiles = [
    { key: "baseline_zero", name: "Baseline Zero", path: path.join(RESULTS_DIR, "baseline-zero-errors-val.json") },
    { key: "baseline_last", name: "Baseline Last", path: path.join(RESULTS_DIR, "baseline-last-errors-val.json") },
    { key: "baseline_ema", name: "Baseline EMA", path: path.join(RESULTS_DIR, "baseline-ema-errors-val.json") },
    { key: "baseline_linear", name: "Baseline Linear", path: path.join(RESULTS_DIR, "baseline-linear-errors-val.json") },
  ];

  const baselineErrors = new Map<string, number[]>();
  for (const baseline of baselineErrorFiles) {
    const errors = loadAbsErrorArray(baseline.path);
    if (errors) baselineErrors.set(baseline.name, errors);
  }

  const significanceRows: SignificanceRow[] = [];
  const baselineRef = baselineErrors.get("Baseline EMA");
  if (baselineRef) {
    for (const model of errorModelConfigs) {
      const modelErrors = loadAbsErrorArray(model.path);
      if (!modelErrors) continue;
      const row = computeSignificance(modelErrors, baselineRef, model.name, "Baseline EMA");
      if (row) significanceRows.push(row);
    }
  }

  // Generate comparison table
  const comparisonTable = generateComparisonTable(allResults, significanceRows);

  const tableFile = path.join(RESULTS_DIR, "model-comparison-table.md");
  fs.writeFileSync(tableFile, comparisonTable);
  console.log(`\n✅ Comparison table saved to: ${tableFile}`);
  console.log("\n" + comparisonTable);

  // Save detailed results
  const detailedFile = path.join(RESULTS_DIR, "model-evaluation-detailed.json");
  fs.writeFileSync(detailedFile, JSON.stringify(allResults, null, 2));
  console.log(`\n✅ Detailed results saved to: ${detailedFile}`);

  console.log("\n" + "=".repeat(60));
  console.log("Evaluation Complete");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});
