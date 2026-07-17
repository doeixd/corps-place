import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { V10_FEATURE_SCHEMA } from "../src/training/v10FeatureSchema.js";

const valueAfter = (flag: string, fallback: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const db = resolve(valueAfter("--db", "./data/v10-evaluation-2026-07-17.db"));
const trainingDb = resolve(valueAfter("--training-db", "./data/v10-training-dev1.db"));
const baselinePath = resolve(valueAfter(
  "--baseline",
  "./src/training/baselines/v10-evaluation-sequences-2026-07-17.json",
));
const sqliteRaw = (database: string, sql: string, json = true) => {
  const result = spawnSync("sqlite3", json ? ["-json", database, sql] : [database, sql], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return result.stdout;
};
const sqlite = <T>(database: string, sql: string) =>
  JSON.parse(sqliteRaw(database, sql) || "[]") as T[];
const shaQuery = (database: string, sql: string) =>
  createHash("sha256").update(sqliteRaw(database, sql, false)).digest("hex");

const trainingIdentitySql = `
  SELECT row_key || '|' || printf('%.6f', total_score) || '|' ||
    printf('%.6f', GE1) || '|' || printf('%.6f', GE2) || '|' ||
    printf('%.6f', VP) || '|' || printf('%.6f', VA) || '|' ||
    printf('%.6f', CG) || '|' || printf('%.6f', MB) || '|' ||
    printf('%.6f', MA) || '|' || printf('%.6f', MP)
  FROM v10_training_performances WHERE CAST(season AS INTEGER)<=2025 ORDER BY row_key;
`;
const sequenceSummary = sqlite<Record<string, number | string>>(db, `SELECT
  COUNT(*) AS rows, COUNT(DISTINCT competition_slug) AS shows,
  MIN(competition_date) AS min_date, MAX(competition_date) AS max_date,
  SUM(CASE WHEN season<>'2026' THEN 1 ELSE 0 END) AS wrong_season,
  SUM(CASE WHEN json_array_length(x_sequence_json)<>${V10_FEATURE_SCHEMA.sequenceLength} THEN 1 ELSE 0 END) AS bad_sequence_length,
  SUM(CASE WHEN json_array_length(json_extract(x_sequence_json,'$[0]'))<>${V10_FEATURE_SCHEMA.sequenceDim} THEN 1 ELSE 0 END) AS bad_sequence_dim,
  SUM(CASE WHEN json_array_length(x_static_json)<>${V10_FEATURE_SCHEMA.rawStaticDim} THEN 1 ELSE 0 END) AS bad_static_dim,
  SUM(CASE WHEN json_array_length(judge_indices_json)<>${V10_FEATURE_SCHEMA.judgeSlots} THEN 1 ELSE 0 END) AS bad_judge_slots,
  SUM(CASE WHEN corps_id=0 THEN 1 ELSE 0 END) AS unknown_corps_rows,
  SUM(CASE WHEN agnostic_show_id=0 THEN 1 ELSE 0 END) AS unknown_show_rows,
  SUM(CASE WHEN EXISTS(SELECT 1 FROM json_each(judge_indices_json) WHERE value=0) THEN 1 ELSE 0 END) AS unknown_judge_rows,
  MAX(corps_id) AS max_corps_id, MAX(agnostic_show_id) AS max_show_id
FROM ml_sequence_rows_v10_clean_control`)[0]!;
const contractSummary = sqlite<Record<string, number | string>>(db, `SELECT
  COUNT(*) AS rows,
  SUM(CASE WHEN CAST(season AS INTEGER)<=2025 THEN 1 ELSE 0 END) AS training_rows,
  SUM(CASE WHEN season='2026' AND competition_date<='2026-07-14T23:59:59.999Z' THEN 1 ELSE 0 END) AS development_rows,
  SUM(CASE WHEN season='2026' AND competition_date>'2026-07-14T23:59:59.999Z' THEN 1 ELSE 0 END) AS untouched_rows
FROM v10_training_performances`)[0]!;
const temporalSummary = sqlite<Record<string, number>>(db, `SELECT
  (SELECT COUNT(*) FROM v10_temporal_caption_features f JOIN v10_training_performances p USING(row_key) WHERE p.season='2026') AS caption_rows,
  (SELECT COUNT(*) FROM v10_temporal_corps_history h JOIN v10_training_performances p USING(row_key) WHERE p.season='2026') AS history_rows,
  (SELECT COUNT(*) FROM v10_temporal_field_pace f JOIN v10_training_performances p USING(row_key) WHERE p.season='2026') AS field_rows,
  (SELECT COUNT(*) FROM v10_temporal_caption_features f JOIN v10_training_performances p USING(row_key) WHERE p.season='2026' AND f.as_of_date<>p.competition_date) AS caption_as_of_mismatches,
  (SELECT COUNT(*) FROM v10_temporal_corps_history h JOIN v10_training_performances p USING(row_key) WHERE p.season='2026' AND h.last_season_final_date>=p.competition_date) AS history_leaks,
  (SELECT COUNT(*) FROM v10_temporal_field_pace f JOIN v10_training_performances p USING(row_key) WHERE p.season='2026' AND f.max_source_date>=p.competition_date) AS field_leaks,
  (SELECT COUNT(*) FROM ml_sequence_rows_v10_clean_control m JOIN v10_training_performances p ON p.row_key=m.season||'|'||m.competition_slug||'|'||m.division_name||'|'||m.corps_key
    WHERE ABS(json_extract(m.y_recap_json,'$.GE1')-p.GE1)>0.000001
       OR ABS(json_extract(m.y_recap_json,'$.GE2')-p.GE2)>0.000001
       OR ABS(json_extract(m.y_recap_json,'$.VP')-p.VP)>0.000001
       OR ABS(json_extract(m.y_recap_json,'$.VA')-p.VA)>0.000001
       OR ABS(json_extract(m.y_recap_json,'$.CG')-p.CG)>0.000001
       OR ABS(json_extract(m.y_recap_json,'$.MB')-p.MB)>0.000001
       OR ABS(json_extract(m.y_recap_json,'$.MA')-p.MA)>0.000001
       OR ABS(json_extract(m.y_recap_json,'$.MP')-p.MP)>0.000001) AS target_mismatches
`)[0]!;
const metadata = Object.fromEntries(sqlite<{ key: string; value: string }>(db,
  "SELECT key,value FROM v10_data_contract_metadata ORDER BY key",
).map((row) => [row.key, row.value]));
const training2026Rows = sqlite<{ rows: number }>(trainingDb,
  "SELECT COUNT(*) AS rows FROM v10_training_performances WHERE season='2026'",
)[0]!.rows;

const computed = {
  contract: contractSummary,
  sequences: sequenceSummary,
  temporal: temporalSummary,
  metadata,
  training_db_2026_rows: training2026Rows,
  training_population_sha256: shaQuery(db, trainingIdentitySql),
  canonical_training_population_sha256: shaQuery(trainingDb, trainingIdentitySql),
  sequence_payload_sha256: shaQuery(db, `
    SELECT season||'|'||competition_slug||'|'||division_name||'|'||corps_key||'|'||
      x_sequence_json||'|'||x_static_json||'|'||judge_indices_json||'|'||y_recap_json
    FROM ml_sequence_rows_v10_clean_control
    ORDER BY season,competition_date,competition_slug,division_name,corps_key;
  `),
  development_cohort_sha256: shaQuery(db, `
    SELECT row_key||'|'||printf('%.6f',total_score) FROM v10_training_performances
    WHERE season='2026' AND competition_date<='2026-07-14T23:59:59.999Z' ORDER BY row_key;
  `),
  untouched_cohort_sha256: shaQuery(db, `
    SELECT row_key||'|'||printf('%.6f',total_score) FROM v10_training_performances
    WHERE season='2026' AND competition_date>'2026-07-14T23:59:59.999Z' ORDER BY row_key;
  `),
};

if (process.argv.includes("--print-baseline")) {
  process.stdout.write(`${JSON.stringify(computed, null, 2)}\n`);
} else {
  const expected = JSON.parse(readFileSync(baselinePath, "utf8"));
  assert.deepEqual(computed, expected);
  assert.equal(computed.training_population_sha256, computed.canonical_training_population_sha256);
  process.stdout.write(
    `V10 evaluation contract verified: ${sequenceSummary.rows} rows, ` +
    `${contractSummary.development_rows} development / ${contractSummary.untouched_rows} untouched\n`,
  );
}
