export const parseV95Args = (
  argv: readonly string[],
  inferredAccuracyTrunkUnits?: number,
) => {
  const get = (key: string, fallback?: string) => {
    const index = argv.indexOf(key);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const loadModel = get("--load-model");

  return {
    dbPath: get("--db", "./dci-relational.db") || "./dci-relational.db",
    modelDir: get("--model-dir", "./models/v95_final2_reconstruction") || "./models/v95_final2_reconstruction",
    normPath: get("--norm-path", "./results/v95-final2-reconstruction-target-norm.json") || "./results/v95-final2-reconstruction-target-norm.json",
    reproductionContract: get("--reproduction-contract"),
    epochs: Number(get("--epochs", "160")),
    batchSize: Number(get("--batch", "128")),
    maxRows: Number(get("--maxRows", "")) || undefined,
    patience: Number(get("--patience", "60")),
    reduceLrPatience: Number(get("--reduce-lr-patience", "12")),
    lstm1Units: Number(get("--lstm1-units", "128")),
    lstm2Units: Number(get("--lstm2-units", "64")),
    dropoutLstm: Number(get("--dropout-lstm", "0.2")),
    recurrentDropout: Number(get("--recurrent-dropout", "0.1")),
    dropoutDense1: Number(get("--dropout-dense1", "0.3")),
    dropoutDense2: Number(get("--dropout-dense2", "0.2")),
    l2Reg: Number(get("--l2-reg", "0.000025")),
    learningRate: Number(get("--lr", "0.00075")),
    minLr: Number(get("--min-lr", "0.00003")),
    plateauLrFactor: Number(get("--plateau-lr-factor", "0.5")),
    warmupEpochs: Number(get("--warmup-epochs", "10")),
    startEpoch: Number(get("--start-epoch", "0")),
    clipNorm: Number(get("--clip-norm", "1")),
    seed: Number(get("--seed", "42")),
    swa: get("--swa", "false") === "true",
    swaStart: Number(get("--swa-start", "0.75")),
    swaInterval: Number(get("--swa-interval", "1")),
    snapshotEpochs: get("--snapshot-epochs", "") ?? "",
    useMha: get("--use-mha", "false") === "true",
    widthFloorPts: Number(get("--width-floor-pts", "0.5")),
    widthFloorWeight: Number(get("--width-floor-weight", "1.5")),
    widthFloorStart: Number(get("--width-floor-start", "0.1")),
    widthFloorEnd: Number(get("--width-floor-end", "1.5")),
    widthTargetPts: Number(get("--width-target-pts", "2.5")),
    widthPenaltyWeight: Number(get("--width-penalty-weight", "0.5")),
    coverageTarget: Number(get("--coverage-target", "0.8")),
    coverageUpperTarget: Number(get("--coverage-upper-target", "0.85")),
    overCoverageWeight: Number(get("--over-coverage-weight", "2")),
    rankingWeight: Number(get("--ranking-weight", "0.1")),
    valSplit: Number(get("--val-split", "0.05")),
    valMode: get("--val-mode", "date-forward") || "date-forward",
    valDateCutoff: get("--val-date-cutoff"),
    divisionFilter: get("--division-filter", "all") || "all",
    samplesPerEpoch: Number(get("--samples-per-epoch", "4096")),
    loadModel,
    baselineDropout: Number(get("--baseline-dropout", "0.1")),
    baselineNoiseStd: Number(get("--baseline-noise-std", "0.25")),
    historyHideRate: Number(get("--history-hide-rate", "0.15")),
    judgeHideRate: Number(get("--judge-hide-rate", "0.25")),
    forecastContextHideRate: Number(get("--forecast-context-hide-rate", "0.12")),
    openSampleFraction: Number(get("--open-sample-frac", "0.35")),
    logCsv: get("--log-csv", "./results/lstm-v95-reconstruction-training-log.csv"),
    trialId: get("--trial-id"),
    noJudgeBias: get("--no-judge-bias", "false") === "true",
    noCorpsResidual: get("--no-corps-residual", "false") === "true",
    outputReport: get("--output-report", "eval_report.json") || "eval_report.json",
    logFile: get("--log-file"),
    noLogFile: get("--no-log-file", "false") === "true",
    baselineScope: get("--baseline-scope", "train") || "train",
    baseWidthMultiplier: Number(get("--base-width-multiplier", "1")),
    coverageSharpness: Number(get("--coverage-sharpness", "4")),
    identityDropoutFloor: Number(get("--identity-dropout-floor", "0.05")),
    accuracyTrunkUnits: Number(get("--accuracy-trunk-units", String(inferredAccuracyTrunkUnits ?? 270))),
    inferredAccuracyTrunkUnits,
    mbMpLossBoost: Number(get("--mbmp-loss-boost", "1")),
    finalWeights: get("--final-weights", "composite") || "composite",
    curriculumPhaseAEnd: Number(get("--curriculum-phase-a-end", "10")),
    curriculumPhaseBEnd: Number(get("--curriculum-phase-b-end", "40")),
    curriculumPhaseCRamp: Number(get("--curriculum-phase-c-ramp", "80")),
    corpsScaleStart: Number(get("--corps-scale-start", "25")),
    corpsScaleRamp: Number(get("--corps-scale-ramp", "35")),
    judgeScaleRamp: Number(get("--judge-scale-ramp", "40")),
    autoCurriculum: get("--auto-curriculum", "true") !== "false",
    autoCurriculumPatience: Number(get("--auto-curriculum-patience", "6")),
    autoCurriculumMinCoverage: Number(get("--auto-curriculum-min-coverage", "0.9")),
    autoCurriculumMinDeltaGain: Number(get("--auto-curriculum-min-delta-gain", "0.002")),
    autoCurriculumPhaseAMin: Number(get("--auto-curriculum-phase-a-min", "6")),
    autoCurriculumPhaseBMin: Number(get("--auto-curriculum-phase-b-min", "18")),
  };
};

export type V95Args = ReturnType<typeof parseV95Args>;

export const formatV95ModelCapacity = (args: V95Args) =>
  `Model Capacity: ${args.lstm1Units * 2}→${args.lstm2Units * 2} BiLSTM, ` +
  `Dense 512→256, AccuracyTrunk ${args.accuracyTrunkUnits}, ` +
  "Judge Emb 24, Corps Emb 20, Show Emb 12";

export const formatV95Curriculum = (args: V95Args) =>
  `Curriculum: phaseAEnd=${args.curriculumPhaseAEnd}, phaseBEnd=${args.curriculumPhaseBEnd}, ` +
  `phaseCRamp=${args.curriculumPhaseCRamp}, judgeScaleRamp=${args.judgeScaleRamp}, ` +
  `corpsScaleStart=${args.corpsScaleStart}, corpsScaleRamp=${args.corpsScaleRamp}, ` +
  `auto=${args.autoCurriculum}, autoPatience=${args.autoCurriculumPatience}, ` +
  `autoMinCoverage=${args.autoCurriculumMinCoverage}, ` +
  `autoMinDeltaGain=${args.autoCurriculumMinDeltaGain}`;
