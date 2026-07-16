import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const valueFor = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const valuesFor = (flag: string) => argv.flatMap((value, index) =>
  value === flag && argv[index + 1] ? [argv[index + 1]!] : []
);
const specs = valuesFor("--report").length ? valuesFor("--report") : [
  "final2=results/v95-2026-final2.json",
  "seed42=results/v95-2026-seed42.json",
  "seed43=results/v95-2026-seed43.json",
];

const reports = specs.map((spec) => {
  const separator = spec.indexOf("=");
  if (separator <= 0) throw new Error(`Expected --report label=path, got: ${spec}`);
  const id = spec.slice(0, separator);
  const report = JSON.parse(fs.readFileSync(path.resolve(sdkRoot, spec.slice(separator + 1)), "utf8")) as any;
  return { id, report };
});
const reference = reports.find(({ id }) => id === "final2");
if (!reference) throw new Error("A final2 report is required as the 2026 reference");
const cohortHash = reference.report.cohort.identities_sha256;
for (const { id, report } of reports) {
  if (report.cohort.identities_sha256 !== cohortHash) throw new Error(`${id} uses a different 2026 cohort`);
  if (report.identity_mode !== "agnostic") throw new Error(`${id} is not identity-agnostic`);
}

const metric = (report: any) => ({
  recap: report.raw.metrics.recap_mae_pts,
  total: report.raw.metrics.total_mae_pts,
  rawCoverage: report.raw.metrics.coverage,
  calibratedCoverage: report.calibrated.metrics.coverage,
  zero: report.raw.by_history.zero_history.total_mae_pts,
  sparse: report.raw.by_history.sparse_history.total_mae_pts,
  short: report.raw.by_history.short_history.total_mae_pts,
  established: report.raw.by_history.established_history.total_mae_pts,
});
const baselineMetrics = metric(reference.report);
const f = (value: number) => value.toFixed(4);
const delta = (value: number, baselineValue: number) =>
  `${value - baselineValue >= 0 ? "+" : ""}${f(value - baselineValue)}`;
const rows = reports.map(({ id, report }) => ({ id, ...metric(report) }));
const markdown = [
  "# V9.5 early-2026 out-of-time comparison",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  `Frozen cohort: ${reference.report.cohort.rows} rows / ${reference.report.cohort.shows} shows, ` +
    `${reference.report.cohort.date_min} through ${reference.report.cohort.date_max}`,
  "",
  `Cohort identity SHA-256: \`${cohortHash}\``,
  "",
  "All models are evaluated identity-agnostically: corps, judge, and show residual paths are disabled because current 2026 integer maps are not semantically compatible with final2's frozen maps.",
  "",
  "| Model | Recap MAE | Δ final2 | Total MAE | Δ final2 | Raw coverage | Cal coverage |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...rows.map((row) =>
    `| ${row.id} | ${f(row.recap)} | ${delta(row.recap, baselineMetrics.recap)} | ` +
    `${f(row.total)} | ${delta(row.total, baselineMetrics.total)} | ` +
    `${f(row.rawCoverage)} | ${f(row.calibratedCoverage)} |`
  ),
  "",
  "| Model | Zero-history total | Sparse total | Short total | Established total* |",
  "|---|---:|---:|---:|---:|",
  ...rows.map((row) =>
    `| ${row.id} | ${f(row.zero)} | ${f(row.sparse)} | ${f(row.short)} | ${f(row.established)} |`
  ),
  "",
  "*Established history contains only seven rows and is descriptive.",
  "",
  "These results are an out-of-time generalization comparison, not a checkpoint selector. The cohort has now been inspected and is development validation; later 2026 shows must provide the next untouched test.",
  "",
].join("\n");
const output = valueFor("--output");
if (output) fs.writeFileSync(path.resolve(sdkRoot, output), markdown);
process.stdout.write(markdown);
