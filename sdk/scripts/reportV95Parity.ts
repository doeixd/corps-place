import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);

const valuesFor = (flag: string) => argv.flatMap((value, index) =>
  value === flag && argv[index + 1] ? [argv[index + 1]!] : []
);
const valueFor = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sparsePolicy = valueFor("--sparse-policy") ?? "per-seed";
if (sparsePolicy !== "per-seed" && sparsePolicy !== "pooled") {
  throw new Error(`Expected --sparse-policy per-seed|pooled, got: ${sparsePolicy}`);
}

const baseline = JSON.parse(fs.readFileSync(
  path.join(sdkRoot, "src/training/baselines/final2-baseline.json"),
  "utf8",
)) as any;

const thresholds = {
  validationRecapEach: baseline.metrics.validation.recap_mae_pts + 0.030,
  validationRecapMean: baseline.metrics.validation.recap_mae_pts + 0.020,
  validationTotalEach: baseline.metrics.validation.total_mae_pts + 0.120,
  validationTotalMean: baseline.metrics.validation.total_mae_pts + 0.080,
  calibratedCoverageMin: 0.78,
  calibratedCoverageMax: 0.87,
  rawCoverageMin: 0.93,
  establishedTotal: baseline.metrics.history_total_mae.established_history + 0.100,
  sparseTotal: baseline.metrics.history_total_mae.sparse_history + 0.300,
  zeroTotal: baseline.metrics.history_total_mae.zero_history + 0.300,
  composite: 0.5025684126513721 + 0.050,
};

const defaultCandidates = [
  "seed42=models/v95_final2_reconstruction/v95_final2_seed42_1784145026981",
  "seed43=models/v95_final2_reconstruction/v95_final2_seed43_1784199195605",
];
const candidateSpecs = valuesFor("--candidate");
const specs = candidateSpecs.length ? candidateSpecs : defaultCandidates;

const readCandidate = (spec: string) => {
  const separator = spec.indexOf("=");
  if (separator <= 0) throw new Error(`Expected --candidate label=path, got: ${spec}`);
  const id = spec.slice(0, separator);
  const modelDir = path.resolve(sdkRoot, spec.slice(separator + 1));
  const card = JSON.parse(fs.readFileSync(path.join(modelDir, "model-card.json"), "utf8")) as any;
  const argsPath = path.join(modelDir, "training-args.json");
  const args = fs.existsSync(argsPath) ? JSON.parse(fs.readFileSync(argsPath, "utf8")) : {};
  const validation = card.evaluations.validation;
  const metrics = validation.metrics;
  const calibrated = validation.calibrated.metrics;
  const history = validation.by_history;
  const checkpoint = card.checkpoints.best_composite;
  const measured = {
    validation_recap_mae: metrics.recap_mae_pts,
    validation_total_mae: metrics.total_mae_pts,
    raw_coverage: metrics.coverage,
    calibrated_coverage: calibrated.coverage,
    calibrated_width: calibrated.width,
    established_total_mae: history.established_history?.total_mae_pts ?? null,
    sparse_total_mae: history.sparse_history?.total_mae_pts ?? null,
    zero_total_mae: history.zero_history?.total_mae_pts ?? null,
    best_composite: checkpoint.value,
  };
  const gates = {
    validation_recap: measured.validation_recap_mae <= thresholds.validationRecapEach,
    validation_total: measured.validation_total_mae <= thresholds.validationTotalEach,
    raw_coverage: measured.raw_coverage >= thresholds.rawCoverageMin,
    calibrated_coverage: measured.calibrated_coverage >= thresholds.calibratedCoverageMin &&
      measured.calibrated_coverage <= thresholds.calibratedCoverageMax,
    established_history: measured.established_total_mae !== null &&
      measured.established_total_mae <= thresholds.establishedTotal,
    sparse_history: measured.sparse_total_mae !== null &&
      measured.sparse_total_mae <= thresholds.sparseTotal,
    zero_history: measured.zero_total_mae !== null && measured.zero_total_mae <= thresholds.zeroTotal,
    composite: measured.best_composite <= thresholds.composite,
  };
  return {
    id,
    seed: args.seed ?? card.config?.seed ?? null,
    model_dir: path.relative(sdkRoot, modelDir).replaceAll("\\", "/"),
    measured,
    gates,
    core_pass: Object.entries(gates).filter(([gate]) => gate !== "sparse_history").every(([, pass]) => pass),
    pass: Object.values(gates).every(Boolean),
  };
};

const candidates = specs.map(readCandidate);
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const recapValues = candidates.map((candidate) => candidate.measured.validation_recap_mae);
const totalValues = candidates.map((candidate) => candidate.measured.validation_total_mae);
const sparseValues = candidates.flatMap((candidate) =>
  candidate.measured.sparse_total_mae === null ? [] : [candidate.measured.sparse_total_mae]
);
const sparseMean = sparseValues.length ? mean(sparseValues) : null;
const aggregate = {
  seed_count: candidates.length,
  validation_recap_mean: mean(recapValues),
  validation_recap_range: Math.max(...recapValues) - Math.min(...recapValues),
  validation_total_mean: mean(totalValues),
  validation_total_range: Math.max(...totalValues) - Math.min(...totalValues),
  sparse_history_mean: sparseMean,
  sparse_history_range: sparseValues.length
    ? Math.max(...sparseValues) - Math.min(...sparseValues)
    : null,
  gates: {
    required_seeds: candidates.length >= 2,
    validation_recap_mean: mean(recapValues) <= thresholds.validationRecapMean,
    validation_total_mean: mean(totalValues) <= thresholds.validationTotalMean,
    every_candidate: sparsePolicy === "pooled"
      ? candidates.every((candidate) => candidate.core_pass)
      : candidates.every((candidate) => candidate.pass),
    sparse_history: sparsePolicy === "pooled"
      ? sparseMean !== null && sparseMean <= thresholds.sparseTotal
      : candidates.every((candidate) => candidate.gates.sparse_history),
  },
};
const report = {
  schema_version: 2,
  generated_at: new Date().toISOString(),
  baseline: baseline.id,
  sparse_history_policy: sparsePolicy,
  thresholds,
  candidates,
  aggregate,
  pass: Object.values(aggregate.gates).every(Boolean),
};

const f = (value: number | null, digits = 4) => value === null ? "n/a" : value.toFixed(digits);
const mark = (value: boolean) => value ? "PASS" : "FAIL";
const markdown = [
  "# V9.5 parity report",
  "",
  `Generated: ${report.generated_at}`,
  "",
  sparsePolicy === "pooled"
    ? "This treatment report applies the Milestone 1 tolerances, with the documented pooled two-seed policy for the nine-row sparse-history stability guardrail."
    : "This report applies the predeclared Milestone 1 tolerances from `V10_MODEL_PLAN.md`.",
  "",
  "| Candidate | Seed | Val recap | Val total | Cal coverage | Established total | Sparse total | Zero total | Composite | Result |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ...candidates.map((candidate) =>
    `| ${candidate.id} | ${candidate.seed ?? "n/a"} | ${f(candidate.measured.validation_recap_mae)} | ` +
    `${f(candidate.measured.validation_total_mae)} | ${f(candidate.measured.calibrated_coverage)} | ` +
    `${f(candidate.measured.established_total_mae)} | ${f(candidate.measured.sparse_total_mae)} | ` +
    `${f(candidate.measured.zero_total_mae)} | ${f(candidate.measured.best_composite)} | ` +
    (sparsePolicy === "pooled" && candidate.core_pass && !candidate.gates.sparse_history
      ? "CORE PASS (sparse pooled) |"
      : `${mark(candidate.pass)}${candidate.pass ? "" : ` (${Object.entries(candidate.gates).filter(([, pass]) => !pass).map(([gate]) => gate).join(", ")})`} |`)
  ),
  "",
  `Two-seed recap mean/range: ${f(aggregate.validation_recap_mean)}/${f(aggregate.validation_recap_range)}`,
  "",
  `Two-seed total mean/range: ${f(aggregate.validation_total_mean)}/${f(aggregate.validation_total_range)}`,
  "",
  `Sparse-history policy: ${sparsePolicy}; mean/range: ${f(aggregate.sparse_history_mean)}/${f(aggregate.sparse_history_range)}`,
  "",
  `Overall Milestone 1 result: **${mark(report.pass)}**`,
  "",
  "A passing reconstruction gate establishes V9.5 trainer parity. It does not establish that an improvement candidate beats final2; that requires the frozen terminal checkpoint comparison.",
  "",
].join("\n");

const output = valueFor("--output");
if (output) fs.writeFileSync(path.resolve(sdkRoot, output), markdown);
if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(markdown);
if (!report.pass) process.exitCode = 1;
