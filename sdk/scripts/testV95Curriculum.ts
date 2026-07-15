import assert from "node:assert/strict";
import {
  FINAL2_CURRICULUM_CONFIG,
  initialCurriculumState,
  stepCurriculum,
} from "../src/training/v95Curriculum.js";

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
