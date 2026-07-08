export type PredictionContextMode =
  | 'as_of_show_date'
  | 'preseason_forecast'
  | 'panel_unknown'
  | 'lineup_unknown';

export const V9_CAPTION_FINGERPRINT_START = 179;
export const V9_CAPTION_FINGERPRINT_CAPTION_COUNT = 8;
export const V9_CAPTION_FINGERPRINT_FEATURES_PER_CAPTION = 4;
export const V9_CAPTION_FINGERPRINT_CONFIDENCE_IDX =
  V9_CAPTION_FINGERPRINT_START +
  V9_CAPTION_FINGERPRINT_CAPTION_COUNT * V9_CAPTION_FINGERPRINT_FEATURES_PER_CAPTION;
export const V9_CAPTION_FINGERPRINT_DIM =
  V9_CAPTION_FINGERPRINT_CAPTION_COUNT * V9_CAPTION_FINGERPRINT_FEATURES_PER_CAPTION + 1;
export const V9_RAW_STATIC_DIM = V9_CAPTION_FINGERPRINT_START + V9_CAPTION_FINGERPRINT_DIM;
export const V9_COLD_START_STATIC_OFFSET = 169;

const STATIC_PREV_RANK_IDX = 0;
const STATIC_MEAN_RANK_IDX = 2;
const STATIC_SEQUENCE_LENGTH_IDX = 8;
const STATIC_RANK_EMA_IDX = 9;
const STATIC_RESIDUAL_EMA_IDX = 10;
const STATIC_RESIDUAL_SLOPE_IDX = 11;
const STATIC_RESIDUAL_VOLATILITY_IDX = 12;
const STATIC_RANK_VS_HISTORICAL_IDX = 13;
const STATIC_DAYS_SINCE_LAST_MATCH_IDX = 15;
const STATIC_SHOWS_REMAINING_IDX = 16;
const STATIC_FIELD_SIZE_IDX = 17;
const STATIC_PERFORMANCE_ORDER_START = 18;
const STATIC_PERFORMANCE_ORDER_END = 21;
const STATIC_TOP_CORPS_PRESENT_IDX = 22;
const STATIC_DIVISION_STRENGTH_IDX = 23;
const STATIC_LAST_RESIDUAL_START = 41;
const STATIC_LAST_RESIDUAL_END = 57;
const STATIC_OPPONENT_CONTEXT_START = 58;
const STATIC_OPPONENT_CONTEXT_END = 100;
const STATIC_JUDGE_ELO_START = 101;
const STATIC_JUDGE_ELO_END = 112;
const STATIC_RANK_BASELINE_START = 121;
const STATIC_RANK_BASELINE_END = 128;
// pastShows.length/40 is at index 136 in the built x_static (after the 5 date/static
// features at 132-136); index 168 is the last subcaption EMA. The old value (168)
// made maskV9PreseasonForecastContext zero a subcaption feature instead of the
// past-shows count. Verified against stored rows (idx 136 = k/40, idx 168 = a score).
const STATIC_PAST_SHOWS_COUNT_IDX = 136;

export const V9_FEATURE_INDICES = {
  previousRank: STATIC_PREV_RANK_IDX,
  meanRank: STATIC_MEAN_RANK_IDX,
  sequenceLength: STATIC_SEQUENCE_LENGTH_IDX,
  rankEma: STATIC_RANK_EMA_IDX,
  residualEma: STATIC_RESIDUAL_EMA_IDX,
  residualSlope: STATIC_RESIDUAL_SLOPE_IDX,
  residualVolatility: STATIC_RESIDUAL_VOLATILITY_IDX,
  rankVsHistorical: STATIC_RANK_VS_HISTORICAL_IDX,
  daysSinceLastMatch: STATIC_DAYS_SINCE_LAST_MATCH_IDX,
  showsRemaining: STATIC_SHOWS_REMAINING_IDX,
  fieldSize: STATIC_FIELD_SIZE_IDX,
  performanceOrderStart: STATIC_PERFORMANCE_ORDER_START,
  performanceOrderEnd: STATIC_PERFORMANCE_ORDER_END,
  topCorpsPresent: STATIC_TOP_CORPS_PRESENT_IDX,
  divisionStrength: STATIC_DIVISION_STRENGTH_IDX,
  lastResidualStart: STATIC_LAST_RESIDUAL_START,
  lastResidualEnd: STATIC_LAST_RESIDUAL_END,
  opponentContextStart: STATIC_OPPONENT_CONTEXT_START,
  opponentContextEnd: STATIC_OPPONENT_CONTEXT_END,
  judgeEloStart: STATIC_JUDGE_ELO_START,
  judgeEloEnd: STATIC_JUDGE_ELO_END,
  rankBaselineStart: STATIC_RANK_BASELINE_START,
  rankBaselineEnd: STATIC_RANK_BASELINE_END,
  pastShowsCount: STATIC_PAST_SHOWS_COUNT_IDX,
  captionFingerprintStart: V9_CAPTION_FINGERPRINT_START,
  captionFingerprintEnd: V9_CAPTION_FINGERPRINT_CONFIDENCE_IDX,
  captionFingerprintConfidence: V9_CAPTION_FINGERPRINT_CONFIDENCE_IDX,
} as const;

const neutralRankNorm = 15 / 25;

export type V9FeatureModeOptions = {
  mode: PredictionContextMode;
  recapMean?: readonly number[];
  seedRank?: number;
  fieldSize?: number;
  keepKnownLineupContext?: boolean;
};

const normalizedRank = (rank?: number) => {
  if (!Number.isFinite(rank)) return neutralRankNorm;
  return Math.max(1, Math.min(25, Math.round(rank!))) / 25;
};

const normalizedFieldSize = (fieldSize?: number) => {
  if (!Number.isFinite(fieldSize)) return 20 / 25;
  return Math.max(1, Math.min(40, Math.round(fieldSize!))) / 25;
};

export function maskV9JudgeContext(staticFeatures: number[]) {
  for (let idx = STATIC_JUDGE_ELO_START; idx <= STATIC_JUDGE_ELO_END; idx++) {
    staticFeatures[idx] = 0;
  }
}

export function maskV9LineupContext(staticFeatures: number[], fieldSize?: number) {
  staticFeatures[STATIC_FIELD_SIZE_IDX] = normalizedFieldSize(fieldSize);
  for (let idx = STATIC_PERFORMANCE_ORDER_START; idx <= STATIC_PERFORMANCE_ORDER_END; idx++) {
    staticFeatures[idx] = -1;
  }
  staticFeatures[STATIC_TOP_CORPS_PRESENT_IDX] = 0;
  staticFeatures[STATIC_DIVISION_STRENGTH_IDX] = neutralRankNorm;
  for (let idx = STATIC_OPPONENT_CONTEXT_START; idx <= STATIC_OPPONENT_CONTEXT_END; idx++) {
    staticFeatures[idx] = 0;
  }
}

export function maskV9PreseasonForecastContext(
  staticFeatures: number[],
  options: Omit<V9FeatureModeOptions, 'mode'> = {}
) {
  const seedRankNorm = normalizedRank(options.seedRank);
  const prevRankNorm = Number.isFinite(options.seedRank)
    ? seedRankNorm
    : (staticFeatures[STATIC_PREV_RANK_IDX] ?? neutralRankNorm);
  const meanRankNorm = staticFeatures[STATIC_MEAN_RANK_IDX] ?? neutralRankNorm;

  staticFeatures[STATIC_PREV_RANK_IDX] = prevRankNorm;
  staticFeatures[STATIC_SEQUENCE_LENGTH_IDX] = 0;
  staticFeatures[STATIC_RANK_EMA_IDX] = prevRankNorm;
  staticFeatures[STATIC_RESIDUAL_EMA_IDX] = 0;
  staticFeatures[STATIC_RESIDUAL_SLOPE_IDX] = 0;
  staticFeatures[STATIC_RESIDUAL_VOLATILITY_IDX] = 0;
  staticFeatures[STATIC_RANK_VS_HISTORICAL_IDX] = prevRankNorm - meanRankNorm;
  staticFeatures[STATIC_DAYS_SINCE_LAST_MATCH_IDX] = 1;
  staticFeatures[STATIC_SHOWS_REMAINING_IDX] = 0.5;
  staticFeatures[STATIC_PAST_SHOWS_COUNT_IDX] = 0;

  for (let idx = STATIC_LAST_RESIDUAL_START; idx <= STATIC_LAST_RESIDUAL_END; idx++) {
    staticFeatures[idx] = 0;
  }
  for (let idx = STATIC_RANK_BASELINE_START; idx <= STATIC_RANK_BASELINE_END; idx++) {
    const captionIdx = idx - STATIC_RANK_BASELINE_START;
    staticFeatures[idx] = (options.recapMean?.[captionIdx] ?? 15) / 20;
  }

  if (!options.keepKnownLineupContext) {
    maskV9LineupContext(staticFeatures, options.fieldSize);
  } else {
    staticFeatures[STATIC_FIELD_SIZE_IDX] = normalizedFieldSize(options.fieldSize);
  }
}

export function applyV9PredictionContextMode(
  staticFeatures: readonly number[],
  options: V9FeatureModeOptions
) {
  const stat = [...staticFeatures];
  if (options.mode === 'preseason_forecast') {
    maskV9PreseasonForecastContext(stat, options);
    maskV9JudgeContext(stat);
  } else if (options.mode === 'panel_unknown') {
    maskV9JudgeContext(stat);
  } else if (options.mode === 'lineup_unknown') {
    maskV9LineupContext(stat, options.fieldSize);
  }
  return stat;
}
