import assert from "node:assert/strict";
import { formatV95ModelCapacity, parseV95Args } from "../src/training/v95Config.js";
import { getV10Profile, mergeV10Args, V10_PROFILES, v10DefaultArgs, V10_PROFILE_NAMES } from "../src/training/v10Config.js";

assert.equal(V10_PROFILE_NAMES.length, 9);
for (const name of V10_PROFILE_NAMES) {
  const profile = getV10Profile(name);
  const args = parseV95Args(v10DefaultArgs(name));
  assert.equal(args.modelVersion, profile.modelVersion, name);
  assert.equal(args.parentModel, profile.parentModel, name);
  assert.equal(args.dataContract, profile.dataContract, name);
  assert.equal(args.featureProfile, profile.featureProfile, name);
  assert.equal(args.mlTable, profile.mlTable, name);
  assert.equal(profile.runnable, name !== "combined-candidate", );
}

const control = parseV95Args(v10DefaultArgs("clean-data-control"));
assert.equal(control.lstm1Units, 128);
assert.equal(control.lstm2Units, 64);
assert.equal(control.dense1Units, 512);
assert.equal(control.dense2Units, 256);
assert.equal(control.accuracyTrunkUnits, 270);
assert.equal(control.learningRate, 0.00075);
assert.equal(control.lrSchedule, "cosine");
assert.equal(control.autoCurriculum, false);
assert.equal(control.sequenceTransitionEpochs, 0);
assert.equal(control.judgeCount, 211);
assert.equal(control.corpsCount, 54);
assert.equal(control.showCount, 290);
assert.equal(control.paretoCheckpointLimit, 8);
assert.equal(control.rawStaticDim, 212);
assert.match(control.judgeMapPath, /v10\/dev3\/judgeIndexMap\.json$/);
assert.match(control.referenceCurvesPath, /v10\/dev3\/referenceCurves\.json$/);
assert.equal(V10_PROFILES["clean-data-control"].expectedTrainableParameters, 1_034_015);
assert.equal(
  formatV95ModelCapacity(control),
  "Model Capacity: 256→128 BiLSTM, Dense 512→256, AccuracyTrunk 270, Judge Emb 24, Corps Emb 20, Show Emb 12",
);

const phaseAware = parseV95Args(v10DefaultArgs("phase-aware-lr"));
assert.equal(phaseAware.lrSchedule, "phase-aware");
assert.equal(phaseAware.sequenceTransitionEpochs, 0);
const smooth = parseV95Args(v10DefaultArgs("smooth-sequence"));
assert.equal(smooth.lrSchedule, "cosine");
assert.equal(smooth.sequenceTransitionEpochs, 4);
const combined = parseV95Args(v10DefaultArgs("combined-candidate"));
assert.equal(combined.lstm1Units, 192);
assert.equal(combined.learningRate, 0.00065);
assert.equal(combined.lrSchedule, "phase-aware");
assert.equal(combined.sequenceTransitionEpochs, 4);
assert.equal(V10_PROFILES["combined-candidate"].expectedTrainableParameters, null);
const fieldPace = parseV95Args(v10DefaultArgs("field-pace"));
assert.equal(fieldPace.rawStaticDim, 216);
assert.equal(V10_PROFILES["field-pace"].expectedTrainableParameters, 1_037_207);
const thinHistory = parseV95Args(v10DefaultArgs("thin-history"));
assert.equal(thinHistory.mlTable, "ml_sequence_rows_v10_clean_control");
assert.equal(thinHistory.thinHistorySampleFraction, 0.45);
assert.equal(thinHistory.thinHistoryTruncationRate, 0.25);
assert.equal(thinHistory.thinHistoryBaselineBlend, true);
assert.equal(V10_PROFILES["thin-history"].expectedTrainableParameters, 1_034_015);
const supportAware = parseV95Args(v10DefaultArgs("support-aware-identity"));
assert.equal(supportAware.supportAwareIdentity, true);
assert.equal(supportAware.supportDropoutStrength, 0.6);
assert.match(supportAware.identitySupportPath, /v10\/dev3\/identitySupport\.json$/);

const overridden = parseV95Args(mergeV10Args("scaled-control", ["--lr", "0.0006", "--seed", "42"], 42));
assert.equal(overridden.learningRate, 0.0006);
assert.equal(overridden.seed, 42);
assert.throws(() => getV10Profile("not-a-profile"), /Unknown V10 profile/);
process.stdout.write("V10 isolated experiment profiles verified\n");

const phaseBTotal = parseV95Args(v10DefaultArgs("phase-b-total-weight"));
if (phaseBTotal.phaseBTotalWeight !== 0.05) throw new Error("phase-b-total-weight profile must set 0.05");
if (control.phaseBTotalWeight !== 0) throw new Error("clean control must keep phase-B total weight at the frozen 0");
