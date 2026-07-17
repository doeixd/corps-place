import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { V10_FIELD_PACE_FEATURE_SCHEMA } from "../src/training/v10FeatureSchema.js";

const dbIndex = process.argv.indexOf("--db");
const db = resolve(dbIndex >= 0 ? process.argv[dbIndex + 1]! : "./data/v10-field-dev1.db");
const sqlite = <T>(sql: string) => {
  const result = spawnSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return JSON.parse(result.stdout || "[]") as T[];
};
const sqliteText = (sql: string) => {
  const result = spawnSync("sqlite3", [db, sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return result.stdout;
};
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const summary = sqlite<Record<string, number>>(`SELECT
  (SELECT COUNT(*) FROM v10_temporal_field_pace) AS temporal_rows,
  (SELECT COUNT(*) FROM ml_sequence_rows_v10_field_pace) AS sequence_rows,
  (SELECT COUNT(*) FROM v10_temporal_field_pace f JOIN v10_training_performances p USING(row_key)
    WHERE f.as_of_date<>p.competition_date OR f.max_source_date>=p.competition_date) AS leakage_rows,
  (SELECT COUNT(*) FROM v10_temporal_field_pace
    WHERE confidence<0 OR confidence>1 OR prior_observation_count<0 OR prior_corps_count<0 OR prior_show_date_count<0) AS invalid_evidence,
  (SELECT COUNT(*) FROM ml_sequence_rows_v10_field_pace
    WHERE json_array_length(x_static_json)<>${V10_FIELD_PACE_FEATURE_SCHEMA.rawStaticDim}
       OR builder_version<>'v10-field-pace-dev1-2026-07-17') AS invalid_sequences
`)[0]!;
if (summary.temporal_rows !== 7317 || summary.sequence_rows !== 7317 || summary.leakage_rows !== 0 ||
  summary.invalid_evidence !== 0 || summary.invalid_sequences !== 0) {
  throw new Error(`V10 field-pace contract failed: ${JSON.stringify(summary)}`);
}

const firstDateFailures = sqlite<{ failures: number }>(`WITH first_dates AS (
  SELECT season,division_name,MIN(competition_date) AS first_date
  FROM v10_training_performances GROUP BY season,division_name
) SELECT COUNT(*) AS failures
FROM v10_temporal_field_pace f JOIN v10_training_performances p USING(row_key)
JOIN first_dates d USING(season,division_name)
WHERE p.competition_date=d.first_date AND (
  ABS(f.field_level_vs_reference)>0.000001 OR ABS(f.residual_ema)>0.000001 OR
  ABS(f.confidence)>0.000001 OR f.prior_observation_count<>0 OR
  f.prior_corps_count<>0 OR f.prior_show_date_count<>0
)`)[0]!.failures;
if (firstDateFailures !== 0) throw new Error(`First-date field state is contaminated: ${firstDateFailures}`);

const sameDateMismatches = sqlite<{ failures: number }>(`SELECT COUNT(*) AS failures FROM (
  SELECT p.season,p.division_name,p.competition_date,
    COUNT(DISTINCT printf('%.8f|%.8f|%.8f|%.8f',f.field_level_vs_reference,f.shrunk_residual_slope,f.residual_ema,f.confidence)) AS variants
  FROM v10_temporal_field_pace f JOIN v10_training_performances p USING(row_key)
  GROUP BY p.season,p.division_name,p.competition_date HAVING variants<>1
)`)[0]!.failures;
if (sameDateMismatches !== 0) throw new Error(`Same-date field snapshots diverge: ${sameDateMismatches}`);

const staticStart = V10_FIELD_PACE_FEATURE_SCHEMA.rawStaticDim - 4;
const builderMismatches = sqlite<{ failures: number }>(`SELECT COUNT(*) AS failures
FROM ml_sequence_rows_v10_field_pace m JOIN v10_temporal_field_pace f
  ON f.row_key=m.season||'|'||m.competition_slug||'|'||m.division_name||'|'||m.corps_key
WHERE ABS(json_extract(m.x_static_json,'$[${staticStart}]')-f.field_level_vs_reference/10.0)>0.000001
   OR ABS(json_extract(m.x_static_json,'$[${staticStart + 1}]')-f.shrunk_residual_slope/10.0)>0.000001
   OR ABS(json_extract(m.x_static_json,'$[${staticStart + 2}]')-f.residual_ema/10.0)>0.000001
   OR ABS(json_extract(m.x_static_json,'$[${staticStart + 3}]')-f.confidence)>0.000001`)[0]!.failures;
if (builderMismatches !== 0) throw new Error(`Field-pace builder parity mismatches: ${builderMismatches}`);

const baseline = JSON.parse(readFileSync("./src/training/baselines/v10-field-pace-dev1.json", "utf8")) as {
  field_provenance_sha256: string;
  field_sequence_sha256: string;
};
const provenanceHash = sha256(sqliteText(`SELECT row_key||'|'||printf('%.8f',field_level_vs_reference)||'|'||printf('%.8f',shrunk_residual_slope)||'|'||printf('%.8f',residual_ema)||'|'||printf('%.8f',confidence)||'|'||coalesce(max_source_date,'') FROM v10_temporal_field_pace ORDER BY row_key;`));
const sequenceHash = sha256(sqliteText(`SELECT season||'|'||competition_slug||'|'||division_name||'|'||corps_key||'|'||printf('%.8f',x_static_json ->> 212)||'|'||printf('%.8f',x_static_json ->> 213)||'|'||printf('%.8f',x_static_json ->> 214)||'|'||printf('%.8f',x_static_json ->> 215) FROM ml_sequence_rows_v10_field_pace ORDER BY season,competition_date,competition_slug,division_name,corps_key;`));
if (provenanceHash !== baseline.field_provenance_sha256 || sequenceHash !== baseline.field_sequence_sha256) {
  throw new Error(`Field-pace hashes changed: ${JSON.stringify({ provenanceHash, sequenceHash })}`);
}

process.stdout.write(`V10 field pace verified: ${summary.sequence_rows} rows, 4 strictly-prior features, same-date snapshots frozen\n`);
