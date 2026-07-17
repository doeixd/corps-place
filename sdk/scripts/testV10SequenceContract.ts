
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { V10_FEATURE_SCHEMA } from "../src/training/v10FeatureSchema.js";

const dbIndex = process.argv.indexOf("--db");
const db = resolve(dbIndex >= 0 ? process.argv[dbIndex + 1]! : "./data/v10-training-dev1.db");
const sqlite = <T>(sql: string) => {
  const result = spawnSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return JSON.parse(result.stdout || "[]") as T[];
};
const summary = sqlite<Record<string, number>>(`SELECT
  COUNT(*) AS rows,
  SUM(CASE WHEN json_array_length(x_sequence_json)<>${V10_FEATURE_SCHEMA.sequenceLength} THEN 1 ELSE 0 END) AS bad_sequence_length,
  SUM(CASE WHEN json_array_length(json_extract(x_sequence_json,'$[0]'))<>${V10_FEATURE_SCHEMA.sequenceDim} THEN 1 ELSE 0 END) AS bad_sequence_dim,
  SUM(CASE WHEN json_array_length(x_static_json)<>${V10_FEATURE_SCHEMA.rawStaticDim} THEN 1 ELSE 0 END) AS bad_static_dim,
  SUM(CASE WHEN json_array_length(judge_indices_json)<>${V10_FEATURE_SCHEMA.judgeSlots} THEN 1 ELSE 0 END) AS bad_judge_slots,
  SUM(CASE WHEN builder_version<>'v10-clean-canonical-dev1-2026-07-16' THEN 1 ELSE 0 END) AS bad_builder,
  SUM(CASE WHEN reference_curves_version<>'v10-clean-artifacts-dev2' THEN 1 ELSE 0 END) AS bad_curves,
  SUM(CASE WHEN map_version<>'v10-clean-artifacts-dev2' THEN 1 ELSE 0 END) AS bad_maps
FROM ml_sequence_rows_v10_clean_control`)[0]!;
if (summary.rows !== 7317 || Object.entries(summary).some(([key, value]) => key !== "rows" && value !== 0)) {
  throw new Error(`V10 sequence dimensions/provenance failed: ${JSON.stringify(summary)}`);
}

const coverage = sqlite<Record<string, number>>(`SELECT
  (SELECT COUNT(*) FROM v10_training_performances) AS eligible,
  (SELECT COUNT(*) FROM v10_training_performances p LEFT JOIN ml_sequence_rows_v10_clean_control m
    ON m.season=p.season AND m.competition_slug=p.competition_slug AND m.division_name=p.division_name AND m.corps_key=p.model_corps_key
    WHERE m.row_id IS NULL) AS missing_eligible,
  (SELECT COUNT(*) FROM ml_sequence_rows_v10_clean_control m JOIN v10_training_performances p
    ON m.season=p.season AND m.competition_slug=p.competition_slug AND m.division_name=p.division_name AND m.corps_key=p.model_corps_key
    WHERE p.retrospective_panel_complete=0) AS included_ineligible`)[0]!;
if (coverage.eligible !== 7317 || coverage.missing_eligible !== 0 || coverage.included_ineligible !== 489) {
  throw new Error(`V10 panel eligibility mismatch: ${JSON.stringify(coverage)}`);
}

const captions = V10_FEATURE_SCHEMA.captions;
for (let index = 0; index < captions.length; index++) {
  const caption = captions[index]!;
  const mismatch = sqlite<{ count: number }>(`SELECT COUNT(*) AS count
    FROM ml_sequence_rows_v10_clean_control m
    JOIN v10_temporal_caption_features f
      ON f.row_key=m.season||'|'||m.competition_slug||'|'||m.division_name||'|'||m.corps_key AND f.caption='${caption}'
    WHERE ABS((json_extract(m.y_recap_json,'$.${caption}')-json_extract(m.y_residuals_json,'$.${caption}'))-f.reference_baseline)>0.00011
       OR ABS(json_extract(m.x_static_json,'$[${121 + index}]')-f.reference_baseline/20.0)>0.000001
       OR ABS(json_extract(m.x_static_json,'$[${113 + index}]')-(f.corps_elo_before-1500.0)/200.0)>0.000001`)[0]!.count;
  if (mismatch !== 0) throw new Error(`${caption} temporal builder parity mismatches: ${mismatch}`);
}

const artifactDir = "./src/training/v10/dev2";
const corpsMap = JSON.parse(readFileSync(`${artifactDir}/corpsIndexMap.json`, "utf8")) as Record<string, number>;
const showMap = JSON.parse(readFileSync(`${artifactDir}/showIndexMap.json`, "utf8")) as Record<string, number>;
const idRows = sqlite<{ corps_key: string; corps_id: number; competition_slug: string; agnostic_show_id: number; judge_indices_json: string }>(
  "SELECT corps_key,corps_id,competition_slug,agnostic_show_id,judge_indices_json FROM ml_sequence_rows_v10_clean_control",
);
const judgeMax = Math.max(...Object.values(JSON.parse(readFileSync(`${artifactDir}/judgeIndexMap.json`, "utf8")) as Record<string, number>));
for (const row of idRows) {
  const agnostic = row.competition_slug.replace(/^\d{4}-/, "");
  if (row.corps_id !== (corpsMap[row.corps_key] ?? 0) || row.agnostic_show_id !== (showMap[agnostic] ?? 0)) {
    throw new Error(`Identity-map mismatch for ${row.competition_slug}/${row.corps_key}`);
  }
  if ((JSON.parse(row.judge_indices_json) as number[]).some((id) => id < 0 || id > judgeMax)) {
    throw new Error(`Judge ID out of V10 map range for ${row.competition_slug}/${row.corps_key}`);
  }
}
process.stdout.write(`V10 sequence contract verified: ${summary.rows} clean rows with explicit unknown-panel IDs, temporal baseline/Elo, and identity parity\n`);
