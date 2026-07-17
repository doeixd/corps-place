import assert from "node:assert/strict";
import {
  checkpointDecisions,
  paretoCheckpointSelectorScore,
  paretoDominates,
  productionCompositeScore,
  selectFinalWeightsMode,
  updateParetoCheckpointFrontier,
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

const paretoBase = {
  recapMae: 0.35,
  totalMae: 0.9,
  zeroHistoryMae: 2.2,
  sparseHistoryMae: 1.8,
  establishedHistoryMae: 0.32,
  coverage: 0.82,
  width: 1.1,
};
assert.ok(paretoCheckpointSelectorScore(paretoBase, 0.8, 0.85) > 0);
assert.equal(paretoDominates(paretoBase, { ...paretoBase, recapMae: 0.4 }, 0.8, 0.85), true);
assert.equal(paretoDominates(paretoBase, { ...paretoBase, recapMae: 0.3, totalMae: 1.1 }, 0.8, 0.85), false);

let frontier = updateParetoCheckpointFrontier([], 1, paretoBase, 3, 0.8, 0.85).frontier;
frontier = updateParetoCheckpointFrontier(frontier, 2, { ...paretoBase, recapMae: 0.3, totalMae: 1.1 }, 3, 0.8, 0.85).frontier;
const dominated = updateParetoCheckpointFrontier(frontier, 3, { ...paretoBase, recapMae: 0.5 }, 3, 0.8, 0.85);
assert.equal(dominated.retained, false);
assert.deepEqual(dominated.frontier.map((entry) => entry.epoch), [1, 2]);
for (let epoch = 4; epoch <= 12; epoch++) {
  frontier = updateParetoCheckpointFrontier(frontier, epoch, {
    ...paretoBase,
    recapMae: 0.25 + epoch * 0.01,
    totalMae: 1.4 - epoch * 0.03,
    sparseHistoryMae: 2.2 - epoch * 0.04,
  }, 3, 0.8, 0.85).frontier;
}
assert.ok(frontier.length <= 3);
assert.equal(new Set(frontier.map((entry) => entry.epoch)).size, frontier.length);

process.stdout.write("V9.5 checkpoint selection verified\n");
