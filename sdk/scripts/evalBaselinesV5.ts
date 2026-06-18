import * as fs from "node:fs";
import { createClient } from "@libsql/client";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const RESIDUAL_OFFSET = 14;
const CAPTION_STRIDE = 4;
const EMA_ALPHA = 0.3;
const IS_PADDING_INDEX = 3;
const RANK_NORM_INDEX = 8;
const PREV_SEASON_RANK_STATIC_INDEX = 0;
const IS_NEW_STATIC_INDEX = 7;

const SHOW_BUCKETS = ["shows_1_3", "shows_4_6", "shows_7_10", "shows_11_14", "finals"] as const;
const TIERS = ["top_3", "tier_4_7", "tier_8_12", "tier_13_plus", "new_corps"] as const;
const RESIDUAL_BUCKETS = ["small", "medium", "large"] as const;

const RESIDUAL_SMALL = 0.3;
const RESIDUAL_MEDIUM = 0.8;

type Caption = (typeof CAPTIONS)[number];
type ShowBucket = (typeof SHOW_BUCKETS)[number];
type Tier = (typeof TIERS)[number];
type ResidualBucket = (typeof RESIDUAL_BUCKETS)[number];

type Metrics = {
  count: number;
  maeSum: number;
  mseSum: number;
  mapeSum: number;
  mapeCount: number;
  ql10Sum: number;
  ql50Sum: number;
  ql90Sum: number;
  belowP10: number;
  belowP50: number;
  belowP90: number;
  withinP10P90: number;
  intervalWidthSum: number;
  actualSum: number;
  actualSqSum: number;
};

type MetricGroup = {
  overall: Metrics;
  byCaption: Record<Caption, Metrics>;
  byShowBucket: Record<ShowBucket, Metrics>;
  byTier: Record<Tier, Metrics>;
  byResidual: Record<ResidualBucket, Metrics>;
  bySeason: Record<string, Metrics>;
};

type BaselineFn = (history: number[]) => number;

type Row = {
  x_sequence_json: string;
  x_static_json: string;
  y_residuals_json: string;
  season: string;
  corps_key: string;
  competition_slug: string;
};

function emptyMetrics(): Metrics {
  return {
    count: 0,
    maeSum: 0,
    mseSum: 0,
    mapeSum: 0,
    mapeCount: 0,
    ql10Sum: 0,
    ql50Sum: 0,
    ql90Sum: 0,
    belowP10: 0,
    belowP50: 0,
    belowP90: 0,
    withinP10P90: 0,
    intervalWidthSum: 0,
    actualSum: 0,
    actualSqSum: 0,
  };
}

function emptyGroup(seasons: string[]): MetricGroup {
  const byCaption = {} as Record<Caption, Metrics>;
  for (const caption of CAPTIONS) byCaption[caption] = emptyMetrics();

  const byShowBucket = {} as Record<ShowBucket, Metrics>;
  for (const bucket of SHOW_BUCKETS) byShowBucket[bucket] = emptyMetrics();

  const byTier = {} as Record<Tier, Metrics>;
  for (const tier of TIERS) byTier[tier] = emptyMetrics();

  const byResidual = {} as Record<ResidualBucket, Metrics>;
  for (const bucket of RESIDUAL_BUCKETS) byResidual[bucket] = emptyMetrics();

  const bySeason: Record<string, Metrics> = {};
  for (const season of seasons) bySeason[season] = emptyMetrics();

  return { overall: emptyMetrics(), byCaption, byShowBucket, byTier, byResidual, bySeason };
}

function pinballLoss(q: number, actual: number, pred: number) {
  const e = actual - pred;
  return Math.max(q * e, (q - 1) * e);
}

function updateMetrics(metrics: Metrics, actual: number, p10: number, p50: number, p90: number) {
  const error = p50 - actual;
  metrics.count += 1;
  metrics.maeSum += Math.abs(error);
  metrics.mseSum += error * error;
  metrics.actualSum += actual;
  metrics.actualSqSum += actual * actual;

  if (Math.abs(actual) > 1e-6) {
    metrics.mapeSum += Math.abs(error / actual);
    metrics.mapeCount += 1;
  }

  metrics.ql10Sum += pinballLoss(0.1, actual, p10);
  metrics.ql50Sum += pinballLoss(0.5, actual, p50);
  metrics.ql90Sum += pinballLoss(0.9, actual, p90);

  if (actual <= p10) metrics.belowP10 += 1;
  if (actual <= p50) metrics.belowP50 += 1;
  if (actual <= p90) metrics.belowP90 += 1;
  if (actual >= p10 && actual <= p90) metrics.withinP10P90 += 1;

  metrics.intervalWidthSum += p90 - p10;
}

function finalizeMetrics(metrics: Metrics) {
  if (metrics.count === 0) {
    return {
      count: 0,
      mae: NaN,
      rmse: NaN,
      mape: NaN,
      r2: NaN,
      ql10: NaN,
      ql50: NaN,
      ql90: NaN,
      qlTotal: NaN,
      coverageP10: NaN,
      coverageP50: NaN,
      coverageP90: NaN,
      intervalCoverage: NaN,
      intervalWidth: NaN,
      calibrationError: NaN,
    };
  }

  const mae = metrics.maeSum / metrics.count;
  const rmse = Math.sqrt(metrics.mseSum / metrics.count);
  const mape = metrics.mapeCount > 0 ? metrics.mapeSum / metrics.mapeCount : NaN;

  const meanActual = metrics.actualSum / metrics.count;
  const totalVar = metrics.actualSqSum - metrics.count * meanActual * meanActual;
  const r2 = totalVar > 0 ? 1 - metrics.mseSum / totalVar : NaN;

  const ql10 = metrics.ql10Sum / metrics.count;
  const ql50 = metrics.ql50Sum / metrics.count;
  const ql90 = metrics.ql90Sum / metrics.count;
  const qlTotal = ql10 + ql50 + ql90;

  const coverageP10 = metrics.belowP10 / metrics.count;
  const coverageP50 = metrics.belowP50 / metrics.count;
  const coverageP90 = metrics.belowP90 / metrics.count;
  const intervalCoverage = metrics.withinP10P90 / metrics.count;
  const intervalWidth = metrics.intervalWidthSum / metrics.count;
  const calibrationError =
    (Math.abs(coverageP10 - 0.1) + Math.abs(coverageP50 - 0.5) + Math.abs(coverageP90 - 0.9)) / 3;

  return {
    count: metrics.count,
    mae,
    rmse,
    mape,
    r2,
    ql10,
    ql50,
    ql90,
    qlTotal,
    coverageP10,
    coverageP50,
    coverageP90,
    intervalCoverage,
    intervalWidth,
    calibrationError,
  };
}

function formatOverall(metrics: Metrics) {
  const summary = finalizeMetrics(metrics);
  return (
    `n=${summary.count}` +
    ` mae=${summary.mae.toFixed(4)}` +
    ` rmse=${summary.rmse.toFixed(4)}` +
    ` mape=${Number.isFinite(summary.mape) ? summary.mape.toFixed(4) : "NA"}` +
    ` r2=${Number.isFinite(summary.r2) ? summary.r2.toFixed(4) : "NA"}` +
    ` ql=${summary.qlTotal.toFixed(4)}` +
    ` p10=${summary.coverageP10.toFixed(3)}` +
    ` p50=${summary.coverageP50.toFixed(3)}` +
    ` p90=${summary.coverageP90.toFixed(3)}` +
    ` width=${summary.intervalWidth.toFixed(4)}` +
    ` calErr=${summary.calibrationError.toFixed(4)}`
  );
}

function formatSimple(metrics: Metrics) {
  const summary = finalizeMetrics(metrics);
  return `n=${summary.count} mae=${summary.mae.toFixed(4)} rmse=${summary.rmse.toFixed(4)}`;
}

function metricsToCsvRow(name: string, metrics: Metrics) {
  const summary = finalizeMetrics(metrics);
  return [
    name,
    summary.count.toString(),
    summary.mae.toFixed(6),
    summary.rmse.toFixed(6),
    Number.isFinite(summary.mape) ? summary.mape.toFixed(6) : "",
    Number.isFinite(summary.r2) ? summary.r2.toFixed(6) : "",
    summary.qlTotal.toFixed(6),
    summary.ql10.toFixed(6),
    summary.ql50.toFixed(6),
    summary.ql90.toFixed(6),
    summary.coverageP10.toFixed(6),
    summary.coverageP50.toFixed(6),
    summary.coverageP90.toFixed(6),
    summary.intervalCoverage.toFixed(6),
    summary.intervalWidth.toFixed(6),
    summary.calibrationError.toFixed(6),
  ].join(",");
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (key: string, fallback?: string) => {
    const idx = argv.indexOf(key);
    return idx >= 0 ? argv[idx + 1] : fallback;
  };

  return {
    db: get("--db", "./dci-relational.db")!,
    split: (get("--split", "val") as "train" | "val" | "test")!,
    csv: get("--csv"),
  };
}

function isRealStep(step: number[]): boolean {
  return step[IS_PADDING_INDEX] !== 1;
}

function getResidual(step: number[], captionIndex: number): number {
  return step[RESIDUAL_OFFSET + captionIndex * CAPTION_STRIDE] ?? 0;
}

function buildHistory(seq: number[][]): { history: Record<Caption, number[]>; pastCount: number } {
  const history = {} as Record<Caption, number[]>;
  for (const caption of CAPTIONS) history[caption] = [];

  let pastCount = 0;
  for (const step of seq) {
    if (!isRealStep(step)) continue;
    pastCount += 1;
    CAPTIONS.forEach((caption, idx) => {
      history[caption].push(getResidual(step, idx));
    });
  }

  return { history, pastCount };
}

function bucketForShow(showNumber: number, slug: string): ShowBucket {
  if (slug.includes("finals")) return "finals";
  if (showNumber <= 3) return "shows_1_3";
  if (showNumber <= 6) return "shows_4_6";
  if (showNumber <= 10) return "shows_7_10";
  return "shows_11_14";
}

function residualBucket(actual: number): ResidualBucket {
  const magnitude = Math.abs(actual);
  if (magnitude < RESIDUAL_SMALL) return "small";
  if (magnitude < RESIDUAL_MEDIUM) return "medium";
  return "large";
}

function tierForCorps(enteringRank: number, isNew: boolean): Tier {
  if (isNew) return "new_corps";
  if (enteringRank <= 3) return "top_3";
  if (enteringRank <= 7) return "tier_4_7";
  if (enteringRank <= 12) return "tier_8_12";
  return "tier_13_plus";
}

function getEnteringRank(seq: number[][], staticFeatures: number[]): number {
  let lastRankNorm: number | null = null;

  for (const step of seq) {
    if (!isRealStep(step)) continue;
    const stepRank = step[RANK_NORM_INDEX];
    if (typeof stepRank === "number" && stepRank > 0) {
      lastRankNorm = stepRank;
    }
  }

  if (lastRankNorm != null && lastRankNorm > 0) return lastRankNorm * 25;

  const prevSeasonRankNorm = staticFeatures[PREV_SEASON_RANK_STATIC_INDEX];
  if (typeof prevSeasonRankNorm === "number" && prevSeasonRankNorm > 0) {
    return prevSeasonRankNorm * 25;
  }

  return 15;
}

function predictLast(history: number[]): number {
  return history.length ? history[history.length - 1]! : 0;
}

function predictEMA(history: number[]): number {
  let ema = 0;
  for (const value of history) {
    ema = EMA_ALPHA * value + (1 - EMA_ALPHA) * ema;
  }
  return ema;
}

function predictLinear(history: number[]): number {
  if (history.length === 0) return 0;
  if (history.length === 1) return history[0]!;

  const window = history.slice(Math.max(0, history.length - 3));
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
  if (denom === 0) return window[n - 1]!;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return intercept + slope * n;
}

async function main() {
  const args = parseArgs();

  const client = createClient({ url: `file:${args.db}` });
  const rowsResult = await client.execute({
    sql: `
      SELECT x_sequence_json, x_static_json, y_residuals_json, season, corps_key, competition_slug
      FROM ml_sequence_rows_v5
      WHERE split = ?
      ORDER BY competition_date ASC
    `,
    args: [args.split],
  });
  const rows = rowsResult.rows as unknown as Row[];

  if (!rows.length) {
    client.close();
    throw new Error(`No rows found for split=${args.split}`);
  }

  client.close();

  const seasons = Array.from(new Set(rows.map((row) => row.season))).sort();

  const baselines: Record<string, BaselineFn> = {
    baseline_zero: () => 0,
    baseline_last: predictLast,
    baseline_ema: predictEMA,
    baseline_lr: predictLinear,
  };

  const results: Record<string, MetricGroup> = {};
  for (const key of Object.keys(baselines)) results[key] = emptyGroup(seasons);

  for (const row of rows) {
    const seq = JSON.parse(row.x_sequence_json) as number[][];
    const staticFeatures = JSON.parse(row.x_static_json) as number[];
    const residuals = JSON.parse(row.y_residuals_json) as Record<string, number>;
    const { history, pastCount } = buildHistory(seq);
    const showNumber = pastCount + 1;
    const bucket = bucketForShow(showNumber, row.competition_slug);
    const enteringRank = getEnteringRank(seq, staticFeatures);
    const isNew = (staticFeatures[IS_NEW_STATIC_INDEX] ?? 0) >= 0.5;
    const tier = tierForCorps(enteringRank, isNew);

    for (const caption of CAPTIONS) {
      const actual = residuals[caption] ?? 0;
      const residualBucketKey = residualBucket(actual);

      for (const [name, fn] of Object.entries(baselines)) {
        const predicted = fn(history[caption]);
        const p10 = predicted;
        const p50 = predicted;
        const p90 = predicted;

        const group = results[name]!;
        updateMetrics(group.overall, actual, p10, p50, p90);
        updateMetrics(group.byCaption[caption], actual, p10, p50, p90);
        updateMetrics(group.byShowBucket[bucket], actual, p10, p50, p90);
        updateMetrics(group.byTier[tier], actual, p10, p50, p90);
        updateMetrics(group.byResidual[residualBucketKey], actual, p10, p50, p90);
        const seasonMetrics = group.bySeason[row.season];
        if (seasonMetrics) updateMetrics(seasonMetrics, actual, p10, p50, p90);
      }
    }
  }

  console.log(`Baseline evaluation on split=${args.split}`);
  console.log("Note: baseline_zero reflects reference curve accuracy.");
  console.log("------------------------------------------------------------");

  for (const [name, group] of Object.entries(results)) {
    console.log(`\n${name}`);
    console.log(`  overall        ${formatOverall(group.overall)}`);

    console.log("  show buckets");
    for (const bucket of SHOW_BUCKETS) {
      console.log(`    ${bucket.padEnd(12)} ${formatSimple(group.byShowBucket[bucket])}`);
    }

    console.log("  corps tiers");
    for (const tier of TIERS) {
      console.log(`    ${tier.padEnd(12)} ${formatSimple(group.byTier[tier])}`);
    }

    console.log("  residual magnitude");
    for (const bucket of RESIDUAL_BUCKETS) {
      console.log(`    ${bucket.padEnd(12)} ${formatSimple(group.byResidual[bucket])}`);
    }

    console.log("  by season");
    for (const season of seasons) {
      console.log(`    ${season.padEnd(12)} ${formatSimple(group.bySeason[season])}`);
    }

    console.log("  by caption");
    for (const caption of CAPTIONS) {
      console.log(`    ${caption.padEnd(3)} ${formatSimple(group.byCaption[caption])}`);
    }
  }

  if (args.csv) {
    const header = [
      "model",
      "count",
      "mae",
      "rmse",
      "mape",
      "r2",
      "ql_total",
      "ql_p10",
      "ql_p50",
      "ql_p90",
      "coverage_p10",
      "coverage_p50",
      "coverage_p90",
      "interval_coverage",
      "interval_width",
      "calibration_error",
    ].join(",");

    const rows = Object.entries(results).map(([name, group]) => metricsToCsvRow(name, group.overall));
    const dir = args.csv.replace(/[\\/][^\\/]+$/, "");
    if (dir && dir !== args.csv) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(args.csv, [header, ...rows].join("\n"));
    console.log(`\nWrote summary CSV to ${args.csv}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
