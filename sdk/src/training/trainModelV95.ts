/**
 * trainModelV95: reconstructed final2-compatible baseline trainer
 *
 * FIXES OVER V9-improved:
 * 1. INCREASED CAPACITY: Dense 256→512, 128→256 (+200K+ params)
 * 2. SPLIT HEADS: Dedicated accuracyTrunk for Mean, separate widthConcat for Quantiles
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
import * as crypto from "node:crypto";
import * as util from "node:util";
import {
  applyV9PredictionContextMode,
  maskV9JudgeContext,
  V9_COLD_START_STATIC_OFFSET,
  V9_FEATURE_INDICES,
  V9_RAW_STATIC_DIM,
  maskV9ThinHistoryContext,
} from "./v9FeatureModes.js";
import {
  addMetricValue,
  createMetricBucket,
  forecastMode,
  historyBucket,
  identityAvailabilityMode,
  identitySupportBucket,
  mapBuckets,
  pearsonCorrelation,
  seasonPhase,
  summarizeBucket,
  type MetricBucket,
} from "./v95Metrics.js";
import {
  initialCurriculumState,
  cosineBaseLearningRate,
  effectiveLearningRate,
  identityScalesAtEpoch,
  lossWeightsAtEpoch,
  phaseAwareBaseLearningRate,
  sequenceLengthAtEpoch,
  stepCurriculum,
  widthFloorWeightAtEpoch,
  type CurriculumConfig as AutoCurriculumConfig,
  type CurriculumTransition,
} from "./v95Curriculum.js";
import { blendThinHistoryBaseline, buildForecastBaseline, selectV95Masking } from "./v95Masking.js";
import {
  checkpointDecisions,
  selectFinalWeightsMode,
} from "./v95Checkpoints.js";
import {
  formatV95Curriculum,
  formatV95ModelCapacity,
  parseV95Args,
} from "./v95Config.js";
import {
  buildFinal2EvaluationRows,
  evaluationMaskRates,
  splitValidationRows,
} from "./v95Evaluation.js";
import { snapshotV95TrainingSource } from "./v95TrainingSource.js";
import {
  loadV10IdentitySupport,
  supportAugmentationEnabled,
  supportAdjustedDropout,
  supportResidualGate,
  temporalIdentityTrust,
} from "./v10IdentitySupport.js";

const DB_PATH = "./dci-relational.db";
const MODEL_DIR = "./models/v95_final2_reconstruction";
const NORM_PATH = "./results/v95-final2-reconstruction-target-norm.json";
const JUDGE_INDEX_PATH = "./src/training/judgeIndexMap.json";
const CORPS_INDEX_PATH = "./src/training/corpsIndexMap.json";
let JUDGE_COUNT = 245;
let CORPS_COUNT = 709;
let SHOW_COUNT = 349;
let SUPPORT_AWARE_IDENTITY = false;
let SUPPORT_DROPOUT_STRENGTH = 0.6;
const FINAL2_JUDGE_MAP_SHA256 = "1c95f7000798a858dd7b9e96864a2c2926d3bfc2fbccf24b44745d49a1c6596f";
const FINAL2_CORPS_MAP_SHA256 = "99de63cc614f6965c64d229450bd1ebd663efdb02b4213281973f5f193ea3f3c";
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const CAPTION_COUNT = CAPTIONS.length;
const SEQ_LEN = 15;
const FEAT_DIM = 101;
const rawStaticDimArgIndex = process.argv.indexOf("--raw-static-dim");
const RAW_STATIC_DIM = rawStaticDimArgIndex >= 0
  ? Number(process.argv[rawStaticDimArgIndex + 1])
  : V9_RAW_STATIC_DIM;
if (!Number.isInteger(RAW_STATIC_DIM) || RAW_STATIC_DIM < V9_RAW_STATIC_DIM) {
  throw new Error(`Invalid --raw-static-dim ${process.argv[rawStaticDimArgIndex + 1] ?? RAW_STATIC_DIM}`);
}

const TREND_DIM = CAPTION_COUNT;
const CONTEXT_DIM = 0;
const TOTAL_STATIC_DIM = RAW_STATIC_DIM + TREND_DIM + CONTEXT_DIM;

const BATCH_SIZE = 128;
const EPOCHS = 160;
const EARLY_STOPPING_PATIENCE = 60;
const REDUCE_LR_PATIENCE = 12;
const PADDING_INDEX = 3;
// V9: WIDTH_FLOOR_PTS maintained, but logic inside loss function tightened
const WIDTH_FLOOR_PTS = 0.5;
const WIDTH_FLOOR_WEIGHT = 1.5;
const SCORE_COVERAGE_TARGET = 0.8;
const SCORE_COVERAGE_UPPER_TARGET = 0.85;
const SCORE_COVERAGE_WEIGHT = 0.2; // V9: Slightly increased from 0.1 to balance the squeeze
const EMA_ALPHA = 0.3;
const RECAP_OFFSET_IN_FEATS = 21;
const CAPTION_STRIDE = 4;
const CAPTION_SCORE_SCALE = 20;
const SAMPLES_PER_EPOCH = 4096;

const WIDTH_TARGET_PTS = 2.5;
const WIDTH_PENALTY_WEIGHT = 0.5;
const OVER_COVERAGE_WEIGHT = 2.0;
const UNK_CORPS_ID = 0;
const DELTA_DIM = CAPTION_COUNT * 3;
const BASELINE_DROPOUT_RATE = 0.1;
const BASELINE_NOISE_STD_PTS = 0.25;
const BASE_WIDTH_MULTIPLIER = 1.0;
const COVERAGE_SHARPNESS = 4.0;
const IDENTITY_DROPOUT_FLOOR = 0.05;
const ACCURACY_TRUNK_UNITS = 270;
const CURRICULUM_PHASE_A_END = 10;
const CURRICULUM_PHASE_B_END = 40;
const CURRICULUM_PHASE_C_RAMP = 80;
const CORPS_SCALE_START_EPOCH = 25;
const CORPS_SCALE_RAMP_EPOCHS = 35;
const JUDGE_SCALE_RAMP_EPOCHS = 40;
const AUTO_CURRICULUM = true;
const AUTO_CURRICULUM_PATIENCE = 6;
const AUTO_CURRICULUM_MIN_COVERAGE = 0.9;
const AUTO_CURRICULUM_MIN_DELTA_GAIN = 0.002;
const AUTO_CURRICULUM_PHASE_A_MIN = 6;
const AUTO_CURRICULUM_PHASE_B_MIN = 18;
const HISTORY_HIDE_RATE = 0.15;
const JUDGE_HIDE_RATE = 0.25;
const FORECAST_CONTEXT_HIDE_RATE = 0.12;
const OPEN_CLASS_SAMPLE_FRACTION = 0.35;
const COLD_START_STATIC_OFFSET = V9_COLD_START_STATIC_OFFSET;


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

function hashFileIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function safeReferenceCurveVersion(refPath: string) {
  if (!fs.existsSync(refPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(refPath, "utf-8")) as {
      version?: string;
      metadata?: { version?: string };
    };
    return parsed.version ?? parsed.metadata?.version ?? null;
  } catch {
    return null;
  }
}

async function verifyFinal2SourceDatabase(dbPath: string) {
  const baselinePath = path.join("src", "training", "baselines", "final2-baseline.json");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as {
    data: { source_database: { bytes: number; sha256: string } };
  };
  const expected = baseline.data.source_database;
  const actualBytes = fs.statSync(dbPath).size;
  if (actualBytes !== expected.bytes) {
    throw new Error(
      `final2 source DB size mismatch: expected ${expected.bytes}, received ${actualBytes} (${dbPath})`,
    );
  }
  const hash = crypto.createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(dbPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  const actualHash = hash.digest("hex");
  if (actualHash !== expected.sha256) {
    throw new Error(
      `final2 source DB hash mismatch: expected ${expected.sha256}, received ${actualHash}`,
    );
  }
  console.log(`final2 source DB verified: ${actualBytes} bytes, sha256=${actualHash}`);
}

function verifyFinal2Population(
  loadedRows: DataRow[],
  trainRows: DataRow[],
  valRows: DataRow[],
  testRows: DataRow[],
) {
  const divisionCounts = Object.fromEntries(
    [...new Set(loadedRows.map((row) => row.division))].map((division) => [
      division,
      loadedRows.filter((row) => row.division === division).length,
    ]),
  );
  const actual = {
    loaded: loadedRows.length,
    train: trainRows.length,
    validation: valRows.length,
    test: testRows.length,
    trainShows: new Set(trainRows.map((row) => row.showKey)).size,
    validationShows: new Set(valRows.map((row) => row.showKey)).size,
    testShows: new Set(testRows.map((row) => row.showKey)).size,
    world: divisionCounts["World Class"] ?? 0,
    open: divisionCounts["Open Class"] ?? 0,
  };
  const expected = {
    loaded: 7321,
    train: 6906,
    validation: 363,
    test: 52,
    trainShows: 816,
    validationShows: 44,
    testShows: 4,
    world: 5086,
    open: 2235,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `final2 population mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
  console.log(`final2 population verified: ${JSON.stringify(actual)}`);
}

function evaluateSamples(
  model: tf.LayersModel,
  samples: Sample[],
  stats: TargetStats,
  args: ReturnType<typeof parseArgs>,
  label: string,
  seed: number,
  intervalScale = 1,
) {
  const global = createMetricBucket();
  const byCaption = Object.fromEntries(CAPTIONS.map((caption) => [caption, createMetricBucket()]));
  const byDivision: Record<string, MetricBucket> = {};
  const byPhase: Record<string, MetricBucket> = {};
  const byJudgeMode: Record<string, MetricBucket> = {};
  const byHistory: Record<string, MetricBucket> = {};
  const byForecastMode: Record<string, MetricBucket> = {};
  const byCorpsIdentityMode: Record<string, MetricBucket> = {};
  const byJudgeIdentityMode: Record<string, MetricBucket> = {};
  const byShowIdentityMode: Record<string, MetricBucket> = {};
  const byCorpsSupport: Record<string, MetricBucket> = {};
  const byJudgeSupport: Record<string, MetricBucket> = {};
  const byShowSupport: Record<string, MetricBucket> = {};
  const fingerprintDiagnostics = Object.fromEntries(CAPTIONS.map((caption) => [caption, {
    fingerprint: [] as number[],
    actualResidual: [] as number[],
    predictedResidual: [] as number[],
  }]));

  const deltaStd = stats.deltaStd.map((value) => value > 1e-6 ? value : 1);
  const recapStd = stats.recapStd.map((value) => value > 1e-6 ? value : 1);
  const categoryStd = stats.categoryStd.map((value) => value > 1e-6 ? value : 1);
  const totalStd = stats.totalStd > 1e-6 ? stats.totalStd : 1;
  const scales = {
    judgeBias: args.noJudgeBias ? 0 : 1,
    corps: args.noCorpsResidual ? 0 : 1,
  };

  for (const batch of batchGeneratorFromGroups(
    groupSamplesByShow(samples),
    args.batchSize,
    false,
    seed,
    scales,
  )) {
    const { xs, ys } = batch;
    const batchSize = ys.shape[0] ?? 0;
    const predictions = model.predict([
      xs.sequence,
      xs.static,
      xs.mask,
      xs.judge_ids,
      xs.corps_id,
      xs.baseline_recap,
      xs.history_len,
      xs.judge_bias_scale,
      xs.corps_scale,
      xs.agnostic_show_id,
    ]) as tf.Tensor;
    const predictedValues = Array.from(predictions.dataSync());
    const trueValues = Array.from(ys.dataSync());

    for (let rowIndex = 0; rowIndex < batchSize; rowIndex++) {
      const sample = batch.samples[rowIndex]!;
      const division = sample.meta.division || "unknown";
      const phase = seasonPhase(sample.meta.date);
      const judgeMode = sample.meta.judgeKnown ? "panel_known" : "panel_unknown";
      const history = historyBucket(sample.meta.historyLen);
      const forecast = forecastMode(sample.meta);
      const rowCategoryErrors: number[] = [];

      global.rows += 1;
      const rowBuckets: Array<[Record<string, MetricBucket>, string]> = [
        [byDivision, division],
        [byPhase, phase],
        [byJudgeMode, judgeMode],
        [byHistory, history],
        [byForecastMode, forecast],
        [byCorpsIdentityMode, sample.meta.corpsIdentityMode],
        [byJudgeIdentityMode, sample.meta.judgeIdentityMode],
        [byShowIdentityMode, sample.meta.showIdentityMode],
        [byCorpsSupport, identitySupportBucket(sample.meta.corpsSupportTrust)],
        [byJudgeSupport, identitySupportBucket(sample.meta.judgeSupportTrust)],
        [byShowSupport, identitySupportBucket(sample.meta.showSupportTrust)],
      ];
      rowBuckets.forEach(([buckets, key]) => {
        addMetricValue(buckets, key, (bucket) => { bucket.rows += 1; });
      });

      for (let captionIndex = 0; captionIndex < CAPTION_COUNT; captionIndex++) {
        const predictedOffset = rowIndex * OUTPUT_DIM;
        const trueOffset = rowIndex * TARGET_DIM;
        const q10 = predictedValues[predictedOffset + captionIndex]!;
        const q50 = predictedValues[predictedOffset + CAPTION_COUNT + captionIndex]!;
        const q90 = predictedValues[predictedOffset + CAPTION_COUNT * 2 + captionIndex]!;
        const trueDeltaNorm = trueValues[trueOffset + captionIndex]!;
        const predictedDelta = denormalize(q50, stats.deltaMean[captionIndex]!, deltaStd[captionIndex]!);
        const trueDelta = denormalize(trueDeltaNorm, stats.deltaMean[captionIndex]!, deltaStd[captionIndex]!);
        const rawLower = Math.min(
          denormalize(q10, stats.deltaMean[captionIndex]!, deltaStd[captionIndex]!),
          denormalize(q90, stats.deltaMean[captionIndex]!, deltaStd[captionIndex]!),
        );
        const rawUpper = Math.max(
          denormalize(q10, stats.deltaMean[captionIndex]!, deltaStd[captionIndex]!),
          denormalize(q90, stats.deltaMean[captionIndex]!, deltaStd[captionIndex]!),
        );
        const lower = predictedDelta - Math.max(0, predictedDelta - rawLower) * intervalScale;
        const upper = predictedDelta + Math.max(0, rawUpper - predictedDelta) * intervalScale;
        const width = upper - lower;
        const within = trueDelta >= lower && trueDelta <= upper ? 1 : 0;

        const predictedRecapNorm = predictedValues[predictedOffset + DELTA_DIM + captionIndex]!;
        const trueRecapNorm = trueValues[trueOffset + CAPTION_COUNT + captionIndex]!;
        const predictedRecap = denormalize(
          predictedRecapNorm,
          stats.recapMean[captionIndex]!,
          recapStd[captionIndex]!,
        );
        const trueRecap = denormalize(trueRecapNorm, stats.recapMean[captionIndex]!, recapStd[captionIndex]!);
        const baselineNorm = Number(sample.xs[5][captionIndex] ?? 0);
        const baselineRecap = denormalize(baselineNorm, stats.recapMean[captionIndex]!, recapStd[captionIndex]!);
        const fingerprintPrior = Number(
          sample.xs[1][V9_FEATURE_INDICES.captionFingerprintStart + captionIndex * 4] ?? 0,
        ) * 2;
        const fingerprintMulti = Number(
          sample.xs[1][V9_FEATURE_INDICES.captionFingerprintStart + captionIndex * 4 + 1] ?? 0,
        ) * 2;
        const caption = CAPTIONS[captionIndex]!;
        const diagnostic = fingerprintDiagnostics[caption]!;
        diagnostic.fingerprint.push(Number.isFinite(fingerprintMulti) ? fingerprintMulti : fingerprintPrior);
        diagnostic.actualResidual.push(trueRecap - baselineRecap);
        diagnostic.predictedResidual.push(predictedRecap - baselineRecap);

        const applyCaptionMetrics = (bucket: MetricBucket) => {
          bucket.captionCount += 1;
          bucket.deltaAbs += Math.abs(predictedDelta - trueDelta);
          bucket.recapAbs += Math.abs(predictedRecap - trueRecap);
          bucket.coverageWithin += within;
          bucket.width += width;
          bucket.widthFloor += width < args.widthFloorPts ? 1 : 0;
        };
        applyCaptionMetrics(global);
        applyCaptionMetrics(byCaption[caption]!);
        rowBuckets.forEach(([buckets, key]) => addMetricValue(buckets, key, applyCaptionMetrics));
      }

      for (let categoryIndex = 0; categoryIndex < CATEGORY_DIM; categoryIndex++) {
        const predictedNorm = predictedValues[
          rowIndex * OUTPUT_DIM + DELTA_DIM + RECAP_DIM + categoryIndex
        ]!;
        const trueNorm = trueValues[
          rowIndex * TARGET_DIM + CAPTION_COUNT + RECAP_DIM + categoryIndex
        ]!;
        rowCategoryErrors.push(Math.abs(
          denormalize(predictedNorm, stats.categoryMean[categoryIndex]!, categoryStd[categoryIndex]!) -
          denormalize(trueNorm, stats.categoryMean[categoryIndex]!, categoryStd[categoryIndex]!),
        ));
      }
      const predictedTotalNorm = predictedValues[
        rowIndex * OUTPUT_DIM + DELTA_DIM + RECAP_DIM + CATEGORY_DIM
      ]!;
      const trueTotalNorm = trueValues[
        rowIndex * TARGET_DIM + CAPTION_COUNT + RECAP_DIM + CATEGORY_DIM
      ]!;
      const categoryAbs = mean(rowCategoryErrors);
      const totalAbs = Math.abs(
        denormalize(predictedTotalNorm, stats.totalMean, totalStd) -
        denormalize(trueTotalNorm, stats.totalMean, totalStd),
      );
      const applyRowMetrics = (bucket: MetricBucket) => {
        bucket.categoryAbs += categoryAbs;
        bucket.totalAbs += totalAbs;
      };
      applyRowMetrics(global);
      rowBuckets.forEach(([buckets, key]) => addMetricValue(buckets, key, applyRowMetrics));
    }

    predictions.dispose();
    Object.values(xs).forEach((tensor) => tensor.dispose());
    ys.dispose();
  }

  return {
    label,
    interval_scale: intervalScale,
    metrics: summarizeBucket(global),
    by_caption: mapBuckets(byCaption),
    by_division: mapBuckets(byDivision),
    by_season_phase: mapBuckets(byPhase),
    by_judge_mode: mapBuckets(byJudgeMode),
    by_history: mapBuckets(byHistory),
    by_forecast_mode: mapBuckets(byForecastMode),
    by_corps_identity_mode: mapBuckets(byCorpsIdentityMode),
    by_judge_identity_mode: mapBuckets(byJudgeIdentityMode),
    by_show_identity_mode: mapBuckets(byShowIdentityMode),
    by_corps_support: mapBuckets(byCorpsSupport),
    by_judge_support: mapBuckets(byJudgeSupport),
    by_show_support: mapBuckets(byShowSupport),
    caption_fingerprint_diagnostics: Object.fromEntries(
      Object.entries(fingerprintDiagnostics).map(([caption, values]) => [caption, {
        samples: values.fingerprint.length,
        fingerprint_vs_actual_residual_corr: pearsonCorrelation(
          values.fingerprint,
          values.actualResidual,
        ),
        fingerprint_vs_predicted_residual_corr: pearsonCorrelation(
          values.fingerprint,
          values.predictedResidual,
        ),
      }]),
    ),
  };
}

function calibrateIntervalScale(
  model: tf.LayersModel,
  validationSamples: Sample[],
  stats: TargetStats,
  args: ReturnType<typeof parseArgs>,
) {
  const targetMidpoint = (args.coverageTarget + args.coverageUpperTarget) / 2;
  const candidates: Array<{
    scale: number;
    coverage: number;
    width: number;
    delta_mae_pts: number;
    score: number;
  }> = [];

  for (let scale = 0.2; scale <= 1.201; scale += 0.025) {
    const roundedScale = Math.round(scale * 1000) / 1000;
    const report = evaluateSamples(
      model,
      validationSamples,
      stats,
      args,
      "validation_calibration",
      args.seed + 777,
      roundedScale,
    );
    const { coverage, width, delta_mae_pts } = report.metrics;
    const underPenalty = Math.max(0, args.coverageTarget - coverage) * 5;
    const overPenalty = Math.max(0, coverage - args.coverageUpperTarget) * 2;
    const targetPenalty = Math.abs(coverage - targetMidpoint);
    const widthPenalty = width * 0.01;
    candidates.push({
      scale: roundedScale,
      coverage,
      width,
      delta_mae_pts,
      score: underPenalty + overPenalty + targetPenalty + widthPenalty,
    });
  }

  candidates.sort((left, right) => left.score - right.score || left.width - right.width);
  return {
    method: "validation_grid_search_symmetric_width_scale",
    target_coverage: args.coverageTarget,
    upper_target_coverage: args.coverageUpperTarget,
    selected: candidates[0] ?? null,
    candidates: candidates.slice(0, 12),
  };
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

function inferAccuracyTrunkUnitsFromModelDir(modelDir?: string): number | undefined {
  if (!modelDir) return undefined;
  const modelJsonPath = path.join(modelDir, "model.json");
  if (!fs.existsSync(modelJsonPath)) return undefined;

  try {
    const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, "utf-8"));
    const layers = modelJson.modelTopology?.config?.layers;
    if (!Array.isArray(layers)) return undefined;
    const accuracyTrunk = layers.find((layer: any) => layer?.config?.name === "accuracy_trunk");
    const units = Number(accuracyTrunk?.config?.units);
    return Number.isFinite(units) && units > 0 ? units : undefined;
  } catch (error) {
    console.warn(`Could not infer accuracy trunk units from ${modelJsonPath}:`, error);
    return undefined;
  }
}

const sameShape = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, idx) => value === b[idx]);

function mergeCompatibleTensor(source: tf.Tensor, target: tf.Tensor): tf.Tensor | null {
  if (sameShape(source.shape, target.shape)) return source.clone();

  // Embedding maps grow during in-season updates. Preserve learned rows and keep new rows initialized.
  if (source.shape.length === 2 && target.shape.length === 2 && source.shape[1] === target.shape[1] && source.shape[0] <= target.shape[0]) {
    const merged = new Float32Array(target.dataSync() as Float32Array);
    const sourceData = source.dataSync() as Float32Array;
    merged.set(sourceData, 0);
    return tf.tensor(merged, target.shape);
  }

  return null;
}

function loadCompatibleModelWeights(model: tf.LayersModel, modelJsonPath: string, weightsPath: string) {
  const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, "utf-8"));
  const weightSpecs = modelJson.weightsManifest?.[0]?.weights ?? [];
  const weightBuffer = fs.readFileSync(weightsPath);
  const sourceWeights = new Map<string, tf.Tensor>();
  let offset = 0;

  for (const spec of weightSpecs) {
    const byteLength = spec.shape.reduce((a: number, b: number) => a * b, 1) * 4;
    const data = new Float32Array(weightBuffer.buffer, weightBuffer.byteOffset + offset, byteLength / 4);
    sourceWeights.set(spec.name, tf.tensor(data, spec.shape));
    offset += byteLength;
  }

  const targetWeights = model.getWeights();
  const targetRefs = ((model as any).weights ?? []) as Array<{ name?: string; originalName?: string }>;
  const nextWeights: tf.Tensor[] = [];
  let loaded = 0;
  let partiallyLoaded = 0;
  let skipped = 0;

  try {
    for (let idx = 0; idx < targetWeights.length; idx++) {
      const target = targetWeights[idx]!;
      const name = targetRefs[idx]?.originalName ?? targetRefs[idx]?.name;
      const source = name ? sourceWeights.get(name) : undefined;
      const merged = source ? mergeCompatibleTensor(source, target) : null;

      if (merged) {
        nextWeights.push(merged);
        if (sameShape(source!.shape, target.shape)) loaded++;
        else partiallyLoaded++;
      } else {
        nextWeights.push(target.clone());
        skipped++;
      }
    }

    model.setWeights(nextWeights);
  } finally {
    for (const tensor of sourceWeights.values()) tensor.dispose();
  }

  return { loaded, partiallyLoaded, skipped, total: targetWeights.length };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const loadModelIndex = argv.indexOf("--load-model");
  const loadModel = loadModelIndex >= 0 ? argv[loadModelIndex + 1] : undefined;
  const inferredAccuracyTrunkUnits = argv.includes("--accuracy-trunk-units")
    ? undefined
    : inferAccuracyTrunkUnitsFromModelDir(loadModel);
  return parseV95Args(argv, inferredAccuracyTrunkUnits);
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

const installConsoleTee = (logPath: string) => {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = fs.createWriteStream(logPath, { flags: "a" });
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  const write = (level: "log" | "warn" | "error", args: unknown[]) => {
    const line = util.format(...args);
    stream.write(`[${new Date().toISOString()}] [${level}] ${line}\n`);
  };

  console.log = (...args: unknown[]) => {
    originalLog(...args);
    write("log", args);
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    write("warn", args);
  };
  console.error = (...args: unknown[]) => {
    originalError(...args);
    write("error", args);
  };

  const close = () => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    stream.end();
  };
  process.once("exit", () => {
    stream.end();
  });
  return close;
};

const formatDuration = (seconds: number) => {
  const safeSeconds = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;
  return [hours, minutes, secs].map((value) => value.toString().padStart(2, "0")).join(":");
};

const coverageWeight = (epoch: number, start: number, ramp: number, maxW: number) => {
  if (epoch < start) return 0;
  const t = Math.min(1, (epoch - start) / Math.max(1, ramp));
  return maxW * t * t * (3 - 2 * t);
};

type DataRow = {
  season: string;
  competitionSlug: string;
  corpsKey: string;
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
  corpsSupportTrust: number;
  judgeSupportTrust: number[];
  showSupportTrust: number;
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

type LossSchedulerConfig = {
  phaseAEnd: number;
  phaseBEnd: number;
  phaseCRamp: number;
  corpsScaleStart: number;
  corpsScaleRamp: number;
  judgeScaleRamp: number;
  identityDropoutFloor: number;
};

class V9LossScheduler {
  constructor(private config: LossSchedulerConfig) {}

  getPhase(epoch: number) {
    if (epoch < this.getPhaseAEnd()) return "A" as const;
    if (epoch < this.getPhaseBEnd()) return "B" as const;
    return "C" as const;
  }

  getPhaseAEnd() {
    return Math.max(1, this.config.phaseAEnd);
  }

  getPhaseBEnd() {
    return Math.max(this.getPhaseAEnd() + 1, this.config.phaseBEnd);
  }

  setPhaseAEnd(epoch: number) {
    this.config.phaseAEnd = Math.max(1, Math.floor(epoch));
    this.config.phaseBEnd = Math.max(this.config.phaseBEnd, this.config.phaseAEnd + 1);
  }

  setPhaseBEnd(epoch: number) {
    this.config.phaseBEnd = Math.max(this.getPhaseAEnd() + 1, Math.floor(epoch));
  }

  getWeights(epoch: number) {
    return lossWeightsAtEpoch(epoch, this.config);
  }

  getScales(epoch: number) {
    return identityScalesAtEpoch(epoch, this.config);
  }

  getWidthFloorWeight(epoch: number, startWeight: number, endWeight: number): number {
    return widthFloorWeightAtEpoch(epoch, startWeight, endWeight, this.config);
  }
}

class SequenceDataProviderV9 {
  private worldRows: DataRow[];
  private openRows: DataRow[];
  private worldShows: DataRow[][];
  private openShows: DataRow[][];
  private allShows: DataRow[][];
  private worldThinShows: DataRow[][];
  private openThinShows: DataRow[][];

  constructor(
    private rows: DataRow[],
    private epoch: number,
    private batchSize: number = BATCH_SIZE,
    private longSequenceStartEpoch: number = CURRICULUM_PHASE_A_END,
    private sequenceTransitionEpochs: number = 0,
    private openSampleFraction: number = OPEN_CLASS_SAMPLE_FRACTION,
    private thinHistorySampleFraction: number = 0,
  ) {
    this.worldRows = this.rows.filter(r => r.division === "World Class");
    this.openRows = this.rows.filter(r => r.division === "Open Class");
    this.worldShows = this.groupByShow(this.worldRows);
    this.openShows = this.groupByShow(this.openRows);
    this.allShows = this.groupByShow(this.rows);
    this.worldThinShows = this.worldShows.filter((show) => this.isThinShow(show));
    this.openThinShows = this.openShows.filter((show) => this.isThinShow(show));
  }

  setEpoch(epoch: number) {
    this.epoch = epoch;
  }

  setLongSequenceStartEpoch(epoch: number) {
    this.longSequenceStartEpoch = epoch;
  }

  getSequenceLength(): number {
    return sequenceLengthAtEpoch(
      this.epoch,
      this.longSequenceStartEpoch,
      this.sequenceTransitionEpochs,
    );
  }

  sampleRows(count: number, seed: number): DataRow[] {
    if (this.openShows.length === 0) {
      return this.flattenShows(this.sampleShows(this.allShows, count, seed));
    }

    const openCount = Math.floor(count * Math.max(0, Math.min(0.5, this.openSampleFraction)));
    const worldCount = count - openCount;

    const worldSample = this.sampleDivision(this.worldShows, this.worldThinShows, worldCount, seed);
    const openSample = this.sampleDivision(this.openShows, this.openThinShows, openCount, seed + 1);
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

  private isThinShow(show: DataRow[]) {
    return show.some((row) => Math.round((row.stat[COLD_START_STATIC_OFFSET + 1] ?? 0) * 40) <= 3);
  }

  private sampleDivision(shows: DataRow[][], thinShows: DataRow[][], targetCount: number, seed: number) {
    const fraction = Math.max(0, Math.min(0.8, this.thinHistorySampleFraction));
    if (fraction <= 0 || thinShows.length === 0) return this.sampleShows(shows, targetCount, seed);
    const thinTarget = Math.floor(targetCount * fraction);
    const selectedThin = this.sampleShows(thinShows, thinTarget, seed);
    const selectedKeys = new Set(selectedThin.map((show) => show[0]?.showKey));
    const remainder = shows.filter((show) => !selectedKeys.has(show[0]?.showKey));
    const selectedRegular = this.sampleShows(remainder, Math.max(0, targetCount - selectedThin.flat().length), seed + 17);
    return this.shuffle([...selectedThin, ...selectedRegular], seed + 29);
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


function buildDataRows(rows: Array<{ x_sequence_json: string; x_static_json: string; y_residuals_json: string; y_recap_json: string; judge_indices_json: string; division_name: string; corps_id: number; corps_key?: string; split: string; competition_slug?: string; competition_date: string; season: string; agnostic_show_id?: number }>) {
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
        season: row.season,
        competitionSlug: row.competition_slug ?? "unknown",
        corpsKey: row.corps_key ?? String(row.corps_id ?? "unknown"),
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
        corpsSupportTrust: 0,
        judgeSupportTrust: judgeIndices.map(() => 0),
        showSupportTrust: 0,
      });
    }
  }

  const temporalSupport = temporalIdentityTrust(dataRows.map((row) => ({
    date: row.date,
    season: row.season,
    corpsKey: row.corpsKey,
    judgeIndices: row.judgeIndices,
    showIndex: row.agnosticShowId,
  })));
  temporalSupport.forEach((support, index) => {
    dataRows[index]!.corpsSupportTrust = support.corpsTrust;
    dataRows[index]!.judgeSupportTrust = support.judgeTrust;
    dataRows[index]!.showSupportTrust = support.showTrust;
  });
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
  xs: [number[][], number[], number[], number[], number, number[], number, number, number, number, number];
  ys: number[];
  meta: {
    season: string;
    date: string;
    showKey: string;
    competitionSlug: string;
    corpsKey: string;
    corpsId: number;
    division: string;
    split: string;
    total: number;
    historyLen: number;
    judgeKnown: boolean;
    historyHidden: boolean;
    historyTruncated: boolean;
    sameSeasonHistoryCount: number;
    thinBaselineBlended: boolean;
    corpsSupportTrust: number;
    judgeSupportTrust: number;
    showSupportTrust: number;
    corpsIdentityMode: string;
    judgeIdentityMode: string;
    showIdentityMode: string;
    forecastContextHidden: boolean;
    lineupContextHidden: boolean;
    seasonDebut: boolean;
    firstSeasonEvent: boolean;
  };
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
  baselineNoiseStd: number = BASELINE_NOISE_STD_PTS,
  historyHideRate: number = 0,
  judgeHideRate: number = 0,
  forecastContextHideRate: number = 0,
  lineupHideRate: number = 0,
  thinHistoryTruncationRate: number = 0,
  thinHistoryBaselineBlend: boolean = false,
): Sample[] {
  const samples: Sample[] = [];
  const rng = seededRandom(seed);

  const agnosticShowSet = new Set<number>();
  for (const row of rows) agnosticShowSet.add(row.agnosticShowId);
  const uniqueShowCount = Math.max(1, Math.max(...Array.from(agnosticShowSet)) + 1);
  (globalThis as any).UNIQUE_SHOW_COUNT = Math.max(
    (globalThis as any).UNIQUE_SHOW_COUNT ?? 0,
    uniqueShowCount,
  );

  const showIdMap = new Map<string, number>();
  let showIdCounter = 0;

  for (const row of rows) {

    const observedPriorShowCount = row.seqMask.filter(Boolean).length;
    const { hideForecastContext, hideLineupContext, hideJudges, hideHistory } = selectV95Masking(
      rng,
      observedPriorShowCount,
      {
        history: historyHideRate,
        judges: judgeHideRate,
        forecastContext: forecastContextHideRate,
        lineup: lineupHideRate,
      },
    );
    const truncationCount = thinHistoryTruncationRate > 0 && observedPriorShowCount > 3 &&
      rng() < thinHistoryTruncationRate
      ? 1 + Math.floor(rng() * 3)
      : null;
    let sourceSeq = row.seq;
    let sourceMask = row.seqMask;
    if (truncationCount !== null) {
      const validIndices = row.seqMask.flatMap((valid, index) => valid ? [index] : []);
      const retained = new Set(validIndices.slice(-truncationCount));
      sourceSeq = row.seq.map((step, index) => retained.has(index) ? step : new Array(FEAT_DIM).fill(0));
      sourceMask = row.seqMask.map((_valid, index) => retained.has(index));
    }
    const slicedSeq = hideHistory ? [] : sourceSeq.slice(-seqLen);
    const slicedMask = hideHistory ? [] : sourceMask.slice(-seqLen).map((v) => (v ? 1 : 0));

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

    const forecastBaselineRaw = buildForecastBaseline(row.stat, stats.recapMean);
    const baselineRawVector = row.globalBaseline;
    const baselineNormVector: number[] = [];

    const baselineInputRaw = hideForecastContext
      ? [...forecastBaselineRaw]
      : hideHistory
        ? stats.recapMean.map((value) => value ?? 0)
        : lastScoreBaseline
          ? [...lastScoreBaseline]
          : [...baselineRawVector];
    if (lastScoreBaseline) {
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        if (baselineInputRaw[idx] === 0) {
          baselineInputRaw[idx] = baselineRawVector[idx] ?? stats.recapMean[idx] ?? 0;
        }
      }
    }
    const effectiveSameSeasonHistoryCount = truncationCount ??
      Math.max(0, Math.round((row.stat[COLD_START_STATIC_OFFSET + 1] ?? 0) * 40));
    const thinBaselineApplied = thinHistoryBaselineBlend && !hideForecastContext && !hideHistory &&
      lastScoreBaseline !== null && effectiveSameSeasonHistoryCount >= 1 && effectiveSameSeasonHistoryCount <= 3;
    if (thinBaselineApplied && lastScoreBaseline) {
      const blended = blendThinHistoryBaseline(
        lastScoreBaseline,
        forecastBaselineRaw,
        effectiveSameSeasonHistoryCount,
      );
      for (let idx = 0; idx < CAPTION_COUNT; idx++) baselineInputRaw[idx] = blended[idx] ?? baselineInputRaw[idx]!;
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
    const historyLen = hideHistory ? 0 : Math.max(0, validSteps.length - 1);

    const trendFeatures = hideHistory ? new Array(CAPTION_COUNT).fill(0) : row.trendSlopes;
    let staticFeatures = [...row.stat];
    if (truncationCount !== null && !hideHistory) {
      const retainedSteps = slicedSeq.filter((_, index) => slicedMask[index] === 1);
      const lastStep = retainedSteps.at(-1);
      const residuals = retainedSteps.flatMap((step) => CAPTIONS.map((_, captionIndex) =>
        step[RECAP_OFFSET_IN_FEATS + captionIndex * CAPTION_STRIDE] ?? 0
      ));
      maskV9ThinHistoryContext(staticFeatures, truncationCount, {
        lastRankNorm: lastStep?.[11],
        residualMean: residuals.length ? residuals.reduce((sum, value) => sum + value, 0) / residuals.length : 0,
      });
    }
    if (hideHistory) {
      staticFeatures[COLD_START_STATIC_OFFSET] = 0;
      staticFeatures[COLD_START_STATIC_OFFSET + 1] = 0;
      staticFeatures[COLD_START_STATIC_OFFSET + 2] = 1;
      staticFeatures[COLD_START_STATIC_OFFSET + 9] =
        staticFeatures[COLD_START_STATIC_OFFSET + 9] ?? 0;
    }
    if (hideForecastContext) {
      staticFeatures = applyV9PredictionContextMode(staticFeatures, {
        mode: "preseason_forecast",
        seedRank: (row.stat[COLD_START_STATIC_OFFSET + 5] ?? 0) > 0
          ? (row.stat[COLD_START_STATIC_OFFSET + 5] ?? 0) * 25
          : undefined,
        recapMean: forecastBaselineRaw,
      });
    } else if (hideLineupContext) {
      staticFeatures = applyV9PredictionContextMode(staticFeatures, {
        mode: "lineup_unknown",
      });
    }
    if (hideJudges) {
      maskV9JudgeContext(staticFeatures);
    }

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


    const corpsTrust = SUPPORT_AWARE_IDENTITY ? row.corpsSupportTrust : 1;
    const applySupportAugmentation = supportAugmentationEnabled(
      SUPPORT_AWARE_IDENTITY,
      identityDropoutRate,
    );
    const effectiveIdentityDropout = applySupportAugmentation
      ? supportAdjustedDropout(identityDropoutRate, corpsTrust, SUPPORT_DROPOUT_STRENGTH)
      : identityDropoutRate;
    const corpsId = rng() < effectiveIdentityDropout ? UNK_CORPS_ID : row.corpsId;
    const showId = (() => {
      const existing = showIdMap.get(row.showKey);
      if (existing !== undefined) return existing;
      const next = showIdCounter++;
      showIdMap.set(row.showKey, next);
      return next;
    })();

    const showTrust = SUPPORT_AWARE_IDENTITY ? row.showSupportTrust : 1;
    const showDropout = applySupportAugmentation
      ? supportAdjustedDropout(0.2, showTrust, SUPPORT_DROPOUT_STRENGTH)
      : 0.2;
    const agnosticShowId = hideForecastContext || rng() < showDropout ? 0 : row.agnosticShowId;
    const judgeIndices = hideJudges
      ? new Array(CAPTION_COUNT).fill(0)
      : row.judgeIndices.map((index, slot) => {
          if (!applySupportAugmentation || index === 0) return index;
          const trust = row.judgeSupportTrust[slot] ?? 0;
          const dropout = SUPPORT_DROPOUT_STRENGTH * (1 - trust) * 0.5;
          return rng() < dropout ? 0 : index;
        });
    const retainedJudgeTrust = judgeIndices.flatMap((index, slot) =>
      index > 0 ? [row.judgeSupportTrust[slot] ?? 0] : []
    );
    const sourceJudgeTrust = row.judgeIndices.flatMap((index, slot) =>
      index > 0 ? [row.judgeSupportTrust[slot] ?? 0] : []
    );
    const judgeTrust = SUPPORT_AWARE_IDENTITY
      ? retainedJudgeTrust.length
        ? retainedJudgeTrust.reduce((sum, value) => sum + value, 0) / retainedJudgeTrust.length
        : 0
      : 1;
    const corpsResidualGate = SUPPORT_AWARE_IDENTITY
      ? supportResidualGate(corpsTrust, corpsId > 0)
      : 1;
    const judgeResidualGate = SUPPORT_AWARE_IDENTITY
      ? supportResidualGate(judgeTrust, retainedJudgeTrust.length > 0)
      : 1;

    samples.push({
      xs: [
        slicedSeq,
        [...staticFeatures, ...trendFeatures, ...row.contextFeatures],
        slicedMask,
        judgeIndices,
        corpsId,
        baselineNormVector,
        historyLen,
        showId,
        agnosticShowId,
        corpsResidualGate,
        judgeResidualGate,
      ],
      ys: [...deltaTargets, ...recapValues, ...categoryTargets, normalizedTotal],
      meta: {
        season: row.season,
        date: row.date,
        showKey: row.showKey,
        competitionSlug: row.competitionSlug,
        corpsKey: row.corpsKey,
        corpsId: row.corpsId,
        division: row.division,
        split: row.split,
        total: row.total,
        historyLen,
        judgeKnown: !hideJudges && row.judgeIndices.every((idx) => idx > 0),
        historyHidden: hideHistory,
        historyTruncated: truncationCount !== null,
        sameSeasonHistoryCount: effectiveSameSeasonHistoryCount,
        thinBaselineBlended: thinBaselineApplied,
        corpsSupportTrust: row.corpsSupportTrust,
        judgeSupportTrust: sourceJudgeTrust.length
          ? sourceJudgeTrust.reduce((sum, value) => sum + value, 0) / sourceJudgeTrust.length
          : 0,
        showSupportTrust: row.showSupportTrust,
        corpsIdentityMode: identityAvailabilityMode({
          sourceKnown: row.corpsId > 0,
          inputKnown: corpsId > 0,
          explicitlyHidden: false,
        }),
        judgeIdentityMode: identityAvailabilityMode({
          sourceKnown: row.judgeIndices.every((index) => index > 0),
          inputKnown: judgeIndices.every((index) => index > 0),
          explicitlyHidden: hideJudges,
        }),
        showIdentityMode: identityAvailabilityMode({
          sourceKnown: row.agnosticShowId > 0,
          inputKnown: agnosticShowId > 0,
          explicitlyHidden: hideForecastContext,
        }),
        forecastContextHidden: hideForecastContext,
        lineupContextHidden: hideLineupContext,
        seasonDebut: (staticFeatures[COLD_START_STATIC_OFFSET] ?? 0) >= 0.5,
        firstSeasonEvent: (staticFeatures[COLD_START_STATIC_OFFSET + 6] ?? 0) >= 0.5,
      },
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
      judge_bias_scale: tf.tensor([sample.xs[10]], [1], "float32"),
      corps_scale: tf.tensor([sample.xs[9]], [1], "float32"),
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
let agnosticShowIdBuffer: Int32Array | null = null;
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
    agnosticShowIdBuffer = new Int32Array(batchSize);
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
  const agnosticShowIdData = agnosticShowIdBuffer!.subarray(0, batchSize);
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
      judge_bias_scale: tf.tensor2d(
        batchSamples.map((sample) => [scales.judgeBias * sample.xs[10]]),
        [batchSize, 1],
        "float32",
      ),
      corps_scale: tf.tensor2d(
        batchSamples.map((sample) => [scales.corps * sample.xs[9]]),
        [batchSize, 1],
        "float32",
      ),
    },

    ys: tf.tensor2d(ysData, [batchSize, TARGET_DIM], "float32"),
  };
}

type SampleGroup = Sample[];

function groupSamplesByShow(samples: Sample[]): SampleGroup[] {
  const showMap = new Map<number, Sample[]>();
  for (const sample of samples) {
    const showId = sample.xs[7];
    const bucket = showMap.get(showId) ?? [];
    bucket.push(sample);
    showMap.set(showId, bucket);
  }

  return Array.from(showMap.values());
}

function* batchGeneratorFromGroups(showGroups: SampleGroup[], batchSize: number, shuffle: boolean, seed: number, scales: { judgeBias: number, corps: number }): Generator<{ xs: BatchedInputs; ys: tf.Tensor; samples: Sample[] }> {
  const rng = seededRandom(seed);
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

function* batchGenerator(samples: Sample[], batchSize: number, shuffle: boolean, seed: number, scales: { judgeBias: number, corps: number }): Generator<{ xs: BatchedInputs; ys: tf.Tensor; samples: Sample[] }> {
  yield* batchGeneratorFromGroups(groupSamplesByShow(samples), batchSize, shuffle, seed, scales);
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
  for (const [flag, value] of [["--judge-count", args.judgeCount], ["--corps-count", args.corpsCount], ["--show-count", args.showCount]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`);
  }
  JUDGE_COUNT = args.judgeCount;
  CORPS_COUNT = args.corpsCount;
  SHOW_COUNT = args.showCount;
  SUPPORT_AWARE_IDENTITY = args.supportAwareIdentity;
  SUPPORT_DROPOUT_STRENGTH = args.supportDropoutStrength;
  if (!Number.isFinite(SUPPORT_DROPOUT_STRENGTH) || SUPPORT_DROPOUT_STRENGTH < 0 || SUPPORT_DROPOUT_STRENGTH > 1) {
    throw new Error("--support-dropout-strength must be in [0,1]");
  }
  if (SUPPORT_AWARE_IDENTITY) {
    if (!args.identitySupportPath) throw new Error("--support-aware-identity requires --identity-support");
    loadV10IdentitySupport(args.identitySupportPath, args.judgeMapPath, args.showMapPath);
  }
  if (args.lrSchedule !== "cosine" && args.lrSchedule !== "phase-aware") {
    throw new Error(`Unknown learning-rate schedule '${args.lrSchedule}'.`);
  }
  if (!Number.isInteger(args.sequenceTransitionEpochs) || args.sequenceTransitionEpochs < 0) {
    throw new Error("--sequence-transition-epochs must be a non-negative integer");
  }
  for (const [flag, value] of [
    ["--thin-history-sample-fraction", args.thinHistorySampleFraction],
    ["--thin-history-truncation-rate", args.thinHistoryTruncationRate],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${flag} must be in [0,1]`);
  }
  if (args.reproductionContract && args.reproductionContract !== "final2") {
    throw new Error(`Unknown reproduction contract '${args.reproductionContract}'.`);
  }
  if (args.reproductionContract === "final2") {
    if (JUDGE_COUNT !== 245 || CORPS_COUNT !== 709 || SHOW_COUNT !== 349) {
      throw new Error("final2 reproduction requires embedding input dimensions 245/709/349");
    }
    if (args.maxRows !== undefined || args.divisionFilter.toLowerCase() !== "all") {
      throw new Error("final2 reproduction forbids --maxRows and division filtering");
    }
    if (args.valMode !== "date-forward" || args.valSplit !== 0.05 || args.valDateCutoff) {
      throw new Error("final2 reproduction requires date-forward validation at valSplit=0.05");
    }
    if (args.thinHistorySampleFraction !== 0 || args.thinHistoryTruncationRate !== 0 || args.thinHistoryBaselineBlend) {
      throw new Error("final2 reproduction forbids thin-history treatments");
    }
    if (args.supportAwareIdentity) throw new Error("final2 reproduction forbids support-aware identity treatment");
    await verifyFinal2SourceDatabase(args.dbPath);
  }
  await tf.setBackend("tensorflow");
  const seedrandom = (tf.util as unknown as { seedrandom?: (seed: string) => void }).seedrandom;
  if (seedrandom) {
    seedrandom(args.seed.toString());
  }
  try {
    tf.env().set("DETERMINISTIC", true);
  } catch {
  }

  const client = createClient({ url: `file:${args.dbPath}` });
  if (!/^ml_sequence_rows_v(?:9_subcaption|10_(?:clean_control|field_pace|thin_history|final))$/.test(args.mlTable)) {
    throw new Error(`Unsupported ML table '${args.mlTable}'.`);
  }
  console.log("Loading V9 sequence data...");


  const result = await client.execute(`
    SELECT season, competition_slug, competition_date, corps_key, corps_id, x_sequence_json, x_static_json, judge_indices_json, y_residuals_json, y_recap_json, y_total, agnostic_show_id, division_name, split
    FROM ${args.mlTable}

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
    y_total: number;
    agnostic_show_id: number;
    division_name: string;
    split: string;
  }>;
  client.close();

  const loadedDataRows = buildDataRows(rawRows);
  const maxJudgeId = Math.max(0, ...loadedDataRows.flatMap((row) => row.judgeIndices));
  const maxCorpsId = Math.max(0, ...loadedDataRows.map((row) => row.corpsId));
  const maxShowId = Math.max(0, ...loadedDataRows.map((row) => row.agnosticShowId));
  if (maxJudgeId >= JUDGE_COUNT || maxCorpsId >= CORPS_COUNT || maxShowId >= SHOW_COUNT) {
    throw new Error(
      `final2 embedding contract exceeded: judge=${maxJudgeId}/${JUDGE_COUNT - 1}, ` +
      `corps=${maxCorpsId}/${CORPS_COUNT - 1}, show=${maxShowId}/${SHOW_COUNT - 1}`,
    );
  }
  (globalThis as any).UNIQUE_SHOW_COUNT = SHOW_COUNT;
  const divisionFilter = args.divisionFilter.toLowerCase();
  const allDataRows = divisionFilter === "all"
    ? loadedDataRows
    : loadedDataRows.filter((row) => row.division.toLowerCase() === divisionFilter);
  if (!allDataRows.length) {
    throw new Error(`No rows remain after --division-filter ${args.divisionFilter}`);
  }
  if (divisionFilter !== "all") {
    console.log(
      `Division filter '${args.divisionFilter}': ${allDataRows.length}/${loadedDataRows.length} rows retained.`,
    );
  }
  const nonTestRows = allDataRows.filter((row) => row.split !== "test");

  const testRows = allDataRows.filter((row) => row.split === "test");

  const { trainRows, valRows, resolvedMode } = splitValidationRows(nonTestRows, args);
  console.log(
    `Validation split (${resolvedMode}) grouped by show/date: ` +
    `${trainRows.length} train rows, ${valRows.length} validation rows.`,
  );
  if (args.reproductionContract === "final2") {
    verifyFinal2Population(loadedDataRows, trainRows, valRows, testRows);
  }

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
  fs.writeFileSync(args.normPath, JSON.stringify(stats, null, 2));
  console.log(`Saved normalization stats to ${args.normPath}`);

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
  const runDir = path.join(args.modelDir, runId);
  const bestDir = path.join(runDir, "best");
  const bestLossDir = path.join(runDir, "best_loss");
  const bestTotalDir = path.join(runDir, "best_total");
  const bestCompositeDir = path.join(runDir, "best_composite");
  const bestPhaseDirs = {
    A: path.join(runDir, "best_phase_a"),
    B: path.join(runDir, "best_phase_b"),
    C: path.join(runDir, "best_phase_c"),
  } as const;
  let bestSavedEpoch = -1;
  let bestLossSavedEpoch = -1;
  let bestTotalSavedEpoch = -1;
  let bestCompositeSavedEpoch = -1;
  const bestPhaseSavedEpoch = { A: -1, B: -1, C: -1 };

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "training-args.json"), JSON.stringify(args, null, 2));
  snapshotV95TrainingSource(runDir, { argv: process.argv.slice(2) });

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

  const saveCheckpoint = async (
    modelToSave: tf.LayersModel,
    destination: string,
    metadata: Record<string, unknown>,
  ) => {
    const temporary = `${destination}_tmp`;
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
    await saveModel(modelToSave, temporary);
    fs.writeFileSync(
      path.join(temporary, "best-meta.json"),
      JSON.stringify({ ...metadata, savedAt: new Date().toISOString() }, null, 2),
    );
    if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temporary, destination);
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
      units: args.dense1Units,
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
    })
    .apply(concat) as tf.SymbolicTensor;

  const d1Drop = tf.layers.dropout({ rate: args.dropoutDense1 }).apply(d1) as tf.SymbolicTensor;

  const d2 = tf.layers
    .dense({
      units: args.dense2Units,
      activation: "relu",
      kernelRegularizer: tf.regularizers.l2({ l2: args.l2Reg }),
    })
    .apply(d1Drop) as tf.SymbolicTensor;

  const d2Drop = tf.layers.dropout({ rate: args.dropoutDense2 }).apply(d2) as tf.SymbolicTensor;

  const strength = tf.layers.dense({ units: 24, activation: "relu", name: "strength" }).apply(contextFlat) as tf.SymbolicTensor; // IMPROVED: 16->24

  const skipConcat = tf.layers.concatenate().apply([d2Drop, staticInput, strength]) as tf.SymbolicTensor;

  // FIXED: Dedicated accuracy trunk with separate gradients from width/uncertainty
  const accuracyTrunk = tf.layers.dense({
    units: args.accuracyTrunkUnits,
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
  console.log(formatV95ModelCapacity(args));
  console.log(
    `Feature Contract: sequence_dim=${FEAT_DIM}, raw_static_dim=${RAW_STATIC_DIM}, ` +
    `trend_dim=${TREND_DIM}, context_dim=${CONTEXT_DIM}, total_static_dim=${TOTAL_STATIC_DIM}`,
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
  let bestLossWeights: tf.Tensor[] | null = null;
  let bestTotalWeights: tf.Tensor[] | null = null;
  let bestCompositeWeights: tf.Tensor[] | null = null;
  const bestPhaseWeights: Record<"A" | "B" | "C", tf.Tensor[] | null> = {
    A: null,
    B: null,
    C: null,
  };
  let bestDeltaMae = Number.POSITIVE_INFINITY;
  let bestValLoss = Number.POSITIVE_INFINITY;
  let bestTotalMae = Number.POSITIVE_INFINITY;
  let bestCompositeScore = Number.POSITIVE_INFINITY;
  const bestPhaseDeltaMae = { A: Number.POSITIVE_INFINITY, B: Number.POSITIVE_INFINITY, C: Number.POSITIVE_INFINITY };
  let patience = 0;
  let currentBaseLR = args.learningRate;
  let currentLR = args.learningRate;
  let plateauLrMultiplier = 1;
  let epochsSinceImprovement = 0;

  const scheduler = new V9LossScheduler({
    phaseAEnd: args.curriculumPhaseAEnd,
    phaseBEnd: args.curriculumPhaseBEnd,
    phaseCRamp: args.curriculumPhaseCRamp,
    corpsScaleStart: args.corpsScaleStart,
    corpsScaleRamp: args.corpsScaleRamp,
    judgeScaleRamp: args.judgeScaleRamp,
    identityDropoutFloor: args.identityDropoutFloor,
  });
  const provider = new SequenceDataProviderV9(
    trainSubset,
    args.startEpoch,
    args.batchSize,
    scheduler.getPhaseAEnd(),
    args.sequenceTransitionEpochs,
    args.openSampleFraction,
    args.thinHistorySampleFraction,
  );
  const autoCurriculumConfig: AutoCurriculumConfig = {
    phaseAEnd: scheduler.getPhaseAEnd(),
    phaseBEnd: scheduler.getPhaseBEnd(),
    auto: args.autoCurriculum,
    patience: args.autoCurriculumPatience,
    minCoverage: args.autoCurriculumMinCoverage,
    minDeltaGain: args.autoCurriculumMinDeltaGain,
    phaseAMin: args.autoCurriculumPhaseAMin,
    phaseBMin: args.autoCurriculumPhaseBMin,
  };
  let curriculumState = initialCurriculumState(autoCurriculumConfig, args.startEpoch);
  const curriculumTransitions: CurriculumTransition[] = [];

  console.log(formatV95Curriculum(args));


  const cachedValSamples = buildSamples(
    valSubset, stats, 15, 0.0, args.seed + 999,
    0, 0, 0, 0, 0, 0, 0, 0, args.thinHistoryBaselineBlend,
  );

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
    const phaseAtEpochStart = scheduler.getPhase(epoch);
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
      args.baselineNoiseStd,
      args.historyHideRate,
      args.judgeHideRate,
      args.forecastContextHideRate,
      0,
      args.thinHistoryTruncationRate,
      args.thinHistoryBaselineBlend,
    );

    const dropRate = guardrailCheck(epochSamples, weights.identityDropoutRate);
    const thinDiagnostics = {
      sampled: epochSamples.filter((sample) => sample.meta.sameSeasonHistoryCount <= 3).length,
      truncated: epochSamples.filter((sample) => sample.meta.historyTruncated).length,
      blended: epochSamples.filter((sample) => sample.meta.thinBaselineBlended).length,
    };
    const supportDiagnostics = {
      corps_trust_mean: epochSamples.reduce((sum, sample) => sum + sample.meta.corpsSupportTrust, 0) / Math.max(1, epochSamples.length),
      judge_trust_mean: epochSamples.reduce((sum, sample) => sum + sample.meta.judgeSupportTrust, 0) / Math.max(1, epochSamples.length),
      show_trust_mean: epochSamples.reduce((sum, sample) => sum + sample.meta.showSupportTrust, 0) / Math.max(1, epochSamples.length),
      corps_gate_mean: epochSamples.reduce((sum, sample) => sum + sample.xs[9], 0) / Math.max(1, epochSamples.length),
      judge_gate_mean: epochSamples.reduce((sum, sample) => sum + sample.xs[10], 0) / Math.max(1, epochSamples.length),
    };

    const currentWidthFloorWeight = scheduler.getWidthFloorWeight(epoch, args.widthFloorStart, args.widthFloorEnd);
    console.log(
      `\nEpoch ${epoch}: Phase ${phaseAtEpochStart} ` +
      `(A_end=${scheduler.getPhaseAEnd()}, B_end=${scheduler.getPhaseBEnd()}, ` +
      `C_ramp=${args.curriculumPhaseCRamp}) Weights ${JSON.stringify(weights)}, ` +
      `Scales ${JSON.stringify(scales)}, SeqLen ${seqLen}, ID_Drop ${dropRate.toFixed(3)}, ` +
      `WFW ${currentWidthFloorWeight.toFixed(3)}, Thin ${JSON.stringify(thinDiagnostics)}, ` +
      `Support ${JSON.stringify(supportDiagnostics)} `,
    );

    currentBaseLR = args.lrSchedule === "phase-aware"
      ? phaseAwareBaseLearningRate(
          epoch,
          args.epochs,
          args.warmupEpochs,
          scheduler.getPhaseBEnd(),
          args.learningRate,
          args.minLr,
        )
      : cosineBaseLearningRate(
          epoch,
          args.epochs,
          args.warmupEpochs,
          args.learningRate,
          args.minLr,
        );
    currentLR = effectiveLearningRate(currentBaseLR, plateauLrMultiplier, args.minLr);
    setLearningRate(currentLR);

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
      valLoss: 0,
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


      const valLoss = valCountTotal ? valLossSum / valCountTotal : 0;
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

      const widthExcess = Math.max(0, widthNorm - args.widthTargetPts);
      const widthPenaltyScore = widthExcess * args.widthPenaltyWeight;

      let valScore: number;
      if (scheduler.getPhase(epoch) !== "C") {
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
        valLoss,
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
      const snapshotDir = path.join(args.modelDir, runId, `snapshot_${epoch + 1} `);
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

    const phaseForCheckpoint = phaseAtEpochStart;
    const decisions = checkpointDecisions(
      monitoringStats,
      {
        delta: bestDeltaMae,
        loss: bestValLoss,
        total: bestTotalMae,
        composite: bestCompositeScore,
        phaseDelta: bestPhaseDeltaMae[phaseForCheckpoint],
      },
      args.coverageTarget,
      args.coverageUpperTarget,
      initialValSamples.length > 0,
    );
    const replaceWeights = (existing: tf.Tensor[] | null) => {
      existing?.forEach((tensor) => tensor.dispose());
      return model.getWeights().map((tensor) => tensor.clone());
    };

    if (decisions.delta) {
      bestDeltaMae = monitoringStats.valDeltaMae;
      bestWeights = replaceWeights(bestWeights);
      if (epoch !== bestSavedEpoch) {
        await saveCheckpoint(model, bestDir, {
          epoch,
          checkpointMetric: "valDeltaMae",
          bestDeltaMae,
          monitoring: monitoringStats,
        });
        bestSavedEpoch = epoch;
        console.log(`Saved BEST checkpoint @epoch ${epoch} delta_mae_pts = ${bestDeltaMae.toFixed(4)} -> ${bestDir}`);
      }
    }
    if (decisions.loss) {
      bestValLoss = monitoringStats.valLoss;
      bestLossWeights = replaceWeights(bestLossWeights);
      if (epoch !== bestLossSavedEpoch) {
        await saveCheckpoint(model, bestLossDir, {
          epoch,
          checkpointMetric: "valLoss",
          bestValLoss,
          monitoring: monitoringStats,
        });
        bestLossSavedEpoch = epoch;
        console.log(`Saved BEST-LOSS checkpoint @epoch ${epoch} val_loss = ${bestValLoss.toFixed(6)} -> ${bestLossDir}`);
      }
    }
    if (decisions.total) {
      bestTotalMae = monitoringStats.valTotalMae;
      bestTotalWeights = replaceWeights(bestTotalWeights);
      if (epoch !== bestTotalSavedEpoch) {
        await saveCheckpoint(model, bestTotalDir, {
          epoch,
          checkpointMetric: "valTotalMae",
          bestTotalMae,
          monitoring: monitoringStats,
        });
        bestTotalSavedEpoch = epoch;
        console.log(`Saved BEST-TOTAL checkpoint @epoch ${epoch} total_mae_pts = ${bestTotalMae.toFixed(4)} -> ${bestTotalDir}`);
      }
    }
    if (decisions.compositeImproved) {
      bestCompositeScore = decisions.composite;
      bestCompositeWeights = replaceWeights(bestCompositeWeights);
      if (epoch !== bestCompositeSavedEpoch) {
        await saveCheckpoint(model, bestCompositeDir, {
          epoch,
          checkpointMetric: "productionComposite",
          bestCompositeScore,
          monitoring: monitoringStats,
        });
        bestCompositeSavedEpoch = epoch;
        console.log(
          `Saved BEST-COMPOSITE checkpoint @epoch ${epoch} score = ${bestCompositeScore.toFixed(4)} ` +
          `delta_mae_pts = ${monitoringStats.valDeltaMae.toFixed(4)} ` +
          `total_mae_pts = ${monitoringStats.valTotalMae.toFixed(4)} -> ${bestCompositeDir}`,
        );
      }
    }
    if (decisions.phase) {
      bestPhaseDeltaMae[phaseForCheckpoint] = monitoringStats.valDeltaMae;
      bestPhaseWeights[phaseForCheckpoint] = replaceWeights(bestPhaseWeights[phaseForCheckpoint]);
      if (epoch !== bestPhaseSavedEpoch[phaseForCheckpoint]) {
        await saveCheckpoint(model, bestPhaseDirs[phaseForCheckpoint], {
          epoch,
          phase: phaseForCheckpoint,
          checkpointMetric: "valDeltaMae",
          bestPhaseDeltaMae: bestPhaseDeltaMae[phaseForCheckpoint],
          monitoring: monitoringStats,
        });
        bestPhaseSavedEpoch[phaseForCheckpoint] = epoch;
        console.log(
          `Saved BEST-PHASE-${phaseForCheckpoint} checkpoint @epoch ${epoch} ` +
          `delta_mae_pts = ${bestPhaseDeltaMae[phaseForCheckpoint].toFixed(4)} -> ` +
          `${bestPhaseDirs[phaseForCheckpoint]}`,
        );
      }
    }

    const monitorImproved = monitoringStats.valScore < bestScore - 1e-4;
    if (monitorImproved || !initialValSamples.length) {
      bestScore = monitoringStats.valScore;
      patience = 0;
      epochsSinceImprovement = 0;
    } else {
      patience += 1;
      epochsSinceImprovement += 1;
    }

    const curriculumStep = stepCurriculum(
      curriculumState,
      autoCurriculumConfig,
      epoch,
      { valDeltaMae: monitoringStats.valDeltaMae, coverage: monitoringStats.coverage },
    );
    curriculumState = curriculumStep.state;
    const curriculumAdvanced = curriculumStep.transition !== null;
    const status = curriculumStep.status;
    if (status.phase === "C") {
      console.log(
        `[curriculum] phase=C age=${status.age} ramp=${args.curriculumPhaseCRamp} ` +
        `delta=${monitoringStats.valDeltaMae.toFixed(4)} ` +
        `cov=${monitoringStats.coverage.toFixed(3)} ` +
        `best_global_delta=n/a`,
      );
    } else {
      const phaseSpan = status.phase === "A"
        ? scheduler.getPhaseAEnd()
        : scheduler.getPhaseBEnd() - scheduler.getPhaseAEnd();
      const next = curriculumStep.transition
        ? curriculumStep.transition.reason === "max_epoch" ? "advance:max" : "advance:plateau"
        : "hold";
      console.log(
        `[curriculum] phase=${status.phase} age=${status.age}/${phaseSpan} ` +
        `delta=${monitoringStats.valDeltaMae.toFixed(4)} ` +
        `phase_best=${Number.isFinite(status.bestDelta) ? status.bestDelta.toFixed(4) : "n/a"} ` +
        `stall=${status.stalledEpochs}/${autoCurriculumConfig.patience} ` +
        `cov=${monitoringStats.coverage.toFixed(3)}/${autoCurriculumConfig.minCoverage.toFixed(3)} ` +
        `min=${status.minReached ? "ok" : "wait"} ` +
        `cov_gate=${status.coverageOk ? "ok" : "wait"} next=${next}`,
      );
    }
    if (curriculumStep.transition) {
      curriculumTransitions.push(curriculumStep.transition);
      if (curriculumStep.transition.from === "A") {
        scheduler.setPhaseAEnd(curriculumStep.transition.epoch);
        provider.setLongSequenceStartEpoch(curriculumStep.transition.epoch);
      } else {
        scheduler.setPhaseBEnd(curriculumStep.transition.epoch);
      }
      bestScore = Number.POSITIVE_INFINITY;
      patience = 0;
      epochsSinceImprovement = 0;
      plateauLrMultiplier = 1;
      console.log(
        `[curriculum] ${curriculumStep.transition.from}->${curriculumStep.transition.to} ` +
        `at epoch ${curriculumStep.transition.epoch} reason=${curriculumStep.transition.reason} ` +
        `delta=${curriculumStep.transition.deltaMae.toFixed(4)} ` +
        `coverage=${curriculumStep.transition.coverage.toFixed(3)}`,
      );
    }

    if (!curriculumAdvanced && !monitorImproved) {
      if (epochsSinceImprovement >= args.reduceLrPatience && currentLR > args.minLr) {
        const previousMultiplier = plateauLrMultiplier;
        plateauLrMultiplier *= args.plateauLrFactor;
        currentLR = effectiveLearningRate(currentBaseLR, plateauLrMultiplier, args.minLr);
        setLearningRate(currentLR);
        console.log(
          `\n--- NO MONITOR IMPROVEMENT FOR ${args.reduceLrPatience} EPOCHS: ` +
          `plateau multiplier ${previousMultiplier.toFixed(4)} -> ${plateauLrMultiplier.toFixed(4)}, ` +
          `effective LR ${currentLR.toFixed(6)} ---`,
        );
        epochsSinceImprovement = 0;
      }

      if (patience >= args.patience) {
        console.log(`Early stopping at epoch ${epoch} `);
        break;
      }
    }
  }

  const finalWeightsMode = selectFinalWeightsMode(args.finalWeights, {
    swa: Boolean(args.swa && swaWeights),
    composite: Boolean(bestCompositeWeights),
    total: Boolean(bestTotalWeights),
    loss: Boolean(bestLossWeights),
    delta: Boolean(bestWeights),
  });
  const selectedWeights = finalWeightsMode === "swa"
    ? swaWeights
    : finalWeightsMode === "composite"
      ? bestCompositeWeights
      : finalWeightsMode === "total"
        ? bestTotalWeights
        : finalWeightsMode === "loss"
          ? bestLossWeights
          : finalWeightsMode === "delta"
            ? bestWeights
            : null;
  if (selectedWeights) model.setWeights(selectedWeights);
  console.log(`Selecting final weights: ${finalWeightsMode}`);

  const allCheckpointWeights = [
    swaWeights,
    bestWeights,
    bestLossWeights,
    bestTotalWeights,
    bestCompositeWeights,
    ...Object.values(bestPhaseWeights),
  ];
  const disposed = new Set<tf.Tensor>();
  for (const weights of allCheckpointWeights) {
    for (const tensor of weights ?? []) {
      if (!disposed.has(tensor)) {
        tensor.dispose();
        disposed.add(tensor);
      }
    }
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

  const namedEvalRows = buildFinal2EvaluationRows(valSubset, testRows, COLD_START_STATIC_OFFSET);

  console.log("\n--- INTERVAL CALIBRATION: validation grid search ---");
  const validationSamplesForCalibration = buildSamples(
    valSubset, stats, SEQ_LEN, 0, 41,
    0, 0, 0, 0, 0, 0, 0, 0, args.thinHistoryBaselineBlend,
  );
  const intervalCalibration = calibrateIntervalScale(
    model, validationSamplesForCalibration, stats, args,
  );
  const calibratedIntervalScale = intervalCalibration.selected?.scale ?? 1;
  console.log(
    `Selected interval scale=${calibratedIntervalScale.toFixed(3)} ` +
    `coverage=${(intervalCalibration.selected?.coverage ?? 0).toFixed(3)} ` +
    `width=${(intervalCalibration.selected?.width ?? 0).toFixed(4)}`,
  );

  const evalReports = Object.entries(namedEvalRows)
    .filter(([, rows]) => rows.length > 0)
    .map(([label, rows], index) => {
      console.log(`\n--- EVALUATION: ${label} (${rows.length} rows) ---`);
      const rates = evaluationMaskRates(label);
      const samples = buildSamples(
        rows, stats, SEQ_LEN, 0, 42 + index, 0, 0, 0,
        rates.history, rates.judges, rates.forecastContext, rates.lineup,
        0, args.thinHistoryBaselineBlend,
      );
      const raw = evaluateSamples(model, samples, stats, args, label, 42 + index);
      const calibrated = evaluateSamples(
        model, samples, stats, args, `${label}_calibrated`, 142 + index,
        calibratedIntervalScale,
      );
      console.log(
        `${label}: delta_mae_pts=${raw.metrics.delta_mae_pts.toFixed(4)}, ` +
        `recap_mae_pts=${raw.metrics.recap_mae_pts.toFixed(4)}, ` +
        `total_mae_pts=${raw.metrics.total_mae_pts.toFixed(4)}, ` +
        `coverage=${raw.metrics.coverage.toFixed(3)}, width=${raw.metrics.width.toFixed(4)}, ` +
        `cal_coverage=${calibrated.metrics.coverage.toFixed(3)}, ` +
        `cal_width=${calibrated.metrics.width.toFixed(4)}`,
      );
      return { ...raw, calibrated };
    });

  const splitDefinition = {
    val_mode: resolvedMode,
    val_split: args.valSplit,
    val_date_cutoff: args.valDateCutoff ?? null,
    division_filter: args.divisionFilter,
    loaded_rows: loadedDataRows.length,
    retained_rows: allDataRows.length,
    train_rows: trainRows.length,
    validation_rows: valRows.length,
    test_rows: testRows.length,
    train_shows: new Set(trainRows.map((row) => row.showKey)).size,
    validation_shows: new Set(valRows.map((row) => row.showKey)).size,
    test_shows: new Set(testRows.map((row) => row.showKey)).size,
    validation_date_min: valRows.map((row) => row.date).sort()[0] ?? null,
    validation_date_max: valRows.map((row) => row.date).sort().at(-1) ?? null,
  };
  const evaluations = Object.fromEntries(evalReports.map((entry) => [entry.label, entry]));
  const validationRecapMae = evaluations.validation?.metrics?.recap_mae_pts ?? null;
  const baselineSummary = {
    validation_monitoring_forecast_mae: {
      zero: baselines.baselineZero,
      mean: baselines.baselineMean,
      ema: baselines.baselineEma,
      quadratic: baselines.baselineQuad,
    },
    final_validation_recap_mae: validationRecapMae,
    final_validation_vs_inertia_pts: validationRecapMae == null
      ? null
      : baselines.baselineEma - validationRecapMae,
    final_validation_vs_quadratic_pts: validationRecapMae == null
      ? null
      : baselines.baselineQuad - validationRecapMae,
  };
  const checkpoints = {
    final_selection: { mode: finalWeightsMode },
    best_delta: { metric: "valDeltaMae", value: bestDeltaMae, dir: bestDir },
    best_loss: { metric: "valLoss", value: bestValLoss, dir: bestLossDir },
    best_total: { metric: "valTotalMae", value: bestTotalMae, dir: bestTotalDir },
    best_composite: {
      metric: "productionComposite", value: bestCompositeScore, dir: bestCompositeDir,
    },
    best_phase_delta: {
      A: { value: bestPhaseDeltaMae.A, dir: bestPhaseDirs.A },
      B: { value: bestPhaseDeltaMae.B, dir: bestPhaseDirs.B },
      C: { value: bestPhaseDeltaMae.C, dir: bestPhaseDirs.C },
    },
  };
  const report = {
    metrics: evaluations.test_all?.metrics ?? evalReports[0]?.metrics ?? {},
    calibrated_metrics: evaluations.test_all?.calibrated?.metrics ??
      evalReports[0]?.calibrated?.metrics ?? {},
    evaluations,
    split: splitDefinition,
    curriculum_transitions: curriculumTransitions,
    interval_calibration: intervalCalibration,
    checkpoints,
    baselines: baselineSummary,
    config: args,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(runDir, args.outputReport), JSON.stringify(report, null, 2));
  if (args.outputReport !== "test-results.json") {
    fs.writeFileSync(path.join(runDir, "test-results.json"), JSON.stringify({
      ...report.metrics,
      calibrated_metrics: report.calibrated_metrics,
      interval_calibration: intervalCalibration,
    }, null, 2));
  }

  const modelCard = {
    generated_at: new Date().toISOString(),
    trainer: args.modelVersion.startsWith("v10")
      ? "trainModelV10Final.ts via trainModelV95.ts engine"
      : "trainModelV95.ts",
    lineage: {
      model_version: args.modelVersion,
      parent_model: args.parentModel,
      data_contract: args.dataContract,
      feature_profile: args.featureProfile,
    },
    db_path: args.dbPath,
    data: {
      ml_table: args.mlTable,
      row_count: loadedDataRows.length,
      retained_row_count: allDataRows.length,
      divisions: Object.fromEntries(
        [...new Set(allDataRows.map((row) => row.division))].map((division) => [
          division,
          allDataRows.filter((row) => row.division === division).length,
        ]),
      ),
    },
    artifacts: {
      reference_curve_version: safeReferenceCurveVersion(args.referenceCurvesPath),
      reference_curves_sha256: hashFileIfExists(args.referenceCurvesPath),
      judge_index_map_sha256: hashFileIfExists(args.judgeMapPath),
      corps_index_map_sha256: hashFileIfExists(args.corpsMapPath),
      show_index_map_sha256: hashFileIfExists(args.showMapPath),
      identity_support_sha256: hashFileIfExists(args.identitySupportPath),
      final2_judge_index_map_sha256: args.reproductionContract === "final2" ? FINAL2_JUDGE_MAP_SHA256 : null,
      final2_corps_index_map_sha256: args.reproductionContract === "final2" ? FINAL2_CORPS_MAP_SHA256 : null,
      embedding_input_dims: {
        judges: JUDGE_COUNT,
        corps: CORPS_COUNT,
        shows: SHOW_COUNT,
      },
      normalization_sha256: hashFileIfExists(args.normPath),
    },
    split: splitDefinition,
    curriculum_transitions: curriculumTransitions,
    treatments: {
      thin_history: {
        sample_fraction: args.thinHistorySampleFraction,
        truncation_rate: args.thinHistoryTruncationRate,
        prior_baseline_blend: args.thinHistoryBaselineBlend,
        prior_weights_for_show_1_2_3: [0.5, 0.3, 0.15],
      },
      support_aware_identity: {
        enabled: args.supportAwareIdentity,
        dropout_strength: args.supportDropoutStrength,
        support_artifact: args.identitySupportPath || null,
      },
    },
    checkpoints,
    baselines: baselineSummary,
    config: args,
    evaluations,
    caveats: [
      "Date-forward validation is show-grouped.",
      "Division ablations are available with --division-filter World Class or Open Class.",
      "Generated Elo features must use pre-show *_elo_history.elo_before values.",
    ],
  };
  fs.writeFileSync(path.join(runDir, "model-card.json"), JSON.stringify(modelCard, null, 2));

  console.log("Production training complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
