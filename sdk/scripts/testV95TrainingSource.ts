import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotV95TrainingSource } from "../src/training/v95TrainingSource.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "v95-source-"));
try {
  const provenance = snapshotV95TrainingSource(root, { argv: ["--seed", "43"] });
  assert.ok(provenance.git_commit.length >= 7);
  assert.deepEqual(provenance.argv, ["--seed", "43"]);
  assert.ok(provenance.files.some((entry) => entry.path === "src/training/trainModelV95.ts"));
  assert.ok(fs.existsSync(path.join(root, "training-source", "provenance.json")));
  assert.ok(fs.existsSync(path.join(root, "training-source", "src/training/v95Config.ts")));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write("V9.5 training-source snapshot verified\n");
