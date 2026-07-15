import assert from "node:assert/strict";
import {
  checkpointDecisions,
  productionCompositeScore,
  selectFinalWeightsMode,
} from "../src/training/v95Checkpoints.js";

const final2Best = {
  valLoss: 0.5623712076628504,
  valDeltaMae: 0.3456992869042168,
  valTotalMae: 0.9673736023180413,
  coverage: 0.9676308539944903,
};
assert.ok(Math.abs(productionCompositeScore(final2Best, 0.8, 0.85) - 0.5025684126513721) < 1e-12);

const decisions = checkpointDecisions(
  { valLoss: 0.9, valDeltaMae: 0.4, valTotalMae: 0.7, coverage: 0.82 },
  { delta: 0.39, loss: 1, total: 0.8, composite: 0.6, phaseDelta: 0.5 },
  0.8,
  0.85,
);
assert.deepEqual(
  {
    delta: decisions.delta,
    loss: decisions.loss,
    total: decisions.total,
    composite: decisions.compositeImproved,
    phase: decisions.phase,
  },
  { delta: false, loss: true, total: true, composite: true, phase: true },
  "checkpoint gates must remain independent",
);

assert.equal(selectFinalWeightsMode("composite", { composite: true, delta: true }), "composite");
assert.equal(selectFinalWeightsMode("composite", { delta: true }), "delta");
assert.equal(selectFinalWeightsMode("swa", { swa: true, composite: true, delta: true }), "swa");
assert.equal(selectFinalWeightsMode("loss", { loss: true, delta: true }), "loss");
assert.equal(selectFinalWeightsMode("unknown", { delta: true }), "delta");
assert.equal(selectFinalWeightsMode("composite", {}), "current");

process.stdout.write("V9.5 checkpoint selection verified\n");
