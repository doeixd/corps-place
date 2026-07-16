import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const valueAfter = (flag: string, fallback?: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const source = resolve(valueAfter("--source", "./dci-relational.db")!);
const output = resolve(valueAfter("--out", "./data/v10-source.db")!);
const manifestPath = resolve(valueAfter("--manifest", `${output}.manifest.json`)!);
const manifestOnly = process.argv.includes("--manifest-only");

const sqlite = (db: string, sql: string) => {
  const result = spawnSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return JSON.parse(result.stdout || "[]") as Array<Record<string, unknown>>;
};

const sha256File = async (path: string) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

if (!manifestOnly) {
  if (!existsSync(source)) throw new Error(`Source DB does not exist: ${source}`);
  if (existsSync(output)) throw new Error(`Refusing to overwrite immutable snapshot: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  const backup = spawnSync("sqlite3", [source, `.backup '${output.replaceAll("'", "''")}'`], {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "pipe"],
  });
  if (backup.status !== 0) throw new Error(backup.stderr || `SQLite backup exited ${backup.status}`);
}

if (!existsSync(output)) throw new Error(`Snapshot DB does not exist: ${output}`);
const quickCheck = sqlite(output, "PRAGMA quick_check;");
if (quickCheck[0]?.quick_check !== "ok") throw new Error(`Snapshot quick_check failed: ${JSON.stringify(quickCheck)}`);

const domainPolicy = sqlite(output, `
  SELECT 'caption' AS kind, caption_key AS key, category_name || '|' || min_score || '|' || max_score || '|' || total_weight AS value FROM domain_captions
  UNION ALL SELECT 'caption_alias', raw_caption_name, caption_key FROM domain_caption_aliases
  UNION ALL SELECT 'division', division_name, is_model_division || '|' || COALESCE(score_system, '') FROM domain_divisions
  UNION ALL SELECT 'event_exclusion', pattern, applies_to_model || '|' || reason FROM domain_event_exclusion_patterns
  ORDER BY kind, key
`);
const schemaRows = sqlite(output, `
  SELECT type, name, sql FROM sqlite_master
  WHERE name IN (
    'competitions','corps_scores','caption_scores','judge_assignments','judge_scores','subcaption_scores',
    'clean_reference_curve_entries','clean_reference_curve_metric_scores','domain_captions',
    'domain_caption_aliases','domain_divisions','domain_event_exclusion_patterns','ml_sequence_rows_v9_subcaption'
  ) ORDER BY type, name
`);
const stableHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const manifest = {
  manifest_version: "v10-source-snapshot-v1",
  generated_at: new Date().toISOString(),
  source_path: source,
  snapshot_path: output,
  snapshot_bytes: statSync(output).size,
  snapshot_sha256: await sha256File(output),
  sqlite_quick_check: "ok",
  schema_sha256: stableHash(schemaRows),
  domain_policy_sha256: stableHash(domainPolicy),
  source_counts: sqlite(output, `
    SELECT
      (SELECT COUNT(*) FROM competitions) AS competitions,
      (SELECT COUNT(*) FROM corps_scores) AS corps_scores,
      (SELECT COUNT(*) FROM caption_scores) AS caption_scores,
      (SELECT COUNT(*) FROM judge_assignments) AS judge_assignments,
      (SELECT COUNT(*) FROM subcaption_scores) AS subcaption_scores,
      (SELECT MAX(date) FROM competitions) AS max_competition_date
  `)[0],
  clean_training_population_through_2025: sqlite(output, `
    SELECT season, COUNT(*) AS rows
    FROM clean_reference_curve_entries
    WHERE CAST(season AS INTEGER) <= 2025
    GROUP BY season ORDER BY season
  `),
  frozen_v9_population: sqlite(output, `
    SELECT season, COUNT(*) AS rows
    FROM ml_sequence_rows_v9_subcaption
    WHERE CAST(season AS INTEGER) <= 2025
    GROUP BY season ORDER BY season
  `),
};

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
