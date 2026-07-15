import assert from "node:assert/strict";
import {
  FINAL2_EVALUATION_LABELS,
  buildFinal2EvaluationRows,
  evaluationMaskRates,
  splitValidationRows,
  type EvaluationRow,
} from "../src/training/v95Evaluation.js";

const rows = Array.from({ length: 6 }, (_, showIndex) =>
  Array.from({ length: showIndex === 5 ? 3 : 2 }, (_, corpsIndex) => ({
    showKey: `show-${showIndex}`,
    date: `2025-07-${String(showIndex + 1).padStart(2, "0")}`,
    corpsKey: `corps-${corpsIndex}`,
  })),
).flat();

const forward = splitValidationRows(rows, {
  valMode: "date-forward",
  valSplit: 0.2,
  seed: 42,
});
assert.equal(forward.resolvedMode, "date-forward");
assert.deepEqual(new Set(forward.valRows.map((row) => row.showKey)), new Set(["show-5"]));
assert.equal(forward.valRows.length, 3, "a show must never be divided to hit a row target");
assert.equal(
  new Set(forward.trainRows.map((row) => row.showKey)).has("show-5"),
  false,
  "validation shows must not leak into training",
);

const cutoff = splitValidationRows(rows, {
  valMode: "date-forward",
  valSplit: 0.2,
  valDateCutoff: "2025-07-05",
  seed: 42,
});
assert.deepEqual(new Set(cutoff.valRows.map((row) => row.showKey)), new Set(["show-4", "show-5"]));

const randomA = splitValidationRows(rows, { valMode: "show-random", valSplit: 0.2, seed: 42 });
const randomB = splitValidationRows(rows, { valMode: "unexpected", valSplit: 0.2, seed: 42 });
assert.deepEqual(randomA, randomB, "unknown modes must deterministically resolve to show-random");

const evaluationRows: EvaluationRow[] = [
  {
    showKey: "world",
    date: "2025-07-01",
    division: "World Class",
    competitionSlug: "dci-world-championship-finals",
    seqMask: [true, true],
    stat: [1],
  },
  {
    showKey: "open",
    date: "2025-07-20",
    division: "Open Class",
    competitionSlug: "open-show",
    seqMask: [],
    stat: [0],
  },
];
const named = buildFinal2EvaluationRows(evaluationRows, evaluationRows, 0);
assert.deepEqual(Object.keys(named), [...FINAL2_EVALUATION_LABELS]);
assert.equal(named.test_world_class.length, 1);
assert.equal(named.test_open_class.length, 1);
assert.equal(named.test_championship_week.length, 1);
assert.equal(named.test_early_season.length, 1);
assert.equal(named.test_sparse_history.length, 2);
assert.equal(named.test_zero_history.length, 1);
assert.equal(named.test_season_debut.length, 1);
assert.equal(named.test_preseason_forecast.length, 1);

assert.deepEqual(evaluationMaskRates("test_all"), {
  history: 0, judges: 0, forecastContext: 0, lineup: 0,
});
assert.deepEqual(evaluationMaskRates("test_panel_unknown"), {
  history: 0, judges: 1, forecastContext: 0, lineup: 0,
});
assert.deepEqual(evaluationMaskRates("test_lineup_unknown"), {
  history: 0, judges: 0, forecastContext: 0, lineup: 1,
});
assert.deepEqual(evaluationMaskRates("test_preseason_forecast"), {
  history: 1, judges: 1, forecastContext: 1, lineup: 0,
});

process.stdout.write("V9.5 evaluation contract verified\n");
