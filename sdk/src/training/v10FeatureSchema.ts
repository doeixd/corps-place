
const captions = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

export type V10Availability =
  | "always"
  | "strictly-prior-history"
  | "target-lineup-known"
  | "target-panel-known"
  | "identity-known"
  | "retrospective-target-only";

export type V10FeatureBlock = {
  readonly name: string;
  readonly features: readonly string[];
  readonly normalization: string;
  readonly availability: V10Availability;
};

const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}_${index + 1}`);
const perCaption = (suffix: string) => captions.map((caption) => `${caption}_${suffix}`);
const perCaptionStats = (prefix: string, stats: readonly string[]) =>
  stats.flatMap((stat) => perCaption(`${prefix}_${stat}`));

export const V10_SEQUENCE_BLOCKS: readonly V10FeatureBlock[] = [
  { name: "history_position", features: ["season_progress", "days_since_previous", "sequence_position", "padding", "days_since_season_start", "observed_fraction", "remaining_fraction"], normalization: "bounded ratios in [0,1]", availability: "strictly-prior-history" },
  { name: "history_date", features: ["day_of_year_sin", "day_of_year_cos", "show_count_progress"], normalization: "cyclic day; count/40", availability: "strictly-prior-history" },
  { name: "history_result", features: ["total_score", "rank", "rank_delta", "gap_to_leader", "gap_to_next", "field_percentile", "total_delta"], normalization: "score=(x-70)/30; rank/25; gaps/25", availability: "strictly-prior-history" },
  { name: "history_order", features: ["order_in_class", "order_in_class_norm", "order_overall", "order_overall_norm"], normalization: "raw order plus field-normalized order; -1 missing", availability: "strictly-prior-history" },
  { name: "history_captions", features: perCaptionStats("history", ["curve_residual", "rank_norm", "score_norm", "delta_norm"]), normalization: "caption/20; residual raw; rank/field", availability: "strictly-prior-history" },
  { name: "history_opponents", features: ["opponent_residual_mean", "opponent_residual_std", "opponent_rank_mean", "opponent_rank_best", ...numbered("opponent_top_residual", 3), "opponent_total_last3_mean", "opponent_total_last3_slope", "opponent_total_last3_volatility", ...perCaptionStats("opponent_last3", ["mean", "slope", "volatility"])], normalization: "scores/gaps use model score scales", availability: "strictly-prior-history" },
  { name: "history_show_type", features: ["is_finals", "is_semifinals", "is_regional", "is_early_season"], normalization: "binary", availability: "always" },
  { name: "history_field_relative", features: ["relative_total_z", ...perCaption("relative_to_field"), "field_total_std"], normalization: "total z-score; caption raw difference; std/10", availability: "strictly-prior-history" },
] as const;

export const V10_STATIC_BLOCKS: readonly V10FeatureBlock[] = [
  { name: "corps_history_summary", features: ["previous_season_rank", "years_in_world_class", "historical_mean_rank", "historical_rank_std", "historical_best_rank", "best_rank_recency", "made_finals_rate", "is_new", "sequence_length", "rank_ema", "residual_ema", "residual_slope", "residual_volatility", "rank_vs_historical", "days_since_season_start", "days_since_last_match", "shows_remaining", "field_size", "target_order_in_class", "target_order_in_class_norm", "target_order_overall", "target_order_overall_norm", "top_corps_present", "division_strength", "is_major_show"], normalization: "declared by builder; ranks/25, dates bounded, binary flags", availability: "strictly-prior-history" },
  { name: "caption_ranges", features: perCaptionStats("caption_range", ["min", "max"]), normalization: "caption/20", availability: "strictly-prior-history" },
  { name: "recent_residuals", features: ["last_residual_mean", ...perCaption("last_residual"), ...perCaption("ema_residual")], normalization: "reference-curve residual points", availability: "strictly-prior-history" },
  { name: "target_opponents", features: ["opponent_residual_mean", "opponent_residual_median", "opponent_residual_std", "opponent_residual_min", "opponent_residual_max", "opponent_residual_p25", "opponent_residual_p75", "opponent_weighted_residual_mean", "opponent_rank_mean", "opponent_rank_best", ...numbered("opponent_top_residual", 3), ...numbered("opponent_top_rank", 3), "opponent_total_last3_mean", "opponent_total_last3_slope", "opponent_total_last3_volatility", ...perCaptionStats("opponent_last3", ["mean", "slope", "volatility"])], normalization: "score and rank model scales", availability: "target-lineup-known" },
  { name: "judge_elo", features: [...perCaption("judge_elo"), "panel_elo_mean", "panel_elo_std", "panel_elo_max", "panel_elo_min"], normalization: "(elo-1500)/200; std/100", availability: "target-panel-known" },
  { name: "corps_elo", features: perCaption("corps_elo"), normalization: "(elo-1500)/200", availability: "strictly-prior-history" },
  { name: "rank_baselines", features: perCaption("rank_curve_baseline"), normalization: "caption/20", availability: "target-lineup-known" },
  { name: "division", features: ["is_world_class", "is_open_class", "is_all_age"], normalization: "one-hot flags", availability: "always" },
  { name: "target_date_progress", features: ["target_month", "target_day", "premiere_month", "premiere_day", "past_show_count"], normalization: "month/12, day/31, shows/40", availability: "always" },
  { name: "subcaption_history", features: perCaptionStats("subcaption", ["last_content", "last_achievement", "ema_content", "ema_achievement"]), normalization: "subcaption/10", availability: "strictly-prior-history" },
  { name: "cold_start_evidence", features: ["is_season_debut", "same_season_history_count", "days_since_same_season_show", "days_since_any_scored_show", "last_season_final_score", "last_season_final_rank", "is_first_scored_event", "event_week_index", "target_day_of_season", "target_percent_through"], normalization: "bounded ratios and binary flags", availability: "strictly-prior-history" },
  { name: "caption_fingerprint", features: [...perCaptionStats("fingerprint", ["prior_season_residual", "three_year_residual", "growth", "volatility"]), "fingerprint_confidence"], normalization: "residual points with bounded confidence", availability: "identity-known" },
] as const;

export const V10_FIELD_PACE_BLOCK: V10FeatureBlock = {
  name: "field_pace",
  features: [
    "field_level_vs_reference",
    "field_shrunk_residual_slope",
    "field_residual_ema",
    "field_pace_confidence",
  ],
  normalization: "level/slope/EMA divided by 10 total points; confidence in [0,1]",
  availability: "strictly-prior-history",
};

export const V10_TREND_FEATURES = perCaption("sequence_trend");
export const V10_FEATURE_SCHEMA = {
  version: "v10-feature-schema-clean-control-dev1",
  captions,
  sequenceLength: 15,
  sequenceBlocks: V10_SEQUENCE_BLOCKS,
  rawStaticBlocks: V10_STATIC_BLOCKS,
  trendFeatures: V10_TREND_FEATURES,
  sequenceDim: V10_SEQUENCE_BLOCKS.reduce((sum, block) => sum + block.features.length, 0),
  rawStaticDim: V10_STATIC_BLOCKS.reduce((sum, block) => sum + block.features.length, 0),
  trendDim: V10_TREND_FEATURES.length,
  totalStaticDim: V10_STATIC_BLOCKS.reduce((sum, block) => sum + block.features.length, 0) + V10_TREND_FEATURES.length,
  judgeSlots: 8,
  unknownIdentityIndex: 0,
  targetRule: "Every history-derived feature must use observations with competition_date strictly before the target show.",
} as const;

export const V10_FIELD_PACE_FEATURE_SCHEMA = {
  ...V10_FEATURE_SCHEMA,
  version: "v10-feature-schema-field-pace-dev1",
  rawStaticBlocks: [...V10_STATIC_BLOCKS, V10_FIELD_PACE_BLOCK],
  rawStaticDim: V10_FEATURE_SCHEMA.rawStaticDim + V10_FIELD_PACE_BLOCK.features.length,
  totalStaticDim: V10_FEATURE_SCHEMA.totalStaticDim + V10_FIELD_PACE_BLOCK.features.length,
} as const;

if (V10_FEATURE_SCHEMA.sequenceDim !== 101 || V10_FEATURE_SCHEMA.rawStaticDim !== 212 || V10_FEATURE_SCHEMA.totalStaticDim !== 220) {
  throw new Error(`Invalid V10 clean-control feature dimensions: ${JSON.stringify({ sequence: V10_FEATURE_SCHEMA.sequenceDim, rawStatic: V10_FEATURE_SCHEMA.rawStaticDim, totalStatic: V10_FEATURE_SCHEMA.totalStaticDim })}`);
}
if (V10_FIELD_PACE_FEATURE_SCHEMA.rawStaticDim !== 216 || V10_FIELD_PACE_FEATURE_SCHEMA.totalStaticDim !== 224) {
  throw new Error(`Invalid V10 field-pace dimensions: ${JSON.stringify({ rawStatic: V10_FIELD_PACE_FEATURE_SCHEMA.rawStaticDim, totalStatic: V10_FIELD_PACE_FEATURE_SCHEMA.totalStaticDim })}`);
}
