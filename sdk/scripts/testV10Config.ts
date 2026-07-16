import assert from "node:assert/strict";
import { formatV95ModelCapacity, parseV95Args } from "../src/training/v95Config.js";
import { mergeV10Args, V10_PROFILE, v10DefaultArgs } from "../src/training/v10Config.js";

const args = parseV95Args(v10DefaultArgs());
assert.equal(args.modelVersion, "v10-dev1");
assert.equal(args.parentModel, "v9.5-reconstructed-final2");
assert.equal(args.dataContract, "canonical-clean-v10-dev1");
assert.equal(args.mlTable, "ml_sequence_rows_v10_final");
assert.equal(args.learningRate, 0.00065);
assert.equal(args.lrSchedule, "phase-aware");
assert.equal(args.autoCurriculum, false);
assert.equal(args.curriculumPhaseAEnd, 10);
assert.equal(args.curriculumPhaseBEnd, 40);
assert.equal(args.sequenceTransitionEpochs, 4);
assert.equal(args.lstm1Units, 192);
assert.equal(args.lstm2Units, 96);
assert.equal(args.dense1Units, 768);
assert.equal(args.dense2Units, 384);
assert.equal(args.accuracyTrunkUnits, 405);
assert.equal(V10_PROFILE.expectedTrainableParameters, 1_976_938);
assert.equal(
  formatV95ModelCapacity(args),
  "Model Capacity: 384→192 BiLSTM, Dense 768→384, AccuracyTrunk 405, " +
    "Judge Emb 24, Corps Emb 20, Show Emb 12",
);
const overridden = parseV95Args(mergeV10Args(["--lr", "0.0006", "--seed", "42"], 42));
assert.equal(overridden.learningRate, 0.0006);
assert.equal(overridden.seed, 42);
process.stdout.write("V10 dev1 profile verified\n");
