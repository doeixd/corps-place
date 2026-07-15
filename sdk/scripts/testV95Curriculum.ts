import assert from "node:assert/strict";
import {
  FINAL2_CURRICULUM_CONFIG,
  cosineBaseLearningRate,
  effectiveLearningRate,
  identityScalesAtEpoch,
  initialCurriculumState,
  lossWeightsAtEpoch,
  stepCurriculum,
  widthFloorWeightAtEpoch,
} from "../src/training/v95Curriculum.js";

const lossConfig = {
  phaseAEnd: 10,
  phaseBEnd: 40,
  phaseCRamp: 80,
  corpsScaleStart: 25,
  corpsScaleRamp: 35,
  judgeScaleRamp: 40,
  identityDropoutFloor: 0.05,
};
assert.deepEqual(lossWeightsAtEpoch(0, lossConfig), {
  totalWeight: 0.05,
  recapWeight: 1,
  deltaWeight: 0.2,
  categoryWeight: 0.05,
  quantileWeight: 0.02,
  consistencyWeight: 0,
  identityDropoutRate: 0.95,
});
assert.deepEqual(identityScalesAtEpoch(39, lossConfig), { judgeBias: 0.975, corps: 0.4 });
assert.equal(widthFloorWeightAtEpoch(39, 0.1, 1.5, lossConfig), 1.495437037037037);
assert.deepEqual(lossWeightsAtEpoch(40, lossConfig), {
  totalWeight: 0.02,
  recapWeight: 0.3,
  deltaWeight: 1,
  categoryWeight: 0.05,
  quantileWeight: 0.1,
  consistencyWeight: 0,
  identityDropoutRate: 1,
});
assert.deepEqual(lossWeightsAtEpoch(71, lossConfig), {
  totalWeight: 0.051000000000000004,
  recapWeight: 0.203125,
  deltaWeight: 4.390625,
  categoryWeight: 0.05,
  quantileWeight: 0.48750000000000004,
  consistencyWeight: 0,
  identityDropoutRate: 1,
});
assert.equal(lossWeightsAtEpoch(100, lossConfig).identityDropoutRate, 0.7625);
assert.ok(Math.abs(cosineBaseLearningRate(0, 160, 10, 0.00075, 0.00003) - 0.000075) < 1e-15);
assert.equal(cosineBaseLearningRate(9, 160, 10, 0.00075, 0.00003), 0.00075);
assert.equal(effectiveLearningRate(0.0005, 0.5, 0.00003), 0.00025);
assert.equal(effectiveLearningRate(0.00004, 0.5, 0.00003), 0.00003);

const metrics = (valDeltaMae: number, coverage = 0.95) => ({ valDeltaMae, coverage });

let state = initialCurriculumState(FINAL2_CURRICULUM_CONFIG);
for (let epoch = 0; epoch < 9; epoch++) {
  const step = stepCurriculum(state, FINAL2_CURRICULUM_CONFIG, epoch, metrics(1 - epoch * 0.01));
  state = step.state;
  assert.equal(step.transition, null);
}
let step = stepCurriculum(state, FINAL2_CURRICULUM_CONFIG, 9, metrics(0.9));
assert.deepEqual(step.transition, {
  epoch: 10,
  from: "A",
  to: "B",
  reason: "max_epoch",
  deltaMae: 0.9,
  coverage: 0.95,
});
state = step.state;

for (let epoch = 10; epoch < 39; epoch++) {
  step = stepCurriculum(state, FINAL2_CURRICULUM_CONFIG, epoch, metrics(0.9 - epoch * 0.001));
  state = step.state;
  assert.equal(step.transition, null);
}
step = stepCurriculum(state, FINAL2_CURRICULUM_CONFIG, 39, metrics(0.85));
assert.equal(step.transition?.epoch, 40);
assert.equal(step.transition?.from, "B");
assert.equal(step.transition?.to, "C");
assert.equal(step.transition?.reason, "max_epoch");

const extendedPhaseA = { ...FINAL2_CURRICULUM_CONFIG, phaseAEnd: 20 };
state = initialCurriculumState(extendedPhaseA);
for (let epoch = 0; epoch < 6; epoch++) {
  step = stepCurriculum(state, extendedPhaseA, epoch, metrics(1, 0.95));
  state = step.state;
  assert.equal(step.transition, null);
}
assert.equal(step.transition, null, "the initial improvement resets plateau patience");
step = stepCurriculum(state, extendedPhaseA, 6, metrics(1, 0.95));
assert.equal(step.transition?.reason, "delta_plateau");

state = initialCurriculumState(extendedPhaseA);
for (let epoch = 0; epoch < 12; epoch++) {
  step = stepCurriculum(state, extendedPhaseA, epoch, metrics(1, 0.89));
  state = step.state;
}
assert.equal(step.transition, null, "coverage gate blocks plateau advancement");

process.stdout.write("V9.5 curriculum transitions verified\n");
