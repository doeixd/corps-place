import assert from "node:assert/strict";
import {
  addMetricValue,
  createMetricBucket,
  forecastMode,
  historyBucket,
  identityAvailabilityMode,
  identitySupportBucket,
  mapBuckets,
  pearsonCorrelation,
  seasonPhase,
  summarizeBucket,
} from "../src/training/v95Metrics.js";

const bucket = createMetricBucket();
Object.assign(bucket, {
  rows: 2,
  captionCount: 4,
  deltaAbs: 2,
  recapAbs: 1,
  categoryAbs: 3,
  totalAbs: 4,
  coverageWithin: 3,
  width: 8,
  widthFloor: 1,
});
assert.deepEqual(summarizeBucket(bucket), {
  rows: 2,
  caption_values: 4,
  delta_mae_pts: 0.5,
  recap_mae_pts: 0.25,
  category_mae_pts: 1.5,
  total_mae_pts: 2,
  coverage: 0.75,
  width: 2,
  width_floor_pct: 0.25,
});

const buckets = {};
addMetricValue(buckets, "World Class", (value) => { value.rows += 1; });
addMetricValue(buckets, "World Class", (value) => { value.captionCount += 8; });
assert.equal(mapBuckets(buckets)["World Class"]?.rows, 1);
assert.equal(mapBuckets(buckets)["World Class"]?.caption_values, 8);

assert.equal(seasonPhase("2025-07-07"), "early");
assert.equal(seasonPhase("2025-07-08"), "mid");
assert.equal(seasonPhase("2025-08-01"), "late");
assert.deepEqual([0, 1, 2, 4, 5].map(historyBucket), [
  "zero_history",
  "sparse_history",
  "short_history",
  "short_history",
  "established_history",
]);
assert.deepEqual([0, 0.1, 0.2, 0.49, 0.5, 1].map(identitySupportBucket), [
  "no_prior_support",
  "low_support",
  "medium_support",
  "medium_support",
  "established_support",
  "established_support",
]);
assert.equal(identityAvailabilityMode({ sourceKnown: true, inputKnown: true, explicitlyHidden: false }), "known");
assert.equal(identityAvailabilityMode({ sourceKnown: false, inputKnown: false, explicitlyHidden: false }), "source_unknown");
assert.equal(identityAvailabilityMode({ sourceKnown: true, inputKnown: false, explicitlyHidden: false }), "augmentation_hidden");
assert.equal(identityAvailabilityMode({ sourceKnown: true, inputKnown: false, explicitlyHidden: true }), "explicitly_hidden");
assert.equal(identityAvailabilityMode({ sourceKnown: false, inputKnown: false, explicitlyHidden: true }), "explicitly_hidden_source_unknown");

const clearFlags = {
  forecastContextHidden: false,
  lineupContextHidden: false,
  historyHidden: false,
  seasonDebut: false,
  firstSeasonEvent: false,
};
assert.equal(forecastMode(clearFlags), "observed_history");
assert.equal(forecastMode({ ...clearFlags, seasonDebut: true }), "season_debut");
assert.equal(
  forecastMode({ ...clearFlags, forecastContextHidden: true, seasonDebut: true }),
  "forecast_context_hidden",
);
assert.equal(pearsonCorrelation([1, 2, 3], [2, 4, 6]), 1);
assert.equal(pearsonCorrelation([1, 1, 1], [2, 3, 4]), null);

process.stdout.write("V9.5 metric helpers verified\n");
