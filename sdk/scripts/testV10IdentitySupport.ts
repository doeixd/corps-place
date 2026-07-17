import assert from "node:assert/strict";
import {
  evidenceTrust,
  loadV10IdentitySupport,
  supportAugmentationEnabled,
  supportAdjustedDropout,
  supportResidualGate,
  temporalIdentityTrust,
} from "../src/training/v10IdentitySupport.js";

assert.equal(evidenceTrust(0, 0), 0);
assert.equal(evidenceTrust(80, 3), 1);
assert.ok(evidenceTrust(4, 1) < evidenceTrust(40, 2));
assert.ok(Math.abs(supportAdjustedDropout(0.05, 1) - 0.05) < 1e-12);
assert.ok(supportAdjustedDropout(0.05, 0) > 0.6);
assert.equal(supportResidualGate(1, true), 1);
assert.equal(supportResidualGate(0, true), 0.2);
assert.equal(supportResidualGate(1, false), 0);
assert.equal(supportAugmentationEnabled(true, 0.05), true);
assert.equal(supportAugmentationEnabled(true, 0), false);
assert.equal(supportAugmentationEnabled(false, 0.05), false);

const loaded = loadV10IdentitySupport(
  "./src/training/v10/dev3/identitySupport.json",
  "./src/training/v10/dev3/judgeIndexMap.json",
  "./src/training/v10/dev3/showIndexMap.json",
);
assert.equal(loaded.version, "v10-identity-support-dev1");
assert.equal(loaded.corpsTrustByKey.size, 55);
assert.equal(loaded.judgeTrustByIndex.size, 211);
assert.equal(loaded.judgeTrustByIndex.get(0), 0);
assert.equal(loaded.showTrustByIndex.size, 290);
assert.equal(loaded.showTrustByIndex.get(0), 0);
assert.ok([...loaded.corpsTrustByKey.values()].every((value) => value > 0 && value <= 1));

const temporalRows = [
  { date: "2024-07-01T00:00:00.000Z", season: "2024", corpsKey: "a", judgeIndices: [1, 2], showIndex: 1 },
  { date: "2024-07-01T12:00:00.000Z", season: "2024", corpsKey: "a", judgeIndices: [1, 3], showIndex: 1 },
  { date: "2024-07-02T00:00:00.000Z", season: "2024", corpsKey: "a", judgeIndices: [1, 2], showIndex: 1 },
  { date: "2025-06-30T00:00:00.000Z", season: "2025", corpsKey: "a", judgeIndices: [1, 0], showIndex: 2 },
] as const;
const temporal = temporalIdentityTrust(temporalRows);
assert.deepEqual(temporal[0], { corpsTrust: 0, judgeTrust: [0, 0], showTrust: 0 });
assert.deepEqual(temporal[1], { corpsTrust: 0, judgeTrust: [0, 0], showTrust: 0 });
assert.equal(temporal[2]!.corpsTrust, evidenceTrust(2, 1));
assert.deepEqual(temporal[2]!.judgeTrust, [evidenceTrust(2, 1), evidenceTrust(1, 1)]);
assert.equal(temporal[2]!.showTrust, evidenceTrust(2, 1));
assert.equal(temporal[3]!.corpsTrust, evidenceTrust(3, 1));
assert.deepEqual(temporal[3]!.judgeTrust, [evidenceTrust(3, 1), 0]);
assert.equal(temporal[3]!.showTrust, 0);

const withoutFuture = temporalIdentityTrust(temporalRows.slice(0, 3));
assert.deepEqual(withoutFuture, temporal.slice(0, 3));

process.stdout.write("V10 support-aware identity policy verified\n");
