export type CheckpointMetrics = {
  valLoss: number;
  valDeltaMae: number;
  valTotalMae: number;
  coverage: number;
};

export type CheckpointBest = {
  delta: number;
  loss: number;
  total: number;
  composite: number;
  phaseDelta: number;
};

export const productionCompositeScore = (
  metrics: CheckpointMetrics,
  coverageTarget: number,
  coverageUpperTarget: number,
): number => {
  const underCoverage = Math.max(0, coverageTarget - metrics.coverage);
  const overCoverage = Math.max(0, metrics.coverage - coverageUpperTarget);
  return metrics.valDeltaMae +
    0.15 * metrics.valTotalMae +
    0.2 * underCoverage +
    0.1 * overCoverage;
};

export const checkpointDecisions = (
  metrics: CheckpointMetrics,
  best: CheckpointBest,
  coverageTarget: number,
  coverageUpperTarget: number,
  hasValidation = true,
) => {
  const composite = productionCompositeScore(metrics, coverageTarget, coverageUpperTarget);
  const unconditional = !hasValidation;
  return {
    composite,
    delta: unconditional || metrics.valDeltaMae < best.delta - 1e-4,
    loss: unconditional || metrics.valLoss < best.loss - 1e-5,
    total: unconditional || metrics.valTotalMae < best.total - 1e-4,
    compositeImproved: unconditional || composite < best.composite - 1e-4,
    phase: unconditional || metrics.valDeltaMae < best.phaseDelta - 1e-4,
  };
};

export type FinalWeightsMode = "swa" | "composite" | "total" | "loss" | "delta" | "current";

export const selectFinalWeightsMode = (
  requested: string,
  available: Partial<Record<Exclude<FinalWeightsMode, "current">, boolean>>,
): FinalWeightsMode => {
  const normalized = requested.toLowerCase();
  if (normalized === "swa" && available.swa) return "swa";
  if (normalized === "composite" && available.composite) return "composite";
  if (normalized === "total" && available.total) return "total";
  if (normalized === "loss" && available.loss) return "loss";
  if (available.delta) return "delta";
  return "current";
};
