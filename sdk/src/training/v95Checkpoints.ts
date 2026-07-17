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

export type ParetoCheckpointMetrics = {
  recapMae: number;
  totalMae: number;
  zeroHistoryMae: number | null;
  sparseHistoryMae: number | null;
  establishedHistoryMae: number | null;
  coverage: number;
  width: number;
};

export type ParetoCheckpoint = {
  epoch: number;
  metrics: ParetoCheckpointMetrics;
  selectorScore: number;
};

const coverageGap = (coverage: number, lower: number, upper: number) =>
  Math.max(0, lower - coverage, coverage - upper);

const paretoObjectives = (
  metrics: ParetoCheckpointMetrics,
  coverageTarget: number,
  coverageUpperTarget: number,
) => [
  metrics.recapMae,
  metrics.totalMae,
  metrics.zeroHistoryMae,
  metrics.sparseHistoryMae,
  metrics.establishedHistoryMae,
  coverageGap(metrics.coverage, coverageTarget, coverageUpperTarget),
  metrics.width,
] as const;

export const paretoCheckpointSelectorScore = (
  metrics: ParetoCheckpointMetrics,
  coverageTarget: number,
  coverageUpperTarget: number,
) => metrics.recapMae +
  0.15 * metrics.totalMae +
  0.1 * (metrics.zeroHistoryMae ?? metrics.recapMae) +
  0.1 * (metrics.sparseHistoryMae ?? metrics.recapMae) +
  0.05 * (metrics.establishedHistoryMae ?? metrics.recapMae) +
  0.2 * coverageGap(metrics.coverage, coverageTarget, coverageUpperTarget) +
  0.02 * metrics.width;

export const paretoDominates = (
  left: ParetoCheckpointMetrics,
  right: ParetoCheckpointMetrics,
  coverageTarget: number,
  coverageUpperTarget: number,
) => {
  const leftValues = paretoObjectives(left, coverageTarget, coverageUpperTarget);
  const rightValues = paretoObjectives(right, coverageTarget, coverageUpperTarget);
  let strictlyBetter = false;
  let compared = 0;
  for (let index = 0; index < leftValues.length; index++) {
    const leftValue = leftValues[index];
    const rightValue = rightValues[index];
    if (leftValue == null || rightValue == null) continue;
    compared += 1;
    if (leftValue > rightValue + 1e-9) return false;
    if (leftValue < rightValue - 1e-9) strictlyBetter = true;
  }
  return compared > 0 && strictlyBetter;
};

export const updateParetoCheckpointFrontier = (
  frontier: readonly ParetoCheckpoint[],
  epoch: number,
  metrics: ParetoCheckpointMetrics,
  limit: number,
  coverageTarget: number,
  coverageUpperTarget: number,
) => {
  if (limit <= 0) return { frontier: [] as ParetoCheckpoint[], retained: false, removedEpochs: [] as number[] };
  const candidate: ParetoCheckpoint = {
    epoch,
    metrics,
    selectorScore: paretoCheckpointSelectorScore(metrics, coverageTarget, coverageUpperTarget),
  };
  const withoutSameEpoch = frontier.filter((entry) => entry.epoch !== epoch);
  if (withoutSameEpoch.some((entry) => paretoDominates(
    entry.metrics,
    candidate.metrics,
    coverageTarget,
    coverageUpperTarget,
  ))) {
    return { frontier: [...withoutSameEpoch], retained: false, removedEpochs: [] as number[] };
  }

  const nondominated = [...withoutSameEpoch.filter((entry) => !paretoDominates(
    candidate.metrics,
    entry.metrics,
    coverageTarget,
    coverageUpperTarget,
  )), candidate];
  const objectiveCount = paretoObjectives(metrics, coverageTarget, coverageUpperTarget).length;
  const selected = new Map<number, ParetoCheckpoint>();
  for (let objective = 0; objective < objectiveCount; objective++) {
    const winner = [...nondominated]
      .filter((entry) => paretoObjectives(entry.metrics, coverageTarget, coverageUpperTarget)[objective] != null)
      .sort((left, right) =>
        (paretoObjectives(left.metrics, coverageTarget, coverageUpperTarget)[objective] ?? Infinity) -
          (paretoObjectives(right.metrics, coverageTarget, coverageUpperTarget)[objective] ?? Infinity) ||
        left.selectorScore - right.selectorScore || left.epoch - right.epoch
      )[0];
    if (winner) selected.set(winner.epoch, winner);
  }
  for (const entry of [...nondominated].sort((left, right) =>
    left.selectorScore - right.selectorScore || left.epoch - right.epoch
  )) {
    if (selected.size >= limit) break;
    selected.set(entry.epoch, entry);
  }
  const bounded = [...selected.values()]
    .sort((left, right) => left.epoch - right.epoch)
    .slice(0, limit);
  const retainedEpochs = new Set(bounded.map((entry) => entry.epoch));
  return {
    frontier: bounded,
    retained: retainedEpochs.has(epoch),
    removedEpochs: withoutSameEpoch
      .filter((entry) => !retainedEpochs.has(entry.epoch))
      .map((entry) => entry.epoch),
  };
};

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
