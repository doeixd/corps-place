import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_CONTRACT_VERSION = "v10-training-performances-dev1";
const DEFAULT_TRAINING_SEASONS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2022, 2023, 2024, 2025] as const;

const valueAfter = (flag: string, fallback?: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const includedSeasons = (valueAfter("--seasons")
  ? valueAfter("--seasons")!.split(",").map((value) => Number(value.trim()))
  : [...DEFAULT_TRAINING_SEASONS]).filter((value) => Number.isInteger(value));
if (!includedSeasons.length) throw new Error("--seasons must contain at least one integer season");
const contractVersion = valueAfter("--contract-version", DEFAULT_CONTRACT_VERSION)!;
const purpose = valueAfter("--purpose", "training")!;
if (purpose !== "training" && purpose !== "evaluation") throw new Error("--purpose must be training or evaluation");
const expectedRows = Number(valueAfter("--expected-rows", "7317"));
if (!Number.isInteger(expectedRows) || expectedRows < 1) throw new Error("--expected-rows must be a positive integer");
const trainingCutoffSeason = Number(valueAfter("--training-cutoff-season", "2025"));
const developmentCutoff = valueAfter("--development-cutoff", "2026-07-14T23:59:59.999Z")!;
const source = resolve(valueAfter("--source", "./data/v10-source-2026-07-16.db")!);
const output = resolve(valueAfter("--out", "./data/v10-training-dev1.db")!);
const sourceManifestPath = resolve(
  valueAfter("--source-manifest", "./src/training/baselines/v10-source-2026-07-16.json")!,
);
const manifestPath = resolve(valueAfter("--manifest", `${output}.manifest.json`)!);

const sqliteRaw = (db: string, sql: string, json = true) => {
  const args = json ? ["-json", db, sql] : [db, sql];
  const result = spawnSync("sqlite3", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return result.stdout;
};
const sqlite = (db: string, sql: string) =>
  JSON.parse(sqliteRaw(db, sql) || "[]") as Array<Record<string, unknown>>;
const sha256File = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

if (!existsSync(source)) throw new Error(`Source snapshot is missing: ${source}`);
if (!existsSync(sourceManifestPath)) throw new Error(`Source manifest is missing: ${sourceManifestPath}`);
if (existsSync(output)) throw new Error(`Refusing to overwrite derived training DB: ${output}`);
if (existsSync(manifestPath)) throw new Error(`Refusing to overwrite training manifest: ${manifestPath}`);
mkdirSync(dirname(output), { recursive: true });

const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8")) as {
  snapshot_sha256: string;
  snapshot_bytes: number;
};
const actualSourceBytes = statSync(source).size;
if (actualSourceBytes !== sourceManifest.snapshot_bytes) {
  throw new Error(`Source size mismatch: expected ${sourceManifest.snapshot_bytes}, got ${actualSourceBytes}`);
}
const actualSourceHash = await sha256File(source);
if (actualSourceHash !== sourceManifest.snapshot_sha256) {
  throw new Error(`Source hash mismatch: expected ${sourceManifest.snapshot_sha256}, got ${actualSourceHash}`);
}

const seasonsSql = includedSeasons.join(",");
sqliteRaw(output, `
  ATTACH DATABASE '${source.replaceAll("'", "''")}' AS source;
  BEGIN IMMEDIATE;
  DROP TABLE IF EXISTS v10_training_performances;
  DROP TABLE IF EXISTS v10_data_contract_metadata;
  CREATE TABLE v10_data_contract_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO v10_data_contract_metadata VALUES
    ('contract_version', '${contractVersion}'),
    ('source_snapshot_sha256', '${sourceManifest.snapshot_sha256}'),
    ('included_seasons', '${includedSeasons.join(",")}'),
    ('purpose', '${purpose}'),
    ('training_cutoff_season', '${trainingCutoffSeason}'),
    ('development_cutoff', '${developmentCutoff}'),
    ('identity_policy', 'canonical-current-source-keys-dev1'),
    ('target_time_policy', 'strictly-before-target-date');

  CREATE TABLE v10_training_performances AS
  SELECT
    e.season || '|' || e.competition_slug || '|' || e.division_name || '|' || e.corps_key AS row_key,
    e.season,
    e.competition_slug,
    c.date AS competition_date,
    c.event_name,
    e.corps_key AS source_corps_key,
    e.corps_key AS model_corps_key,
    e.corps_name,
    e.division_name,
    cs.rank AS source_rank,
    e.computed_rank,
    e.rank_bucket,
    e.total_score,
    e.percent_through,
    e.percent_bucket,
    e.GE1, e.GE2, e.VP, e.VA, e.CG, e.MB, e.MA, e.MP,
    e.caption_total,
    COALESCE(panel.judge_count, 0) AS retrospective_judge_count,
    COALESCE(panel.caption_count, 0) AS retrospective_panel_caption_count,
    CASE WHEN COALESCE(panel.caption_count, 0) = 8 THEN 1 ELSE 0 END AS retrospective_panel_complete,
    '${contractVersion}' AS data_contract_version,
    'canonical-current-source-keys-dev1' AS identity_policy_version
  FROM source.clean_reference_curve_entries e
  JOIN source.competitions c ON c.slug = e.competition_slug
  JOIN source.corps_scores cs
    ON cs.competition_slug = e.competition_slug
   AND cs.corps_key = e.corps_key
  LEFT JOIN (
    SELECT
      competition_slug,
      COUNT(DISTINCT judge_id) AS judge_count,
      COUNT(DISTINCT normalized_caption_name) AS caption_count
    FROM source.judge_assignments
    WHERE normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
      AND judge_id NOT LIKE '%unknown%'
    GROUP BY competition_slug
  ) panel ON panel.competition_slug = e.competition_slug
  WHERE CAST(e.season AS INTEGER) IN (${seasonsSql});

  CREATE UNIQUE INDEX v10_training_performances_row_key
    ON v10_training_performances(row_key);
  CREATE INDEX v10_training_performances_date
    ON v10_training_performances(competition_date, division_name);
  CREATE INDEX v10_training_performances_corps
    ON v10_training_performances(model_corps_key, competition_date);
  COMMIT;
  DETACH DATABASE source;
`, false);

const invariants = sqlite(output, `
  SELECT
    COUNT(*) AS rows,
    COUNT(DISTINCT row_key) AS distinct_row_keys,
    SUM(CASE WHEN ABS(caption_total-total_score) > 0.05 THEN 1 ELSE 0 END) AS total_mismatches,
    SUM(CASE WHEN GE1 IS NULL OR GE2 IS NULL OR VP IS NULL OR VA IS NULL OR CG IS NULL OR MB IS NULL OR MA IS NULL OR MP IS NULL THEN 1 ELSE 0 END) AS incomplete_panels,
    SUM(CASE WHEN computed_rank < 1 OR rank_bucket < 1 OR rank_bucket > 25 THEN 1 ELSE 0 END) AS invalid_ranks,
    MIN(competition_date) AS min_date,
    MAX(competition_date) AS max_date
  FROM v10_training_performances
`)[0]!;
if (
  invariants.rows !== expectedRows ||
  invariants.distinct_row_keys !== expectedRows ||
  invariants.total_mismatches !== 0 ||
  invariants.incomplete_panels !== 0 ||
  invariants.invalid_ranks !== 0
) {
  throw new Error(`V10 training invariants failed: ${JSON.stringify(invariants)}`);
}

const identityLines = sqliteRaw(output, `
  SELECT row_key || '|' || printf('%.6f', total_score) || '|' ||
    printf('%.6f', GE1) || '|' || printf('%.6f', GE2) || '|' ||
    printf('%.6f', VP) || '|' || printf('%.6f', VA) || '|' ||
    printf('%.6f', CG) || '|' || printf('%.6f', MB) || '|' ||
    printf('%.6f', MA) || '|' || printf('%.6f', MP)
  FROM v10_training_performances ORDER BY row_key;
`, false);
const rowIdentityHash = createHash("sha256").update(identityLines).digest("hex");
const quickCheck = sqlite(output, "PRAGMA quick_check;")[0]?.quick_check;
if (quickCheck !== "ok") throw new Error(`Derived DB quick_check failed: ${String(quickCheck)}`);

const manifest = {
  manifest_version: purpose === "training" ? "v10-training-data-manifest-v1" : "v10-evaluation-data-manifest-v1",
  generated_at: new Date().toISOString(),
  purpose,
  contract_version: contractVersion,
  included_seasons: includedSeasons,
  training_cutoff_season: trainingCutoffSeason,
  development_cutoff: developmentCutoff,
  source_snapshot_sha256: sourceManifest.snapshot_sha256,
  derived_db_path: output,
  derived_db_bytes: statSync(output).size,
  derived_db_sha256: await sha256File(output),
  row_identity_sha256: rowIdentityHash,
  sqlite_quick_check: "ok",
  invariants,
  by_season_division: sqlite(output, `
    SELECT season, division_name, COUNT(*) AS rows
    FROM v10_training_performances GROUP BY season, division_name ORDER BY season, division_name
  `),
  identity_counts: sqlite(output, `
    SELECT COUNT(DISTINCT model_corps_key) AS corps, COUNT(DISTINCT competition_slug) AS shows,
      SUM(CASE WHEN retrospective_panel_complete=1 THEN 1 ELSE 0 END) AS panel_complete_rows,
      SUM(CASE WHEN retrospective_panel_complete=0 THEN 1 ELSE 0 END) AS panel_incomplete_rows
    FROM v10_training_performances
  `)[0],
  evaluation_cohorts: purpose === "evaluation" ? {
    development: sqlite(output, `
      SELECT COUNT(*) AS rows, COUNT(DISTINCT competition_slug) AS shows,
        MIN(competition_date) AS min_date, MAX(competition_date) AS max_date
      FROM v10_training_performances
      WHERE CAST(season AS INTEGER) > ${trainingCutoffSeason}
        AND competition_date <= '${developmentCutoff.replaceAll("'", "''")}'
    `)[0],
    untouched: sqlite(output, `
      SELECT COUNT(*) AS rows, COUNT(DISTINCT competition_slug) AS shows,
        MIN(competition_date) AS min_date, MAX(competition_date) AS max_date
      FROM v10_training_performances
      WHERE CAST(season AS INTEGER) > ${trainingCutoffSeason}
        AND competition_date > '${developmentCutoff.replaceAll("'", "''")}'
    `)[0],
  } : null,
  v9_key_comparison: sqlite(output, `
    ATTACH DATABASE '${source.replaceAll("'", "''")}' AS source;
    SELECT
      (SELECT COUNT(*) FROM v10_training_performances v LEFT JOIN source.ml_sequence_rows_v9_subcaption old
        ON old.season=v.season AND old.competition_slug=v.competition_slug AND old.division_name=v.division_name AND old.corps_key=v.source_corps_key
        WHERE old.corps_key IS NULL) AS only_v10,
      (SELECT COUNT(*) FROM source.ml_sequence_rows_v9_subcaption old LEFT JOIN v10_training_performances v
        ON old.season=v.season AND old.competition_slug=v.competition_slug AND old.division_name=v.division_name AND old.corps_key=v.source_corps_key
        WHERE CAST(old.season AS INTEGER) <= 2025 AND v.source_corps_key IS NULL) AS only_v9
  `)[0],
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
