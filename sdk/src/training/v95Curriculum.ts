export type CurriculumPhase = "A" | "B" | "C";

export type LossScheduleConfig = {
  phaseAEnd: number;
  phaseBEnd: number;
  phaseCRamp: number;
  corpsScaleStart: number;
  corpsScaleRamp: number;
  judgeScaleRamp: number;
  identityDropoutFloor: number;
  /**
   * Optional phase-B total-score loss weight. The frozen final2 regimen trains
   * phase B with the total loss off (0) even though the production composite
   * selector weights total MAE heavily; this knob exists to test aligning the
   * training objective with the selector. Default 0 preserves final2 behavior.
   */
  phaseBTotalWeight?: number;
};

export const lossWeightsAtEpoch = (epoch: number, config: LossScheduleConfig) => {
  const phaseAEnd = Math.max(1, config.phaseAEnd);
  const phaseBEnd = Math.max(phaseAEnd + 1, config.phaseBEnd);
  if (epoch < phaseAEnd) {
    return {
      totalWeight: 0.05, recapWeight: 1, deltaWeight: 0.2,
      categoryWeight: 0.05, quantileWeight: 0.02, consistencyWeight: 0,
      identityDropoutRate: 0.95,
    };
  }
  if (epoch < phaseBEnd) {
    const progress = (epoch - phaseAEnd) / Math.max(1, phaseBEnd - phaseAEnd);
    return {
      totalWeight: config.phaseBTotalWeight ?? 0,
      recapWeight: 1 - 0.7 * progress,
      deltaWeight: 0.2 + 0.8 * progress,
      categoryWeight: 0.05,
      quantileWeight: 0.02 + 0.08 * progress,
      consistencyWeight: 0,
      identityDropoutRate: 0.95,
    };
  }
  const progress = Math.min(1, (epoch - phaseBEnd) / Math.max(1, config.phaseCRamp));
  const identityDropStart = phaseBEnd + Math.floor(config.phaseCRamp * 0.5);
  const identityDropoutRate = epoch < identityDropStart
    ? 1
    : Math.max(
        config.identityDropoutFloor,
        1 - (1 - config.identityDropoutFloor) *
          ((epoch - identityDropStart) / Math.max(1, config.phaseCRamp)),
      );
  return {
    totalWeight: 0.02 + 0.08 * progress,
    recapWeight: 0.3 - 0.25 * progress,
    deltaWeight: 1 + 8.75 * progress,
    categoryWeight: 0.05,
    quantileWeight: 0.1 + progress,
    consistencyWeight: 0,
    identityDropoutRate,
  };
};

export const identityScalesAtEpoch = (epoch: number, config: LossScheduleConfig) => ({
  judgeBias: Math.min(1, epoch / Math.max(1, config.judgeScaleRamp)),
  corps: epoch < config.corpsScaleStart
    ? 0
    : Math.min(1, (epoch - config.corpsScaleStart) / Math.max(1, config.corpsScaleRamp)),
});

export const widthFloorWeightAtEpoch = (
  epoch: number,
  startWeight: number,
  endWeight: number,
  config: LossScheduleConfig,
): number => {
  const phaseAEnd = Math.max(1, config.phaseAEnd);
  const phaseBEnd = Math.max(phaseAEnd + 1, config.phaseBEnd);
  if (epoch < phaseAEnd) return startWeight;
  if (epoch < phaseBEnd) {
    const progress = (epoch - phaseAEnd) / Math.max(1, phaseBEnd - phaseAEnd);
    const smooth = progress * progress * (3 - 2 * progress);
    return startWeight + (endWeight - startWeight) * smooth;
  }
  return endWeight;
};

export const cosineBaseLearningRate = (
  epoch: number,
  epochs: number,
  warmupEpochs: number,
  learningRate: number,
  minLearningRate: number,
): number => {
  const warmup = Math.max(0, Math.min(warmupEpochs, epochs));
  if (epoch < warmup) return learningRate * (epoch + 1) / Math.max(1, warmup);
  const progress = warmup >= epochs
    ? 1
    : (epoch - warmup) / Math.max(1, epochs - warmup);
  return minLearningRate +
    0.5 * (learningRate - minLearningRate) * (1 + Math.cos(Math.PI * progress));
};

export const phaseAwareBaseLearningRate = (
  epoch: number,
  epochs: number,
  warmupEpochs: number,
  phaseBEnd: number,
  learningRate: number,
  minLearningRate: number,
): number => {
  const warmup = Math.max(0, Math.min(warmupEpochs, epochs));
  if (epoch < warmup) return learningRate * (epoch + 1) / Math.max(1, warmup);
  const decayStart = Math.max(warmup, Math.min(phaseBEnd, epochs));
  if (epoch < decayStart) return learningRate;
  const progress = Math.min(1, (epoch - decayStart) / Math.max(1, epochs - decayStart));
  return minLearningRate +
    0.5 * (learningRate - minLearningRate) * (1 + Math.cos(Math.PI * progress));
};

export const sequenceLengthAtEpoch = (
  epoch: number,
  longSequenceStartEpoch: number,
  transitionEpochs: number,
): 5 | 10 | 15 => {
  if (epoch < longSequenceStartEpoch) return 5;
  const middleEpochs = Math.max(0, Math.floor(transitionEpochs));
  if (epoch < longSequenceStartEpoch + middleEpochs) return 10;
  return 15;
};

export const effectiveLearningRate = (
  baseLearningRate: number,
  plateauMultiplier: number,
  minLearningRate: number,
): number => Math.max(baseLearningRate * plateauMultiplier, minLearningRate);

export type CurriculumConfig = {
  phaseAEnd: number;
  phaseBEnd: number;
  auto: boolean;
  patience: number;
  minCoverage: number;
  minDeltaGain: number;
  phaseAMin: number;
  phaseBMin: number;
};

export const FINAL2_CURRICULUM_CONFIG: CurriculumConfig = {
  phaseAEnd: 10,
  phaseBEnd: 40,
  auto: true,
  patience: 6,
  minCoverage: 0.9,
  minDeltaGain: 0.002,
  phaseAMin: 6,
  phaseBMin: 18,
};

export type CurriculumState = {
  phase: CurriculumPhase;
  phaseStartedAt: number;
  bestDelta: number;
  epochsSinceDeltaImprovement: number;
  phaseAEnd: number;
  phaseBEnd: number;
};

export type CurriculumTransition = {
  epoch: number;
  from: "A" | "B";
  to: "B" | "C";
  reason: "max_epoch" | "delta_plateau";
  deltaMae: number;
  coverage: number;
};

export type CurriculumStep = {
  state: CurriculumState;
  transition: CurriculumTransition | null;
  status: {
    phase: CurriculumPhase;
    age: number;
    bestDelta: number;
    stalledEpochs: number;
    deltaImproved: boolean;
    patienceReady: boolean;
    coverageOk: boolean;
    minReached: boolean;
    maxReached: boolean;
  };
};

export const initialCurriculumState = (
  config: CurriculumConfig,
  startEpoch = 0,
): CurriculumState => ({
  phase: startEpoch >= config.phaseBEnd ? "C" : startEpoch >= config.phaseAEnd ? "B" : "A",
  phaseStartedAt: startEpoch,
  bestDelta: Number.POSITIVE_INFINITY,
  epochsSinceDeltaImprovement: 0,
  phaseAEnd: config.phaseAEnd,
  phaseBEnd: config.phaseBEnd,
});

export const stepCurriculum = (
  state: CurriculumState,
  config: CurriculumConfig,
  epoch: number,
  metrics: { valDeltaMae: number; coverage: number },
): CurriculumStep => {
  if (state.phase === "C") {
    return {
      state: { ...state },
      transition: null,
      status: {
        phase: "C",
        age: epoch + 1 - state.phaseStartedAt,
        bestDelta: state.bestDelta,
        stalledEpochs: state.epochsSinceDeltaImprovement,
        deltaImproved: false,
        patienceReady: false,
        coverageOk: metrics.coverage >= config.minCoverage,
        minReached: true,
        maxReached: false,
      },
    };
  }

  const deltaImproved = metrics.valDeltaMae < state.bestDelta - config.minDeltaGain;
  const bestDelta = deltaImproved ? metrics.valDeltaMae : state.bestDelta;
  const stalledEpochs = deltaImproved ? 0 : state.epochsSinceDeltaImprovement + 1;
  const nextEpoch = epoch + 1;
  const age = nextEpoch - state.phaseStartedAt;
  const coverageOk = metrics.coverage >= config.minCoverage;
  const patienceReady = stalledEpochs >= config.patience;
  const minRequired = state.phase === "A" ? config.phaseAMin : config.phaseBMin;
  const minReached = age >= minRequired;
  const maxEpoch = state.phase === "A" ? state.phaseAEnd : state.phaseBEnd;
  const maxReached = nextEpoch >= maxEpoch;
  const shouldAdvance = maxReached || (config.auto && minReached && patienceReady && coverageOk);
  const currentState = {
    ...state,
    bestDelta,
    epochsSinceDeltaImprovement: stalledEpochs,
  };
  const status = {
    phase: state.phase,
    age,
    bestDelta,
    stalledEpochs,
    deltaImproved,
    patienceReady,
    coverageOk,
    minReached,
    maxReached,
  };
  if (!shouldAdvance) return { state: currentState, transition: null, status };

  const reason = maxReached ? "max_epoch" : "delta_plateau";
  const transition: CurriculumTransition = state.phase === "A"
    ? { epoch: nextEpoch, from: "A", to: "B", reason, deltaMae: metrics.valDeltaMae, coverage: metrics.coverage }
    : { epoch: nextEpoch, from: "B", to: "C", reason, deltaMae: metrics.valDeltaMae, coverage: metrics.coverage };
  return {
    transition,
    status,
    state: {
      phase: transition.to,
      phaseStartedAt: nextEpoch,
      bestDelta: Number.POSITIVE_INFINITY,
      epochsSinceDeltaImprovement: 0,
      phaseAEnd: state.phase === "A" ? nextEpoch : state.phaseAEnd,
      phaseBEnd: state.phase === "B" ? nextEpoch : state.phaseBEnd,
    },
  };
};
