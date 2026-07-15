export type MetricBucket = {
  rows: number;
  captionCount: number;
  deltaAbs: number;
  recapAbs: number;
  categoryAbs: number;
  totalAbs: number;
  coverageWithin: number;
  width: number;
  widthFloor: number;
};

export type MetricSummary = {
  rows: number;
  caption_values: number;
  delta_mae_pts: number;
  recap_mae_pts: number;
  category_mae_pts: number;
  total_mae_pts: number;
  coverage: number;
  width: number;
  width_floor_pct: number;
};

export const createMetricBucket = (): MetricBucket => ({
  rows: 0,
  captionCount: 0,
  deltaAbs: 0,
  recapAbs: 0,
  categoryAbs: 0,
  totalAbs: 0,
  coverageWithin: 0,
  width: 0,
  widthFloor: 0,
});

export const addMetricValue = (
  buckets: Record<string, MetricBucket>,
  key: string,
  add: (bucket: MetricBucket) => void,
): void => {
  const bucket = buckets[key] ?? createMetricBucket();
  add(bucket);
  buckets[key] = bucket;
};

export const summarizeBucket = (bucket: MetricBucket): MetricSummary => ({
  rows: bucket.rows,
  caption_values: bucket.captionCount,
  delta_mae_pts: bucket.captionCount ? bucket.deltaAbs / bucket.captionCount : 0,
  recap_mae_pts: bucket.captionCount ? bucket.recapAbs / bucket.captionCount : 0,
  category_mae_pts: bucket.rows ? bucket.categoryAbs / bucket.rows : 0,
  total_mae_pts: bucket.rows ? bucket.totalAbs / bucket.rows : 0,
  coverage: bucket.captionCount ? bucket.coverageWithin / bucket.captionCount : 0,
  width: bucket.captionCount ? bucket.width / bucket.captionCount : 0,
  width_floor_pct: bucket.captionCount ? bucket.widthFloor / bucket.captionCount : 0,
});

export const mapBuckets = (
  buckets: Record<string, MetricBucket>,
): Record<string, MetricSummary> => Object.fromEntries(
  Object.entries(buckets).map(([key, bucket]) => [key, summarizeBucket(bucket)]),
);

export const seasonPhase = (date: string): "early" | "mid" | "late" => {
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  if (month < 7 || (month === 7 && day <= 7)) return "early";
  if (month === 7) return "mid";
  return "late";
};

export const historyBucket = (
  historyLen: number,
): "zero_history" | "sparse_history" | "short_history" | "established_history" => {
  if (historyLen === 0) return "zero_history";
  if (historyLen <= 1) return "sparse_history";
  if (historyLen <= 4) return "short_history";
  return "established_history";
};

export type ForecastModeFlags = {
  forecastContextHidden: boolean;
  lineupContextHidden: boolean;
  historyHidden: boolean;
  seasonDebut: boolean;
  firstSeasonEvent: boolean;
};

export const forecastMode = (flags: ForecastModeFlags): string => {
  if (flags.forecastContextHidden) return "forecast_context_hidden";
  if (flags.lineupContextHidden) return "lineup_unknown";
  if (flags.historyHidden) return "history_hidden";
  if (flags.seasonDebut) return "season_debut";
  if (flags.firstSeasonEvent) return "first_season_event";
  return "observed_history";
};

export const pearsonCorrelation = (xs: number[], ys: number[]): number | null => {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let covariance = 0;
  let xVariance = 0;
  let yVariance = 0;
  for (let index = 0; index < xs.length; index++) {
    const dx = xs[index]! - xMean;
    const dy = ys[index]! - yMean;
    covariance += dx * dy;
    xVariance += dx * dx;
    yVariance += dy * dy;
  }
  if (xVariance <= 1e-12 || yVariance <= 1e-12) return null;
  return covariance / Math.sqrt(xVariance * yVariance);
};
