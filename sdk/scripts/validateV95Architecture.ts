import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { V9_RAW_STATIC_DIM } from "../src/training/v9FeatureModes.js";

const sdkRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = fs.readFileSync(path.join(sdkRoot, "src/training/trainModelV95.ts"), "utf8");
const baseline = JSON.parse(fs.readFileSync(
  path.join(sdkRoot, "src/training/baselines/final2-baseline.json"),
  "utf8",
)) as {
  dimensions: Record<string, number>;
  architecture: Record<string, number | number[]>;
};

const checks: Array<[string, boolean]> = [
  ["raw static dimension", V9_RAW_STATIC_DIM === baseline.dimensions.raw_static_features],
  ["trend dimension", baseline.dimensions.trend_features === 8],
  ["model static dimension", V9_RAW_STATIC_DIM + 8 === baseline.dimensions.model_static_features],
  ["sequence shape", /tf\.input\(\{ shape: \[SEQ_LEN, FEAT_DIM\], name: "sequence" \}\)/.test(source)],
  ["static shape", /tf\.input\(\{ shape: \[TOTAL_STATIC_DIM\], name: "static" \}\)/.test(source)],
  ["first BiLSTM configurable", /units: args\.lstm1Units/.test(source)],
  ["second BiLSTM configurable", /units: args\.lstm2Units/.test(source)],
  ["first dense configurable", /units: args\.dense1Units/.test(source)],
  ["second dense configurable", /units: args\.dense2Units/.test(source)],
  ["accuracy trunk is configured", /units: args\.accuracyTrunkUnits,\s*activation: "relu",\s*name: "accuracy_trunk"/m.test(source)],
  ["final2 accuracy default", /const ACCURACY_TRUNK_UNITS = 270;/.test(source)],
  ["final2 judge cardinality", /const JUDGE_COUNT = 245;/.test(source)],
  ["final2 corps cardinality", /const CORPS_COUNT = 709;/.test(source)],
  ["final2 show cardinality", /const SHOW_COUNT = 349;/.test(source)],
  ["six output groups", /apply\(\[q10Delta, deltaQ50, q90Delta, recapHead, categoryHead, totalHead\]\)/.test(source)],
  ["ten model inputs", /inputs: \[seqInput, staticInput, maskInput, judgeIdsInput, corpsIdInput, baselineInput, historyLenInput, judgeBiasScaleInput, corpsScaleInput, agnosticShowInput\]/.test(source)],
];

const failures = checks.filter(([, passed]) => !passed).map(([label]) => label);
assert.deepEqual(failures, [], `V9.5 architecture checks failed: ${failures.join(", ")}`);
assert.deepEqual(baseline.architecture.bidirectional_lstm_units, [128, 64]);
assert.deepEqual(baseline.architecture.dense_trunk_units, [512, 256]);
assert.equal(baseline.architecture.accuracy_trunk_units, 270);
assert.equal(baseline.architecture.judge_embedding_input_dim, 245);
assert.equal(baseline.architecture.corps_embedding_input_dim, 709);
assert.equal(baseline.architecture.show_embedding_input_dim, 349);

process.stdout.write(`V9.5 architecture verified: ${checks.length + 6} checks passed\n`);
