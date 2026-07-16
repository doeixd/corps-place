import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  CAPTIONS,
  loadV9SubcaptionModel,
  type TargetStats,
} from "../src/training/v9SubcaptionInference.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const CAPTION_COUNT = CAPTIONS.length;
const SEQ_LEN = 15;
const FEAT_DIM = 101;
const STATIC_DIM = 212;
const PADDING_INDEX = 3;
const RECAP_OFFSET = 21;
const CAPTION_STRIDE = 4;
const CAPTION_SCALE = 20;
const EMA_ALPHA = 0.3;
const COLD_START_OFFSET = 169;

type RawRow = {
  season: string;
  competition_slug: string;
  competition_date: string;
  corps_key: string;
  corps_id: number;
  x_sequence_json: string;
  x_static_json: string;
  judge_indices_json: string;
  y_recap_json: string;
  agnostic_show_id: number;
  division_name: string;
  split: string;
};

type ReplayRow = {
  season: string;
  competitionSlug: string;
  date: string;
  corpsKey: string;
  corpsId: number;
  sequence: number[][];
  mask: boolean[];
  staticFeatures: number[];
  judgeIndices: number[];
  agnosticShowId: number;
  recap: number[];
  total: number;
  division: string;
  split: string;
  showKey: string;
  globalBaseline: number[];
  trendSlopes: number[];
};

type MetricBucket = {
  rows: number;
  captionValues: number;
  recapAbs: number;
  categoryAbs: number;
  totalAbs: number;
  coverageWithin: number;
  width: number;
};

const getArg = (name: string, fallback: string): string => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};

const hasArg = (name: string): boolean => argv.includes(name);

const mean = (values: readonly number[]): number =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const std = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const center = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1)
  );
};

const seededRandom = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
};

const parseRows = (rawRows: RawRow[]): ReplayRow[] => {
  const shows = new Map<string, RawRow[]>();
  for (const row of rawRows) {
    const key = `${row.season}_${row.competition_slug}_${row.competition_date}`;
    const group = shows.get(key) ?? [];
    group.push(row);
    shows.set(key, group);
  }

  const rows: ReplayRow[] = [];
  for (const [showKey, showRows] of shows) {
    for (const raw of showRows) {
      const recapRecord = JSON.parse(raw.y_recap_json) as Record<string, number>;
      const recap = CAPTIONS.map((caption) => Number(recapRecord[caption] ?? 0));
      const rawSequence = JSON.parse(raw.x_sequence_json) as number[][];
      const mask = rawSequence.map((step) => step[PADDING_INDEX] !== 1);
      const sequence = rawSequence.map((step) =>
        step[PADDING_INDEX] === 1 ? new Array<number>(FEAT_DIM).fill(0) : step
      );
      const staticFeatures = JSON.parse(raw.x_static_json) as number[];
      if (sequence.length !== SEQ_LEN || sequence.some((step) => step.length !== FEAT_DIM)) continue;
      if (staticFeatures.length !== STATIC_DIM) continue;

      rows.push({
        season: raw.season,
        competitionSlug: raw.competition_slug,
        date: raw.competition_date,
        corpsKey: raw.corps_key,
        corpsId: Number(raw.corps_id ?? 0),
        sequence,
        mask,
        staticFeatures,
        judgeIndices: JSON.parse(raw.judge_indices_json) as number[],
        agnosticShowId: Number(raw.agnostic_show_id ?? 0),
        recap,
        total:
          recap[0]! + recap[1]! +
          (recap[2]! + recap[3]! + recap[4]!) / 2 +
          (recap[5]! + recap[6]! + recap[7]!) / 2,
        division: raw.division_name,
        split: raw.split,
        showKey,
        globalBaseline: [],
        trendSlopes: [],
      });
    }
  }
  return rows;
};

const splitDateForward = (rows: ReplayRow[], valSplit: number) => {
  const groups = new Map<string, ReplayRow[]>();
  for (const row of rows) {
    const group = groups.get(row.showKey) ?? [];
    group.push(row);
    groups.set(row.showKey, group);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    const dateOrder = (a[0]?.date ?? "").localeCompare(b[0]?.date ?? "");
    return dateOrder || (a[0]?.showKey ?? "").localeCompare(b[0]?.showKey ?? "");
  });
  const target = Math.max(1, Math.floor(rows.length * valSplit));
  const validation: ReplayRow[] = [];
  const train: ReplayRow[] = [];
  for (let index = ordered.length - 1; index >= 0; index--) {
    const group = ordered[index]!;
    if (validation.length < target) validation.unshift(...group);
    else train.unshift(...group);
  }
  return { train, validation };
};

const applyBaselines = (rows: ReplayRow[], historyRows: readonly ReplayRow[]): void => {
  const history = new Set(historyRows);
  const byCorps = new Map<number, ReplayRow[]>();
  for (const row of rows) {
    const group = byCorps.get(row.corpsId) ?? [];
    group.push(row);
    byCorps.set(row.corpsId, group);
  }
  for (const corpsRows of byCorps.values()) {
    corpsRows.sort((a, b) => a.date.localeCompare(b.date) || a.showKey.localeCompare(b.showKey));
    const ema: Array<number | null> = new Array(CAPTION_COUNT).fill(null);
    const recapHistory: number[][] = Array.from({ length: CAPTION_COUNT }, () => []);
    for (const row of corpsRows) {
      row.globalBaseline = ema.map((value) => value ?? 0);
      row.trendSlopes = recapHistory.map((values) => {
        const last = values.slice(-3);
        return last.length >= 2 ? (last.at(-1)! - last[0]!) / (last.length - 1) / 0.1 : 0;
      });
      if (!history.has(row)) continue;
      row.recap.forEach((value, index) => {
        ema[index] = ema[index] === null ? value : EMA_ALPHA * value + (1 - EMA_ALPHA) * ema[index]!;
        recapHistory[index]!.push(value);
        if (recapHistory[index]!.length > 3) recapHistory[index]!.shift();
      });
    }
  }
};

const computeStats = (rows: readonly ReplayRow[]): TargetStats => {
  const delta = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const recap = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const categories = Array.from({ length: 3 }, () => [] as number[]);
  const totals: number[] = [];
  for (const row of rows) {
    row.recap.forEach((value, index) => {
      delta[index]!.push(value - (row.globalBaseline[index] ?? 0));
      recap[index]!.push(value);
    });
    categories[0]!.push(row.recap[0]! + row.recap[1]!);
    categories[1]!.push((row.recap[2]! + row.recap[3]! + row.recap[4]!) / 2);
    categories[2]!.push((row.recap[5]! + row.recap[6]! + row.recap[7]!) / 2);
    totals.push(row.total);
  }
  return {
    deltaMean: delta.map(mean),
    deltaStd: delta.map(std),
    recapMean: recap.map(mean),
    recapStd: recap.map(std),
    categoryMean: categories.map(mean),
    categoryStd: categories.map(std),
    totalMean: mean(totals),
    totalStd: std(totals),
  };
};

const emptyBucket = (): MetricBucket => ({
  rows: 0,
  captionValues: 0,
  recapAbs: 0,
  categoryAbs: 0,
  totalAbs: 0,
  coverageWithin: 0,
  width: 0,
});

const summarize = (bucket: MetricBucket) => ({
  rows: bucket.rows,
  caption_values: bucket.captionValues,
  // The model predicts a residual over the selected baseline. Subtracting the
  // same baseline from prediction and target leaves the recap error unchanged.
  delta_mae_pts: bucket.captionValues ? bucket.recapAbs / bucket.captionValues : 0,
  recap_mae_pts: bucket.captionValues ? bucket.recapAbs / bucket.captionValues : 0,
  category_mae_pts: bucket.rows ? bucket.categoryAbs / bucket.rows : 0,
  total_mae_pts: bucket.rows ? bucket.totalAbs / bucket.rows : 0,
  coverage: bucket.captionValues ? bucket.coverageWithin / bucket.captionValues : 0,
  width: bucket.captionValues ? bucket.width / bucket.captionValues : 0,
  width_floor_pct: 0,
});

type MetricSummary = ReturnType<typeof summarize>;
type EvaluationSummary = ReturnType<typeof evaluate>;

const METRIC_TOLERANCE = 3e-6;

const compareMetricSummary = (
  label: string,
  actual: MetricSummary,
  expected: MetricSummary,
  failures: string[],
): number => {
  let checks = 0;
  for (const key of Object.keys(expected) as Array<keyof MetricSummary>) {
    checks += 1;
    const delta = Math.abs(actual[key] - expected[key]);
    const tolerance = key === "rows" || key === "caption_values" ? 0 : METRIC_TOLERANCE;
    if (delta > tolerance) {
      failures.push(`${label}.${key}: expected ${expected[key]}, got ${actual[key]} (delta ${delta})`);
    }
  }
  return checks;
};

const compareEvaluation = (
  label: string,
  actual: EvaluationSummary,
  expected: EvaluationSummary,
  failures: string[],
): number => {
  let checks = compareMetricSummary(`${label}.metrics`, actual.metrics, expected.metrics, failures);
  for (const groupName of ["by_history", "by_forecast_mode"] as const) {
    for (const [bucketName, expectedMetrics] of Object.entries(expected[groupName])) {
      const actualMetrics = actual[groupName][bucketName];
      if (!actualMetrics) {
        failures.push(`${label}.${groupName}.${bucketName}: missing bucket`);
        checks += 1;
        continue;
      }
      checks += compareMetricSummary(
        `${label}.${groupName}.${bucketName}`,
        actualMetrics,
        expectedMetrics,
        failures,
      );
    }
  }
  return checks;
};

const evaluate = (
  rows: readonly ReplayRow[],
  model: Awaited<ReturnType<typeof loadV9SubcaptionModel>>,
  seed: number,
  intervalScale: number,
  includeRowDetails = false,
) => {
  const global = emptyBucket();
  const history = new Map<string, MetricBucket>();
  const forecast = new Map<string, MetricBucket>();
  const historyDetails: Array<{
    show_key: string;
    date: string;
    competition_slug: string;
    corps_key: string;
    corps_id: number;
    history_bucket: string;
    history_len: number;
    actual_total: number;
    predicted_total: number;
    total_abs_error: number;
    recap_mae: number;
    actual_recap: number[];
    predicted_recap: number[];
  }> = [];
  const rng = seededRandom(seed);

  for (const row of rows) {
    const mask = row.mask.map((value) => (value ? 1 : 0));
    const lastValid = mask.lastIndexOf(1);
    const baseline = lastValid >= 0
      ? CAPTIONS.map((_, index) =>
          (row.sequence[lastValid]?.[RECAP_OFFSET + index * CAPTION_STRIDE + 2] ?? 0) * CAPTION_SCALE
        )
      : [...row.globalBaseline];
    if (lastValid >= 0) {
      baseline.forEach((value, index) => {
        if (value === 0) baseline[index] = row.globalBaseline[index] ?? 0;
      });
    }

    rng(); // epoch-0 leakage-audit sampling draw in the recovered trainer
    rng(); // identity-dropout draw; rate is zero during evaluation
    const agnosticShowId = rng() < 0.2 ? 0 : row.agnosticShowId;
    const historyLen = Math.max(0, mask.filter(Boolean).length - 1);
    const prediction = model.predictOne({
      sequence: row.sequence,
      sequenceMask: mask,
      staticFeatures: [...row.staticFeatures, ...row.trendSlopes],
      judgeIndices: row.judgeIndices,
      corpsId: row.corpsId,
      agnosticShowId,
      baselineRecap: baseline,
      historyLen,
      judgeBiasScale: 1,
      corpsScale: 1,
    });

    const historyKey = historyLen === 0
      ? "zero_history"
      : historyLen <= 1
        ? "sparse_history"
        : historyLen <= 4
          ? "short_history"
          : "established_history";
    const forecastKey = (row.staticFeatures[COLD_START_OFFSET] ?? 0) >= 0.5
      ? "season_debut"
      : "observed_history";
    const historyBucket = history.get(historyKey) ?? emptyBucket();
    const forecastBucket = forecast.get(forecastKey) ?? emptyBucket();
    history.set(historyKey, historyBucket);
    forecast.set(forecastKey, forecastBucket);

    const buckets = [global, historyBucket, forecastBucket];
    buckets.forEach((bucket) => { bucket.rows += 1; });
    const predictedRecap: number[] = [];
    CAPTIONS.forEach((caption, index) => {
      const actual = row.recap[index]!;
      const predicted = prediction.captions[caption];
      predictedRecap.push(predicted.p50);
      const intervalCenter = predicted.residualP50 ?? predicted.p50;
      const lower = intervalCenter - Math.max(0, intervalCenter - predicted.p10) * intervalScale;
      const upper = intervalCenter + Math.max(0, predicted.p90 - intervalCenter) * intervalScale;
      buckets.forEach((bucket) => {
        bucket.captionValues += 1;
        bucket.recapAbs += Math.abs(predicted.p50 - actual);
        bucket.coverageWithin += actual >= lower && actual <= upper ? 1 : 0;
        bucket.width += upper - lower;
      });
    });
    const actualCategories = [
      row.recap[0]! + row.recap[1]!,
      (row.recap[2]! + row.recap[3]! + row.recap[4]!) / 2,
      (row.recap[5]! + row.recap[6]! + row.recap[7]!) / 2,
    ];
    const predictedCategories = [prediction.categories.ge, prediction.categories.visual, prediction.categories.music];
    const categoryError = mean(actualCategories.map((actual, index) => Math.abs(predictedCategories[index]! - actual)));
    const totalAbsError = Math.abs(prediction.total - row.total);
    buckets.forEach((bucket) => {
      bucket.categoryAbs += categoryError;
      bucket.totalAbs += totalAbsError;
    });
    if (includeRowDetails && (historyKey === "zero_history" || historyKey === "sparse_history")) {
      historyDetails.push({
        show_key: row.showKey,
        date: row.date,
        competition_slug: row.competitionSlug,
        corps_key: row.corpsKey,
        corps_id: row.corpsId,
        history_bucket: historyKey,
        history_len: historyLen,
        actual_total: row.total,
        predicted_total: prediction.total,
        total_abs_error: totalAbsError,
        recap_mae: mean(row.recap.map((actual, index) => Math.abs(predictedRecap[index]! - actual))),
        actual_recap: [...row.recap],
        predicted_recap: predictedRecap,
      });
    }
  }

  return {
    metrics: summarize(global),
    by_history: Object.fromEntries([...history].map(([key, bucket]) => [key, summarize(bucket)])),
    by_forecast_mode: Object.fromEntries([...forecast].map(([key, bucket]) => [key, summarize(bucket)])),
    ...(includeRowDetails ? { history_details: historyDetails } : {}),
  };
};

const main = async () => {
  const dbPath = path.resolve(sdkRoot, getArg("--db", "dci-relational-scrape.db"));
  const replaySeed = Number(getArg("--seed", "42"));
  if (!Number.isInteger(replaySeed)) throw new Error(`Invalid --seed: ${replaySeed}`);
  const modelDir = path.resolve(
    sdkRoot,
    getArg("--model-dir", "models/v9_subcaption_fixed/v9_prod_fingerprint_preseason_final2_1779976626982"),
  );
  const card = JSON.parse(fs.readFileSync(path.join(modelDir, "model-card.json"), "utf8")) as any;
  const query = `
    SELECT season, competition_slug, competition_date, corps_key, corps_id,
      x_sequence_json, x_static_json, judge_indices_json, y_recap_json,
      agnostic_show_id, division_name, split
    FROM ml_sequence_rows_v9_subcaption
    ORDER BY row_id;
  `;
  const rawRows = JSON.parse(execFileSync("sqlite3", ["-json", dbPath, query], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  })) as RawRow[];

  const rows = parseRows(rawRows);
  const test = rows.filter((row) => row.split === "test");
  const nonTest = rows.filter((row) => row.split !== "test");
  const { train, validation } = splitDateForward(nonTest, 0.05);
  applyBaselines(rows, train);
  const stats = computeStats(train);
  const normalizationJson = JSON.stringify({
    ...stats,
    deltaWeights: stats.deltaStd.map((value) => 1 / Math.max(value, 0.25)),
    recapWeights: stats.recapStd.map((value) => 1 / Math.max(value, 0.25)),
  }, null, 2);
  const normalizationSha256 = createHash("sha256").update(normalizationJson).digest("hex");

  const model = await loadV9SubcaptionModel(modelDir, { stats });
  try {
    const expectedValidation = card.evaluations.validation;
    const expectedValidationCalibrated = card.evaluations.validation.calibrated;
    const expectedTest = card.evaluations.test_all;
    const calibratedIntervalScale = Number(expectedValidationCalibrated.interval_scale ?? 0.6);
    const validationReplay = evaluate(validation, model, replaySeed, 1, hasArg("--row-details"));
    const validationCalibrated = evaluate(validation, model, replaySeed, calibratedIntervalScale);
    const testReplay = evaluate(test, model, replaySeed + 2, 1);
    const failures: string[] = [];
    let checks = 0;

    const exactChecks: Array<[string, unknown, unknown]> = [
      ["rows", rows.length, card.data.row_count],
      ["split.train", train.length, card.split.train_rows],
      ["split.validation", validation.length, card.split.validation_rows],
      ["split.test", test.length, card.split.test_rows],
      ["normalization_sha256", normalizationSha256, card.artifacts.normalization_sha256],
    ];
    for (const [label, actual, expected] of exactChecks) {
      checks += 1;
      if (actual !== expected) failures.push(`${label}: expected ${expected}, got ${actual}`);
    }
    checks += compareEvaluation("validation", validationReplay, expectedValidation, failures);
    checks += compareEvaluation(
      "validation_calibrated",
      validationCalibrated,
      expectedValidationCalibrated,
      failures,
    );
    checks += compareEvaluation("test", testReplay, expectedTest, failures);

    const report = {
      ok: failures.length === 0,
      checks,
      tolerance: METRIC_TOLERANCE,
      failures,
      db: path.relative(sdkRoot, dbPath),
      model_dir: path.relative(sdkRoot, modelDir),
      rows: rows.length,
      split: { train: train.length, validation: validation.length, test: test.length },
      normalization_sha256: normalizationSha256,
      expected_normalization_sha256: card.artifacts.normalization_sha256,
      validation: validationReplay,
      validation_calibrated: validationCalibrated,
      test: testReplay,
      expected: {
        validation: expectedValidation.metrics,
        validation_calibrated: expectedValidationCalibrated.metrics,
        test: expectedTest.metrics,
      },
    };
    if (hasArg("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (failures.length === 0) {
      process.stdout.write(
        `final2 prediction replay verified: ${checks} checks passed ` +
        `(rows=${rows.length}, validation recap MAE=${validationReplay.metrics.recap_mae_pts.toFixed(9)}, ` +
        `test recap MAE=${testReplay.metrics.recap_mae_pts.toFixed(9)})\n`,
      );
    } else {
      process.stderr.write(`final2 prediction replay failed (${failures.length}/${checks} checks):\n`);
      failures.forEach((failure) => process.stderr.write(`- ${failure}\n`));
      process.exitCode = 1;
    }
  } finally {
    model.dispose();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
