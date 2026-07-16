
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const SOURCE_HASH = "5c7cd0807e1c05896f42ef7aedd8a2c8edd3bcd988739a21f45e2b1be5df3bcb";
const CONTRACT_VERSION = "v10-training-performances-dev1";
const ARTIFACT_VERSION = "v10-clean-artifacts-dev1";

const valueAfter = (flag: string, fallback: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1]! : fallback;
};
const sourcePath = resolve(valueAfter("--source", "./data/v10-source-2026-07-16.db"));
const trainingPath = resolve(valueAfter("--training-db", "./data/v10-training-dev1.db"));
const outputDir = resolve(valueAfter("--out-dir", "./src/training/v10/dev1"));

if (!existsSync(sourcePath)) throw new Error(`Missing source snapshot: ${sourcePath}`);
if (!existsSync(trainingPath)) throw new Error(`Missing V10 training DB: ${trainingPath}`);
mkdirSync(outputDir, { recursive: true });

const rows = <T>(sql: string, attachSource = false) => {
  const statement = attachSource
    ? `ATTACH DATABASE '${sourcePath.replaceAll("'", "''")}' AS source; ${sql}`
    : sql;
  const result = spawnSync("sqlite3", ["-json", trainingPath, statement], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return JSON.parse(result.stdout || "[]") as T[];
};
const scalar = (sql: string) => Object.values(rows<Record<string, string | number>>(sql)[0] ?? {})[0];
const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const writeArtifact = (name: string, value: unknown) => {
  const contents = stableJson(value);
  const path = resolve(outputDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return { file: name, bytes: Buffer.byteLength(contents), sha256: sha256(contents) };
};
const indexedMap = (values: readonly string[]) => {
  const map: Record<string, number> = { unknown: 0 };
  [...new Set(values)].sort().forEach((value, index) => { map[value] = index + 1; });
  return map;
};

const contract = rows<{ value: string }>(`
  SELECT value FROM v10_data_contract_metadata WHERE key='contract_version'
`)[0]?.value;
if (contract !== CONTRACT_VERSION) {
  throw new Error(`Training contract mismatch: expected ${CONTRACT_VERSION}, got ${contract}`);
}

const corpsKeys = rows<{ key: string }>(`
  SELECT DISTINCT model_corps_key AS key FROM v10_training_performances ORDER BY key
`).map((row) => row.key);
const judgeIds = rows<{ id: string }>(`
  SELECT DISTINCT ja.judge_id AS id
  FROM source.judge_assignments ja
  JOIN (SELECT DISTINCT competition_slug FROM v10_training_performances) shows
    ON shows.competition_slug=ja.competition_slug
  WHERE ja.normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
    AND ja.judge_id IS NOT NULL AND ja.judge_id <> '' AND ja.judge_id NOT LIKE '%unknown%'
  ORDER BY id
`, true).map((row) => row.id);
const agnosticShows = rows<{ id: string }>(`
  SELECT DISTINCT CASE
    WHEN competition_slug GLOB '[0-9][0-9][0-9][0-9]-*' THEN substr(competition_slug, 6)
    ELSE competition_slug END AS id
  FROM v10_training_performances ORDER BY id
`).map((row) => row.id);

const corpsIndexMap = indexedMap(corpsKeys);
const judgeIndexMap = indexedMap(judgeIds);
const showIndexMap = indexedMap(agnosticShows);

const corpsAliases: Record<string, string> = { unknown: "unknown" };
for (const row of rows<{ alias_key: string; corps_key: string }>(`
  SELECT ca.alias_key, c.corps_key
  FROM source.corps_aliases ca
  JOIN source.corps c ON lower(trim(c.name))=lower(trim(ca.canonical_name))
  JOIN (SELECT DISTINCT model_corps_key FROM v10_training_performances) used
    ON used.model_corps_key=c.corps_key
  WHERE ca.alias_key IS NOT NULL AND ca.alias_key <> ''
  ORDER BY ca.alias_key, c.corps_key
`, true)) {
  const existing = corpsAliases[row.alias_key];
  if (existing && existing !== row.corps_key) {
    throw new Error(`Ambiguous reviewed corps alias ${row.alias_key}: ${existing} vs ${row.corps_key}`);
  }
  corpsAliases[row.alias_key] = row.corps_key;
}
for (const key of corpsKeys) corpsAliases[key] = key;

type CurveCell = { rank: number; bucket: number; caption: string; score: number };
const curveRows = rows<CurveCell>(`
  SELECT rank_bucket AS rank, percent_bucket AS bucket, 'GE1' AS caption, GE1 AS score FROM v10_training_performances WHERE division_name='World Class'
  UNION ALL SELECT rank_bucket, percent_bucket, 'GE2', GE2 FROM v10_training_performances WHERE division_name='World Class'
  UNION ALL SELECT rank_bucket, percent_bucket, 'VP', VP FROM v10_training_performances WHERE division_name='World Class'
  UNION ALL SELECT rank_bucket, percent_bucket, 'VA', VA FROM v10_training_performances WHERE division_name='World Class'
  UNION ALL SELECT rank_bucket, percent_bucket, 'CG', CG FROM v10_training_performances WHERE division_name='World Class'
  UNION ALL SELECT rank_bucket, percent_bucket, 'MB', MB FROM v10_training_performances WHERE division_name='World Class'
  UNION ALL SELECT rank_bucket, percent_bucket, 'MA', MA FROM v10_training_performances WHERE division_name='World Class'
  UNION ALL SELECT rank_bucket, percent_bucket, 'MP', MP FROM v10_training_performances WHERE division_name='World Class'
`);
const sums = new Map<string, { sum: number; count: number }>();
for (const row of curveRows) {
  const key = `${row.rank}-${row.bucket}-${row.caption}`;
  const cell = sums.get(key) ?? { sum: 0, count: 0 };
  cell.sum += row.score;
  cell.count++;
  sums.set(key, cell);
}
const curves: Record<string, Record<string, number>> = {};
const buckets = Array.from({ length: 21 }, (_, index) => index * 5);
for (let rank = 1; rank <= 25; rank++) {
  for (const caption of CAPTIONS) {
    const points = buckets.flatMap((bucket) => {
      const cell = sums.get(`${rank}-${bucket}-${caption}`);
      return cell ? [[bucket, cell.sum / cell.count] as const] : [];
    });
    if (!points.length) continue;
    for (const bucket of buckets) {
      let value = points.find(([point]) => point === bucket)?.[1];
      if (value === undefined) {
        const lower = [...points].reverse().find(([point]) => point < bucket);
        const upper = points.find(([point]) => point > bucket);
        if (lower && upper) value = lower[1] + (upper[1] - lower[1]) * ((bucket - lower[0]) / (upper[0] - lower[0]));
        else value = lower?.[1] ?? upper?.[1];
      }
      if (value !== undefined) (curves[`${rank}-${bucket}`] ??= {})[caption] = Number(value.toFixed(3));
    }
  }
}
const rankHasData = (rank: number) => buckets.some((bucket) => curves[`${rank}-${bucket}`]);
for (let rank = 1; rank <= 25; rank++) {
  if (rankHasData(rank)) continue;
  const sourceRank = Array.from({ length: 25 }, (_, index) => index + 1)
    .filter(rankHasData).sort((a, b) => Math.abs(a - rank) - Math.abs(b - rank) || a - b)[0];
  if (!sourceRank) throw new Error(`No reference-curve source for rank ${rank}`);
  for (const bucket of buckets) curves[`${rank}-${bucket}`] = { ...curves[`${sourceRank}-${bucket}`] };
}
for (let rank = 1; rank <= 25; rank++) for (const bucket of buckets) {
  const cell = curves[`${rank}-${bucket}`];
  const missing = CAPTIONS.filter((caption) => !Number.isFinite(cell?.[caption]));
  if (missing.length) throw new Error(`Incomplete curve ${rank}-${bucket}: ${missing.join(",")}`);
}
const referenceCurves = {
  version: ARTIFACT_VERSION,
  source_snapshot_sha256: SOURCE_HASH,
  training_contract: CONTRACT_VERSION,
  captions: CAPTIONS,
  curves,
};

const artifacts = [
  writeArtifact("corpsIndexMap.json", corpsIndexMap),
  writeArtifact("judgeIndexMap.json", judgeIndexMap),
  writeArtifact("showIndexMap.json", showIndexMap),
  writeArtifact("corpsAliasMap.json", corpsAliases),
  writeArtifact("referenceCurves.json", referenceCurves),
];
const manifest = {
  manifest_version: ARTIFACT_VERSION,
  source_snapshot_sha256: SOURCE_HASH,
  training_contract: CONTRACT_VERSION,
  row_identity_sha256: "96b4d40541f7c927bbe6a68740ee766916f027ff75916bcb8417c6531bbba37d",
  training_rows: Number(scalar("SELECT COUNT(*) FROM v10_training_performances")),
  counts: {
    corps_known: corpsKeys.length,
    judges_known: judgeIds.length,
    shows_known: agnosticShows.length,
    reviewed_corps_aliases: Object.keys(corpsAliases).length - corpsKeys.length - 1,
    curve_cells: Object.keys(curves).length,
  },
  index_policy: "unknown=0; known identities sorted lexicographically and assigned 1..N; embedding input dimension=max(index)+1",
  show_identity_policy: "strip a leading YYYY- from competition_slug; unknown=0",
  artifacts,
};
writeArtifact("manifest.json", manifest);
process.stdout.write(stableJson(manifest));
