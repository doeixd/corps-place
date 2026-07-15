import { V9_FEATURE_INDICES } from "./v9FeatureModes.js";

export type MaskingRates = {
  history: number;
  judges: number;
  forecastContext: number;
};

export type MaskingDecision = {
  hideHistory: boolean;
  hideJudges: boolean;
  hideForecastContext: boolean;
};

export const selectV95Masking = (
  rng: () => number,
  hasHistory: boolean,
  rates: MaskingRates,
): MaskingDecision => {
  // Call order and short-circuiting are part of the final2 stochastic contract.
  const hideForecastContext = rates.forecastContext > 0 && rng() < rates.forecastContext;
  const hideJudges = rates.judges > 0 && rng() < rates.judges;
  const hideHistory = hideForecastContext ||
    (rates.history > 0 && hasHistory && rng() < rates.history);
  return { hideHistory, hideJudges, hideForecastContext };
};

export const captionFingerprintBaselineAdjustments = (
  staticFeatures: readonly number[],
  captionCount = 8,
): number[] => {
  const confidence = Math.max(
    0,
    Math.min(1, staticFeatures[V9_FEATURE_INDICES.captionFingerprintConfidence] ?? 0),
  );
  const raw = Array.from({ length: captionCount }, (_, index) => {
    const start = V9_FEATURE_INDICES.captionFingerprintStart + index * 4;
    const priorResidual = (staticFeatures[start] ?? 0) * 2;
    const multiResidual = (staticFeatures[start + 1] ?? 0) * 2;
    return 0.55 * priorResidual + 0.45 * multiResidual;
  });
  const center = raw.reduce((sum, value) => sum + value, 0) / Math.max(1, raw.length);
  return raw.map((value) => Math.max(-0.6, Math.min(0.6, (value - center) * confidence)));
};

export const buildForecastBaseline = (
  staticFeatures: readonly number[],
  recapMean: readonly number[],
  captionCount = 8,
  scoreScale = 20,
): number[] => {
  const adjustments = captionFingerprintBaselineAdjustments(staticFeatures, captionCount);
  return Array.from({ length: captionCount }, (_, index) => {
    const normalized = staticFeatures[V9_FEATURE_INDICES.rankBaselineStart + index];
    const curve = Number.isFinite(normalized) && normalized! > 0
      ? normalized! * scoreScale
      : recapMean[index] ?? 0;
    return Math.max(0, Math.min(scoreScale, curve + adjustments[index]!));
  });
};
