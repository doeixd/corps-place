import assert from "node:assert/strict";
import {
  applyV9PredictionContextMode,
  V9_COLD_START_STATIC_OFFSET,
  V9_FEATURE_INDICES,
  V9_RAW_STATIC_DIM,
} from "../src/training/v9FeatureModes.js";
import {
  buildForecastBaseline,
  captionFingerprintBaselineAdjustments,
  selectV95Masking,
} from "../src/training/v95Masking.js";

const source = Array.from({ length: V9_RAW_STATIC_DIM }, (_, index) => 0.25 + index / 1000);
const original = [...source];
const recapMean = [14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5];
const masked = applyV9PredictionContextMode(source, {
  mode: "preseason_forecast",
  recapMean,
});

assert.deepEqual(source, original, "masking must not mutate its input");
assert.equal(masked.length, V9_RAW_STATIC_DIM);
assert.equal(masked[V9_FEATURE_INDICES.sequenceLength], 0);
assert.equal(masked[V9_FEATURE_INDICES.residualEma], 0);
assert.equal(masked[V9_FEATURE_INDICES.residualSlope], 0);
assert.equal(masked[V9_FEATURE_INDICES.residualVolatility], 0);
assert.equal(masked[V9_FEATURE_INDICES.daysSinceLastMatch], 1);
assert.equal(masked[V9_FEATURE_INDICES.showsRemaining], 0.5);
assert.equal(masked[V9_FEATURE_INDICES.pastShowsCount], 0);
assert.equal(masked[V9_FEATURE_INDICES.fieldSize], 20 / 25);

for (let index = V9_FEATURE_INDICES.performanceOrderStart; index <= V9_FEATURE_INDICES.performanceOrderEnd; index++) {
  assert.equal(masked[index], -1);
}
for (let index = V9_FEATURE_INDICES.opponentContextStart; index <= V9_FEATURE_INDICES.opponentContextEnd; index++) {
  assert.equal(masked[index], 0);
}
for (let index = V9_FEATURE_INDICES.judgeEloStart; index <= V9_FEATURE_INDICES.judgeEloEnd; index++) {
  assert.equal(masked[index], 0);
}
for (let caption = 0; caption < recapMean.length; caption++) {
  assert.equal(masked[V9_FEATURE_INDICES.rankBaselineStart + caption], recapMean[caption]! / 20);
}

for (let index = V9_COLD_START_STATIC_OFFSET; index < V9_COLD_START_STATIC_OFFSET + 10; index++) {
  assert.equal(masked[index], original[index], `cold-start slot ${index} must survive forecast masking`);
}
for (let index = V9_FEATURE_INDICES.captionFingerprintStart; index <= V9_FEATURE_INDICES.captionFingerprintEnd; index++) {
  assert.equal(masked[index], original[index], `fingerprint slot ${index} must survive forecast masking`);
}

const second = applyV9PredictionContextMode(original, {
  mode: "preseason_forecast",
  recapMean,
});
assert.deepEqual(masked, second, "forecast masking must be deterministic");

let zeroRateDraws = 0;
assert.deepEqual(
  selectV95Masking(() => { zeroRateDraws += 1; return 0; }, true, {
    history: 0,
    judges: 0,
    forecastContext: 0,
  }),
  { hideHistory: false, hideJudges: false, hideForecastContext: false },
);
assert.equal(zeroRateDraws, 0, "disabled masks must not consume RNG draws");

const seededRandom = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
};
const rng = seededRandom(42);
let forecastHidden = 0;
for (let index = 0; index < 1000; index++) {
  const decision = selectV95Masking(rng, true, {
    history: 0.15,
    judges: 0.25,
    forecastContext: 0.12,
  });
  if (decision.hideForecastContext) forecastHidden += 1;
}
assert.equal(forecastHidden, 113, "seeded 0.12 forecast masking contract drifted");

const fingerprintStat = new Array(V9_RAW_STATIC_DIM).fill(0);
fingerprintStat[V9_FEATURE_INDICES.captionFingerprintConfidence] = 1;
for (let caption = 0; caption < 8; caption++) {
  fingerprintStat[V9_FEATURE_INDICES.rankBaselineStart + caption] = 0.75;
  const start = V9_FEATURE_INDICES.captionFingerprintStart + caption * 4;
  fingerprintStat[start] = caption / 10;
  fingerprintStat[start + 1] = caption / 20;
}
const adjustments = captionFingerprintBaselineAdjustments(fingerprintStat);
assert.ok(Math.abs(adjustments.reduce((sum, value) => sum + value, 0)) < 1e-12);
assert.ok(adjustments.every((value) => value >= -0.6 && value <= 0.6));
const forecastBaseline = buildForecastBaseline(fingerprintStat, recapMean);
assert.deepEqual(
  forecastBaseline,
  adjustments.map((adjustment) => 15 + adjustment),
  "forecast baseline must combine rank curve and centered fingerprint residual",
);

process.stdout.write("V9.5 forecast-context masking verified\n");
