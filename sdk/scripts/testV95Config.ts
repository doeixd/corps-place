import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  formatV95Curriculum,
  formatV95ModelCapacity,
  parseV95Args,
} from "../src/training/v95Config.js";

const artifactDir = path.join(
  "models", "v9_subcaption_fixed", "v9_prod_fingerprint_preseason_final2_1779976626982",
);
const preserved = JSON.parse(
  fs.readFileSync(path.join(artifactDir, "training-args.json"), "utf8"),
) as Record<string, string | number | boolean>;

const flags: Record<string, string> = {
  epochs: "--epochs",
  batchSize: "--batch",
  patience: "--patience",
  reduceLrPatience: "--reduce-lr-patience",
  lstm1Units: "--lstm1-units",
  lstm2Units: "--lstm2-units",
  dropoutLstm: "--dropout-lstm",
  recurrentDropout: "--recurrent-dropout",
  dropoutDense1: "--dropout-dense1",
  dropoutDense2: "--dropout-dense2",
  l2Reg: "--l2-reg",
  learningRate: "--lr",
  minLr: "--min-lr",
  plateauLrFactor: "--plateau-lr-factor",
  warmupEpochs: "--warmup-epochs",
  startEpoch: "--start-epoch",
  clipNorm: "--clip-norm",
  seed: "--seed",
  swa: "--swa",
  swaStart: "--swa-start",
  swaInterval: "--swa-interval",
  snapshotEpochs: "--snapshot-epochs",
  useMha: "--use-mha",
  widthFloorPts: "--width-floor-pts",
  widthFloorWeight: "--width-floor-weight",
  widthFloorStart: "--width-floor-start",
  widthFloorEnd: "--width-floor-end",
  widthTargetPts: "--width-target-pts",
  widthPenaltyWeight: "--width-penalty-weight",
  coverageTarget: "--coverage-target",
  coverageUpperTarget: "--coverage-upper-target",
  overCoverageWeight: "--over-coverage-weight",
  rankingWeight: "--ranking-weight",
  valSplit: "--val-split",
  valMode: "--val-mode",
  divisionFilter: "--division-filter",
  samplesPerEpoch: "--samples-per-epoch",
  baselineDropout: "--baseline-dropout",
  baselineNoiseStd: "--baseline-noise-std",
  historyHideRate: "--history-hide-rate",
  judgeHideRate: "--judge-hide-rate",
  forecastContextHideRate: "--forecast-context-hide-rate",
  openSampleFraction: "--open-sample-frac",
  logCsv: "--log-csv",
  trialId: "--trial-id",
  noJudgeBias: "--no-judge-bias",
  noCorpsResidual: "--no-corps-residual",
  outputReport: "--output-report",
  noLogFile: "--no-log-file",
  baselineScope: "--baseline-scope",
  baseWidthMultiplier: "--base-width-multiplier",
  coverageSharpness: "--coverage-sharpness",
  identityDropoutFloor: "--identity-dropout-floor",
  accuracyTrunkUnits: "--accuracy-trunk-units",
  mbMpLossBoost: "--mbmp-loss-boost",
  finalWeights: "--final-weights",
  curriculumPhaseAEnd: "--curriculum-phase-a-end",
  curriculumPhaseBEnd: "--curriculum-phase-b-end",
  curriculumPhaseCRamp: "--curriculum-phase-c-ramp",
  corpsScaleStart: "--corps-scale-start",
  corpsScaleRamp: "--corps-scale-ramp",
  judgeScaleRamp: "--judge-scale-ramp",
  autoCurriculum: "--auto-curriculum",
  autoCurriculumPatience: "--auto-curriculum-patience",
  autoCurriculumMinCoverage: "--auto-curriculum-min-coverage",
  autoCurriculumMinDeltaGain: "--auto-curriculum-min-delta-gain",
  autoCurriculumPhaseAMin: "--auto-curriculum-phase-a-min",
  autoCurriculumPhaseBMin: "--auto-curriculum-phase-b-min",
};

assert.deepEqual(
  Object.keys(preserved).sort(),
  Object.keys(flags).sort(),
  "every preserved final2 argument must have an explicit V9.5 CLI flag",
);

const argv = Object.entries(preserved).flatMap(([key, value]) => [flags[key]!, String(value)]);
const parsed = parseV95Args(argv);
for (const [key, expected] of Object.entries(preserved)) {
  assert.deepEqual(
    parsed[key as keyof typeof parsed],
    expected,
    `explicit final2 argument did not round-trip: ${key}`,
  );
}

assert.equal(
  formatV95Curriculum(parsed),
  "Curriculum: phaseAEnd=10, phaseBEnd=40, phaseCRamp=80, judgeScaleRamp=40, " +
    "corpsScaleStart=25, corpsScaleRamp=35, auto=true, autoPatience=6, " +
    "autoMinCoverage=0.9, autoMinDeltaGain=0.002",
);
assert.equal(
  formatV95ModelCapacity(parsed),
  "Model Capacity: 256→128 BiLSTM, Dense 512→256, AccuracyTrunk 270, " +
    "Judge Emb 24, Corps Emb 20, Show Emb 12",
);

const scaled = parseV95Args([
  "--lstm1-units", "192",
  "--lstm2-units", "96",
  "--dense1-units", "768",
  "--dense2-units", "384",
  "--accuracy-trunk-units", "405",
]);
assert.equal(scaled.dense1Units, 768);
assert.equal(scaled.dense2Units, 384);
assert.equal(scaled.lrSchedule, "cosine");
assert.equal(scaled.sequenceTransitionEpochs, 0);
const scheduleTreatment = parseV95Args([
  "--lr-schedule", "phase-aware",
  "--sequence-transition-epochs", "4",
]);
assert.equal(scheduleTreatment.lrSchedule, "phase-aware");
assert.equal(scheduleTreatment.sequenceTransitionEpochs, 4);
assert.equal(
  formatV95ModelCapacity(scaled),
  "Model Capacity: 384→192 BiLSTM, Dense 768→384, AccuracyTrunk 405, " +
    "Judge Emb 24, Corps Emb 20, Show Emb 12",
);

process.stdout.write(`V9.5 final2 config verified: ${Object.keys(preserved).length} explicit arguments\n`);
