import * as path from "node:path";
import { snapshotV95TrainingSource } from "../src/training/v95TrainingSource.js";

const args = process.argv.slice(2);
const refIndex = args.indexOf("--git-ref");
const gitRef = refIndex >= 0 ? args[refIndex + 1] : undefined;
const runDir = args.find((value, index) => index !== refIndex && index !== refIndex + 1);
if (!runDir) {
  throw new Error("Usage: snapshotV95TrainingSource.ts <run-dir> [--git-ref <commit>]");
}
const provenance = snapshotV95TrainingSource(path.resolve(runDir), { gitRef });
process.stdout.write(`${JSON.stringify(provenance, null, 2)}\n`);
