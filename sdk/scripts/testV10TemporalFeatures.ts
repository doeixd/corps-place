
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const dbIndex = process.argv.indexOf("--db");
const db = resolve(dbIndex >= 0 ? process.argv[dbIndex + 1]! : "./data/v10-training-dev1.db");
const sqlite = <T>(sql: string) => {
  const result = spawnSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return JSON.parse(result.stdout || "[]") as T[];
};
const summary = sqlite<Record<string, number>>(`SELECT
  (SELECT COUNT(*) FROM v10_training_performances) AS performances,
  (SELECT COUNT(*) FROM v10_temporal_caption_features) AS captions,
  (SELECT COUNT(*) FROM v10_temporal_corps_history) AS histories,
  (SELECT COUNT(*) FROM v10_temporal_judge_elo) AS judges,
  (SELECT COUNT(*) FROM v10_temporal_caption_features f JOIN v10_training_performances p USING(row_key) WHERE f.as_of_date<>p.competition_date) AS caption_date_mismatches,
  (SELECT COUNT(*) FROM v10_temporal_corps_history h JOIN v10_training_performances p USING(row_key) WHERE h.last_season_final_date>=p.competition_date) AS future_history_rows,
  (SELECT COUNT(*) FROM v10_temporal_judge_elo j JOIN v10_training_performances p ON p.competition_slug=j.competition_slug AND p.division_name=j.division_name WHERE j.as_of_date<>p.competition_date) AS judge_date_mismatches,
  (SELECT COUNT(*) FROM v10_temporal_caption_features WHERE reference_baseline IS NULL OR prior_range_min IS NULL OR prior_range_max IS NULL OR corps_elo_before IS NULL) AS null_features
`)[0]!;
if (
  summary.performances !== 7317 || summary.captions !== 7317 * 8 || summary.histories !== 7317 ||
  summary.judges <= 0 || summary.caption_date_mismatches !== 0 || summary.future_history_rows !== 0 ||
  summary.judge_date_mismatches !== 0 || summary.null_features !== 0
) throw new Error(`V10 temporal contract failed: ${JSON.stringify(summary)}`);

const firstDate = sqlite<{ competition_date: string }>("SELECT MIN(competition_date) AS competition_date FROM v10_training_performances")[0]!.competition_date;
const firstDateFailures = sqlite<{ failures: number }>(`SELECT COUNT(*) AS failures
  FROM v10_temporal_caption_features f JOIN v10_training_performances p USING(row_key)
  JOIN v10_temporal_corps_history h USING(row_key)
  WHERE p.competition_date='${firstDate.replaceAll("'", "''")}'
    AND (ABS(f.reference_baseline-15)>0.000001 OR ABS(f.corps_elo_before-1500)>0.000001 OR h.years_in_world_class<>0)`)[0]!.failures;
if (firstDateFailures !== 0) throw new Error(`Earliest-date temporal defaults are contaminated: ${firstDateFailures}`);

const firstCorpsEloFailures = sqlite<{ failures: number }>(`WITH firsts AS (
  SELECT p.season,p.division_name,p.model_corps_key,f.caption,MIN(p.competition_date) AS first_date
  FROM v10_training_performances p JOIN v10_temporal_caption_features f USING(row_key)
  GROUP BY p.season,p.division_name,p.model_corps_key,f.caption
) SELECT COUNT(*) AS failures FROM firsts x
  JOIN v10_training_performances p ON p.season=x.season AND p.division_name=x.division_name AND p.model_corps_key=x.model_corps_key AND p.competition_date=x.first_date
  JOIN v10_temporal_caption_features f ON f.row_key=p.row_key AND f.caption=x.caption
  WHERE ABS(f.corps_elo_before-1500)>0.000001`)[0]!.failures;
if (firstCorpsEloFailures !== 0) throw new Error(`First corps Elo is not neutral: ${firstCorpsEloFailures}`);

process.stdout.write(`V10 temporal features verified: ${summary.performances} rows, ${summary.captions} caption cells, ${summary.judges} judge states\n`);

