import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(sdkRoot, "..");

const coreFiles = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "src/buildMlSequencesV9Subcaption.ts",
  "src/training/trainModelV95.ts",
  "src/training/trainModelV10Final.ts",
  "src/training/v10Config.ts",
  "src/training/v10FeatureSchema.ts",
  "src/training/v10/dev1/manifest.json",
  "src/training/v10/dev1/referenceCurves.json",
  "src/training/v10/dev1/judgeIndexMap.json",
  "src/training/v10/dev1/corpsIndexMap.json",
  "src/training/v10/dev1/corpsAliasMap.json",
  "src/training/v10/dev1/identitySupport.json",
  "src/training/v10/dev1/showIndexMap.json",
  "src/training/baselines/v10-source-2026-07-16.json",
  "src/training/baselines/v10-training-performances-dev1.json",
  "src/training/baselines/v10-sequences-dev1.json",
  "src/training/baselines/v10-field-pace-dev1.json",
  "src/training/v95TrainingSource.ts",
  "src/training/v95Config.ts",
  "src/training/v95Curriculum.ts",
  "src/training/v95Evaluation.ts",
  "src/training/v95Checkpoints.ts",
  "src/training/v95Masking.ts",
  "src/training/v95Metrics.ts",
  "src/training/v9FeatureModes.ts",
  "src/training/v9SubcaptionInference.ts",
  "src/training/referenceCurvesV4.json",
  "src/training/judgeIndexMap.json",
  "src/training/corpsIndexMap.json",
  "scripts/freezeV10Source.ts",
  "scripts/prepareV10TrainingData.ts",
  "scripts/prepareV10TemporalFeatures.ts",
  "scripts/generateV10Artifacts.ts",
  "scripts/testV10TemporalFeatures.ts",
  "scripts/testV10SequenceContract.ts",
  "scripts/testV10FieldPace.ts",
] as const;

const runScripts = () => fs.readdirSync(path.join(sdkRoot, "scripts"))
  .filter((name) => /^runV(?:95|10).*\.sh$/.test(name))
  .sort()
  .map((name) => `scripts/${name}`);

const git = (args: string[]) => execFileSync("git", args, {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
}).trim();

const hash = (contents: Buffer) => crypto.createHash("sha256").update(contents).digest("hex");

export const snapshotV95TrainingSource = (
  runDir: string,
  options: { argv?: readonly string[]; gitRef?: string } = {},
) => {
  const sourceDir = path.join(runDir, "training-source");
  fs.mkdirSync(sourceDir, { recursive: true });
  const requestedRef = options.gitRef;
  const resolvedCommit = git(["rev-parse", requestedRef ?? "HEAD"]);
  const copied: Array<{ path: string; sha256: string }> = [];

  for (const relativePath of [...coreFiles, ...runScripts()]) {
    let contents: Buffer;
    try {
      contents = requestedRef
        ? execFileSync("git", ["show", `${resolvedCommit}:sdk/${relativePath}`], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "ignore"],
          })
        : fs.readFileSync(path.join(sdkRoot, relativePath));
    } catch {
      continue;
    }
    const destination = path.join(sourceDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
    copied.push({ path: relativePath, sha256: hash(contents) });
  }

  const dirty = requestedRef
    ? false
    : git(["status", "--porcelain", "--untracked-files=no"]).length > 0;
  const provenance = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    git_commit: resolvedCommit,
    git_ref_requested: requestedRef ?? null,
    git_worktree_dirty: dirty,
    cwd: process.cwd(),
    argv: [...(options.argv ?? process.argv.slice(2))],
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    files: copied,
  };
  fs.writeFileSync(
    path.join(sourceDir, "provenance.json"),
    JSON.stringify(provenance, null, 2),
  );
  fs.writeFileSync(
    path.join(sourceDir, "README.md"),
    "# Training source snapshot\n\n" +
    "This directory contains the exact V9.5/V10 trainer inputs captured for this run. " +
      "`provenance.json` records the commit, command arguments, and SHA-256 of every copied file.\n",
  );
  return provenance;
};
