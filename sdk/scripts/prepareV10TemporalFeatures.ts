
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
type Caption = (typeof CAPTIONS)[number];
type Performance = {
  row_key: string; season: string; competition_slug: string; competition_date: string;
  model_corps_key: string; division_name: string; computed_rank: number; rank_bucket: number;
  percent_through: number; percent_bucket: number; total_score: number;
} & Record<Caption, number>;
type Assignment = { competition_slug: string; caption: Caption; judge_id: string };
type EloState = { elo: number; count: number };

const valueAfter = (flag: string, fallback: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1]! : fallback;
};
const dbPath = resolve(valueAfter("--db", "./data/v10-training-dev1.db"));
const sourcePath = resolve(valueAfter("--source", "./data/v10-source-2026-07-16.db"));
if (!existsSync(dbPath) || !existsSync(sourcePath)) throw new Error("V10 source/training database is missing");

const sqlite = <T>(db: string, sql: string) => {
  const result = spawnSync("sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `sqlite3 exited ${result.status}`);
  return JSON.parse(result.stdout || "[]") as T[];
};
const performances = sqlite<Performance>(dbPath, `
  SELECT row_key, season, competition_slug, competition_date, model_corps_key, division_name,
    computed_rank, rank_bucket, percent_through, percent_bucket, total_score, GE1, GE2, VP, VA, CG, MB, MA, MP
  FROM v10_training_performances ORDER BY competition_date, competition_slug, division_name, computed_rank, model_corps_key
`);
const assignments = sqlite<Assignment>(dbPath, `
  ATTACH DATABASE '${sourcePath.replaceAll("'", "''")}' AS source;
  SELECT DISTINCT ja.competition_slug, ja.normalized_caption_name AS caption, ja.judge_id
  FROM source.judge_assignments ja
  JOIN (SELECT DISTINCT competition_slug FROM v10_training_performances) shows USING (competition_slug)
  WHERE ja.normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
    AND ja.judge_id IS NOT NULL AND ja.judge_id <> '' AND ja.judge_id NOT LIKE '%unknown%'
  ORDER BY ja.competition_slug, caption, ja.judge_id
`);

const assignmentsByShowCaption = new Map<string, string[]>();
for (const row of assignments) {
  const key = `${row.competition_slug}|${row.caption}`;
  const list = assignmentsByShowCaption.get(key) ?? [];
  list.push(row.judge_id);
  assignmentsByShowCaption.set(key, list);
}
const groupedByDate = new Map<string, Performance[]>();
for (const row of performances) {
  const group = groupedByDate.get(row.competition_date) ?? [];
  group.push(row);
  groupedByDate.set(row.competition_date, group);
}

const curve = new Map<string, { sum: number; count: number }>();
const ranges = new Map<string, { min: number; max: number }>();
const latestBySeason = new Map<string, Performance>();
const corpsElo = new Map<string, EloState>();
const judgeElo = new Map<string, EloState>();
const temporalRows: string[] = [];
const historyRows: string[] = [];
const judgeRows = new Map<string, string>();
type FieldObservation = {
  season: string; division: string; date: string; corps: string;
  rank: number; percentThrough: number; residual: number;
};
const fieldObservations: FieldObservation[] = [];
const fieldPaceRows: string[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const num = (value: number) => Number.isFinite(value) ? value.toFixed(8) : "0";
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const std = (values: number[]) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
};
const slope = (rows: FieldObservation[]) => {
  if (rows.length < 2) return 0;
  const xs = rows.map((row) => row.percentThrough / 100);
  const ys = rows.map((row) => row.residual);
  const xMean = mean(xs);
  const yMean = mean(ys);
  const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  return denominator > 1e-9
    ? rows.reduce((sum, _row, index) => sum + (xs[index]! - xMean) * (ys[index]! - yMean), 0) / denominator
    : 0;
};
const referenceTotal = (row: Performance) => {
  const baselines = Object.fromEntries(CAPTIONS.map((caption) =>
    [caption, curveBaseline(row.rank_bucket, row.percent_bucket, caption, row.division_name)]
  )) as Record<Caption, number>;
  return baselines.GE1 + baselines.GE2 +
    (baselines.VP + baselines.VA + baselines.CG + baselines.MB + baselines.MA + baselines.MP) / 2;
};
const fieldSnapshot = (row: Performance) => {
  const current = fieldObservations.filter((observation) =>
    observation.season === row.season && observation.division === row.division_name && observation.rank <= 25
  );
  const latestByCorps = new Map<string, FieldObservation>();
  for (const observation of current) latestByCorps.set(observation.corps, observation);
  const latest = [...latestByCorps.values()];
  const dates = new Set(current.map((observation) => observation.date));
  const level = mean(latest.map((observation) => observation.residual));
  const rawSlope = slope(current);
  const historicalBySeason = new Map<string, FieldObservation[]>();
  for (const observation of fieldObservations) {
    if (observation.division !== row.division_name || Number(observation.season) >= Number(row.season)) continue;
    const group = historicalBySeason.get(observation.season) ?? [];
    group.push(observation);
    historicalBySeason.set(observation.season, group);
  }
  const historicalSlopes = [...historicalBySeason.values()]
    .filter((group) => group.length >= 4 && new Set(group.map((observation) => observation.date)).size >= 2)
    .map(slope);
  const historicalSlope = mean(historicalSlopes);
  const confidence = Math.min(1, latest.length / 12) * Math.min(1, dates.size / 6);
  const shrunkSlope = confidence * rawSlope + (1 - confidence) * historicalSlope;
  let ema = 0;
  for (const [index, observation] of current.entries()) {
    ema = index === 0 ? observation.residual : 0.2 * observation.residual + 0.8 * ema;
  }
  const sourceDates = fieldObservations
    .filter((observation) => observation.division === row.division_name && Number(observation.season) <= Number(row.season))
    .map((observation) => observation.date)
    .sort();
  return {
    level,
    shrunkSlope,
    ema: current.length ? ema : 0,
    confidence,
    priorObservationCount: current.length,
    priorCorpsCount: latest.length,
    priorShowDateCount: dates.size,
    maxSourceDate: sourceDates.at(-1),
  };
};
const curveBaseline = (rank: number, bucket: number, caption: Caption, division: string) => {
  const exact = curve.get(`${division}|${rank}|${bucket}|${caption}`);
  if (exact) return exact.sum / exact.count;
  // Nearest same-division cell first; cross-division cells only when the
  // division has no data at all yet (early chronological rows), at a large
  // distance penalty so they can never beat a same-division candidate.
  const candidates: Array<{ distance: number; value: number }> = [];
  for (const [key, cell] of curve) {
    const [candidateDivision, candidateRank, candidateBucket, candidateCaption] = key.split("|");
    if (candidateCaption !== caption) continue;
    const divisionPenalty = candidateDivision === division ? 0 : 100_000;
    candidates.push({
      distance: divisionPenalty + Math.abs(Number(candidateRank) - rank) * 25 + Math.abs(Number(candidateBucket) - bucket),
      value: cell.sum / cell.count,
    });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.value - b.value);
  return candidates[0]?.value ?? 15;
};
const eloKey = (season: string, division: string, identity: string, caption: Caption) =>
  `${season}|${division}|${identity}|${caption}`;
const getElo = (map: Map<string, EloState>, key: string) => map.get(key) ?? { elo: 1500, count: 0 };

for (const [date, dateRows] of groupedByDate) {
  const dateReferenceTotals = new Map<string, number>();
  for (const row of dateRows) {
    dateReferenceTotals.set(row.row_key, referenceTotal(row));
    const field = fieldSnapshot(row);
    fieldPaceRows.push(`(${quote(row.row_key)},${num(field.level)},${num(field.shrunkSlope)},${num(field.ema)},${num(field.confidence)},${field.priorObservationCount},${field.priorCorpsCount},${field.priorShowDateCount},${field.maxSourceDate ? quote(field.maxSourceDate) : "NULL"},${quote(date)})`);
    const pastFinals = [...latestBySeason.values()].filter((past) =>
      past.model_corps_key === row.model_corps_key &&
      past.division_name === row.division_name &&
      Number(past.season) < Number(row.season)
    );
    const ranks = pastFinals.map((past) => past.computed_rank);
    const previousSeason = row.season === "2022" ? 2019 : Number(row.season) - 1;
    const previousFinal = pastFinals.find((past) => Number(past.season) === previousSeason);
    const bestRank = ranks.length ? Math.min(...ranks) : 15;
    const bestSeason = pastFinals.filter((past) => past.computed_rank === bestRank)
      .reduce((latest, past) => Math.max(latest, Number(past.season)), 0);
    historyRows.push(`(${quote(row.row_key)},${ranks.length},${num(mean(ranks) || 15)},${num(std(ranks))},${num(bestRank)},${num(bestSeason ? Number(row.season) - bestSeason : 20)},${num(ranks.length ? ranks.filter((rank) => rank <= 12).length / ranks.length : 0)},${pastFinals.length ? Math.min(...pastFinals.map((past) => Number(past.season))) : Number(row.season)},${num(previousFinal?.computed_rank ?? 15)},${num(previousFinal?.total_score ?? 70)},${quote(previousFinal?.competition_date ?? `${previousSeason}-08-15`)})`);

    for (const caption of CAPTIONS) {
      const baseline = curveBaseline(row.rank_bucket, row.percent_bucket, caption, row.division_name);
      const range = ranges.get(`${row.division_name}|${row.percent_bucket}|${caption}`) ?? { min: 0, max: 20 };
      const corpsBefore = getElo(corpsElo, eloKey(row.season, row.division_name, row.model_corps_key, caption)).elo;
      temporalRows.push(`(${quote(row.row_key)},${quote(caption)},${num(baseline)},${num(range.min)},${num(range.max)},${num(corpsBefore)},${quote(date)})`);

      for (const judgeId of assignmentsByShowCaption.get(`${row.competition_slug}|${caption}`) ?? []) {
        const judgeBefore = getElo(judgeElo, eloKey(row.season, row.division_name, judgeId, caption)).elo;
        const key = `${row.competition_slug}|${row.division_name}|${caption}|${judgeId}`;
        judgeRows.set(key, `(${quote(row.competition_slug)},${quote(row.division_name)},${quote(caption)},${quote(judgeId)},${num(judgeBefore)},${quote(date)})`);
      }
    }
  }

  // Update only after every row on this date has been materialized. This makes
  // the boundary strictly date-before-target and prevents same-day cross-show leakage.
  for (const row of dateRows) {
    latestBySeason.set(`${row.model_corps_key}|${row.division_name}|${row.season}`, row);
    for (const caption of CAPTIONS) {
      const score = Number(row[caption]);
      // dev3: the as-of reference curve is division-keyed. Anchoring Open Class
      // rows to the World Class curve at their own division rank produced
      // structurally wrong baselines (championship-week WC values sit far above
      // OC scores).
      {
        const key = `${row.division_name}|${row.rank_bucket}|${row.percent_bucket}|${caption}`;
        const cell = curve.get(key) ?? { sum: 0, count: 0 };
        cell.sum += score; cell.count++; curve.set(key, cell);
      }
      const rangeKey = `${row.division_name}|${row.percent_bucket}|${caption}`;
      const range = ranges.get(rangeKey);
      ranges.set(rangeKey, range ? { min: Math.min(range.min, score), max: Math.max(range.max, score) } : { min: score, max: score });

      const judgeIds = assignmentsByShowCaption.get(`${row.competition_slug}|${caption}`) ?? [];
      for (const judgeId of judgeIds) {
        const cKey = eloKey(row.season, row.division_name, row.model_corps_key, caption);
        const jKey = eloKey(row.season, row.division_name, judgeId, caption);
        const corps = getElo(corpsElo, cKey);
        const judge = getElo(judgeElo, jKey);
        const expected = 1 / (1 + Math.exp(-(corps.elo - judge.elo) / 400));
        const delta = score / 20 - expected;
        corps.elo += (corps.count < 20 ? 32 : 16) * delta;
        judge.elo += (judge.count < 20 ? 32 : 16) * delta;
        corps.count++; judge.count++;
        corpsElo.set(cKey, corps); judgeElo.set(jKey, judge);
      }
    }
    fieldObservations.push({
      season: row.season,
      division: row.division_name,
      date,
      corps: row.model_corps_key,
      rank: row.computed_rank,
      percentThrough: row.percent_through,
      residual: row.total_score - (dateReferenceTotals.get(row.row_key) ?? row.total_score),
    });
  }
}

const chunks = <T>(items: T[], size = 400) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const statements: string[] = [
  "PRAGMA journal_mode=WAL;", "BEGIN IMMEDIATE;",
  "DROP TABLE IF EXISTS v10_temporal_caption_features;",
  "DROP TABLE IF EXISTS v10_temporal_corps_history;",
  "DROP TABLE IF EXISTS v10_temporal_judge_elo;",
  "DROP TABLE IF EXISTS v10_temporal_field_pace;",
  "CREATE TABLE v10_temporal_caption_features(row_key TEXT NOT NULL, caption TEXT NOT NULL, reference_baseline REAL NOT NULL, prior_range_min REAL NOT NULL, prior_range_max REAL NOT NULL, corps_elo_before REAL NOT NULL, as_of_date TEXT NOT NULL, PRIMARY KEY(row_key,caption));",
  "CREATE TABLE v10_temporal_corps_history(row_key TEXT PRIMARY KEY, years_in_world_class INTEGER NOT NULL, historical_mean_rank REAL NOT NULL, historical_std_rank REAL NOT NULL, historical_best_rank REAL NOT NULL, best_rank_recency REAL NOT NULL, made_finals_rate REAL NOT NULL, first_season INTEGER NOT NULL, previous_season_rank REAL NOT NULL, last_season_final_score REAL NOT NULL, last_season_final_date TEXT NOT NULL);",
  "CREATE TABLE v10_temporal_judge_elo(competition_slug TEXT NOT NULL, division_name TEXT NOT NULL, caption TEXT NOT NULL, judge_id TEXT NOT NULL, elo_before REAL NOT NULL, as_of_date TEXT NOT NULL, PRIMARY KEY(competition_slug,division_name,caption,judge_id));",
  "CREATE TABLE v10_temporal_field_pace(row_key TEXT PRIMARY KEY, field_level_vs_reference REAL NOT NULL, shrunk_residual_slope REAL NOT NULL, residual_ema REAL NOT NULL, confidence REAL NOT NULL, prior_observation_count INTEGER NOT NULL, prior_corps_count INTEGER NOT NULL, prior_show_date_count INTEGER NOT NULL, max_source_date TEXT, as_of_date TEXT NOT NULL);",
];
for (const chunk of chunks(temporalRows)) statements.push(`INSERT INTO v10_temporal_caption_features VALUES ${chunk.join(",")};`);
for (const chunk of chunks(historyRows)) statements.push(`INSERT INTO v10_temporal_corps_history VALUES ${chunk.join(",")};`);
for (const chunk of chunks([...judgeRows.values()])) statements.push(`INSERT INTO v10_temporal_judge_elo VALUES ${chunk.join(",")};`);
for (const chunk of chunks(fieldPaceRows)) statements.push(`INSERT INTO v10_temporal_field_pace VALUES ${chunk.join(",")};`);
statements.push(
  "CREATE INDEX v10_temporal_judge_show ON v10_temporal_judge_elo(competition_slug,division_name);",
  `INSERT OR REPLACE INTO v10_data_contract_metadata VALUES ('temporal_feature_contract','strict-date-before-target-dev1');`,
  "COMMIT;", "PRAGMA wal_checkpoint(TRUNCATE);",
);
const write = spawnSync("sqlite3", [dbPath], { input: statements.join("\n"), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (write.status !== 0) throw new Error(write.stderr || `sqlite3 write exited ${write.status}`);
const counts = sqlite<Record<string, number>>(dbPath, `SELECT
  (SELECT COUNT(*) FROM v10_temporal_caption_features) AS caption_features,
  (SELECT COUNT(*) FROM v10_temporal_corps_history) AS corps_history,
  (SELECT COUNT(*) FROM v10_temporal_judge_elo) AS judge_elo,
  (SELECT COUNT(*) FROM v10_temporal_field_pace) AS field_pace`)[0]!;
if (counts.caption_features !== performances.length * CAPTIONS.length || counts.corps_history !== performances.length || counts.field_pace !== performances.length) {
  throw new Error(`Temporal feature count mismatch: ${JSON.stringify(counts)}`);
}
const identity = sqlite<{ line: string }>(dbPath, `SELECT row_key || '|' || caption || '|' || printf('%.8f',reference_baseline) || '|' || printf('%.8f',corps_elo_before) AS line FROM v10_temporal_caption_features ORDER BY row_key,caption`)
  .map((row) => row.line).join("\n");
const fieldIdentity = sqlite<{ line: string }>(dbPath, `SELECT row_key || '|' || printf('%.8f',field_level_vs_reference) || '|' || printf('%.8f',shrunk_residual_slope) || '|' || printf('%.8f',residual_ema) || '|' || printf('%.8f',confidence) AS line FROM v10_temporal_field_pace ORDER BY row_key`)
  .map((row) => row.line).join("\n");
process.stdout.write(`${JSON.stringify({ contract: "strict-date-before-target-dev1", rows: performances.length, counts, sha256: createHash("sha256").update(`${identity}\n--field-pace--\n${fieldIdentity}`).digest("hex") }, null, 2)}\n`);
