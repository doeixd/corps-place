import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import * as MlQueries from "./mlQueries.js";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createProxy, noSpecialChars, ignoreCase } from '@doeixd/make-with'
import {
  V9_CAPTION_FINGERPRINT_CONFIDENCE_IDX,
  V9_CAPTION_FINGERPRINT_DIM,
  V9_CAPTION_FINGERPRINT_FEATURES_PER_CAPTION,
  V9_CAPTION_FINGERPRINT_START,
  V9_RAW_STATIC_DIM,
} from "./training/v9FeatureModes.js";
import { V10_FEATURE_SCHEMA, V10_FIELD_PACE_FEATURE_SCHEMA } from "./training/v10FeatureSchema.js";

const valueAfter = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
};
const cliDataContract = valueAfter("--data-contract") ?? "raw-v9";
const cliV10FeatureProfile = valueAfter("--feature-profile") ?? "clean-control";
if (cliDataContract === "clean-v10" && !["clean-control", "field-pace"].includes(cliV10FeatureProfile)) {
  throw new Error(`Unsupported --feature-profile ${cliV10FeatureProfile}`);
}
const ACTIVE_V10_SCHEMA = cliV10FeatureProfile === "field-pace"
  ? V10_FIELD_PACE_FEATURE_SCHEMA
  : V10_FEATURE_SCHEMA;
const v10ArtifactDir = valueAfter("--artifact-dir") ?? "./src/training/v10/dev1";
const artifactPath = (v9Name: string, v10Name = v9Name) =>
  cliDataContract === "clean-v10" ? `${v10ArtifactDir}/${v10Name}` : `./src/training/${v9Name}`;
const readJson = <T>(path: string) => JSON.parse(fs.readFileSync(path, "utf-8")) as T;
const REFERENCE_CURVES = readJson<{ version?: string; curves: Record<string, Record<string, number>> }>(
  artifactPath("referenceCurvesV4.json", "referenceCurves.json"),
);
const JUDGE_INDEX_MAP = readJson<Record<string, number>>(artifactPath("judgeIndexMap.json"));
const CORPS_INDEX_MAP = readJson<Record<string, number>>(artifactPath("corpsIndexMap.json"));
const SHOW_INDEX_MAP = readJson<Record<string, number>>(artifactPath("showIndexMap.json"));
const V9_BUILDER_VERSION = "v9-subcaption-clean-2026-05-21";
const V10_BUILDER_VERSION = cliV10FeatureProfile === "field-pace"
  ? "v10-field-pace-dev1-2026-07-17"
  : "v10-clean-canonical-dev1-2026-07-16";
const V9_TARGET_TABLE = "ml_sequence_rows_v9_subcaption";
const V10_TARGET_TABLE = cliV10FeatureProfile === "field-pace"
  ? "ml_sequence_rows_v10_field_pace"
  : "ml_sequence_rows_v10_clean_control";
const v10ArtifactManifest = cliDataContract === "clean-v10"
  ? readJson<{ manifest_version?: string }>(`${v10ArtifactDir}/manifest.json`)
  : null;
const MAP_VERSION = cliDataContract === "clean-v10"
  ? (v10ArtifactManifest?.manifest_version ?? "v10-clean-artifacts-dev1")
  : "current-json-files";

// Subcaption normalization helpers
const SUBCAPTION_CONTENT_VARIANTS = [
  "content", "repertoire", "composition", "rep", "comp", "design",
  "repertoire/composition", "design development", "composition development",
  "repertoire effect", "design effect"
];

const SUBCAPTION_ACHIEVEMENT_VARIANTS = [
  "achievement", "performance", "execution", "perf", "excellence",
  "clarity & excellence", "performer excellence", "performance/showmanship",
  "performer effect", "accuracy", "technique", "intonation", "tone", "expression"
];

const normalizeSubcaptionCategory = (name: string): "Content" | "Achievement" | "Other" => {
  const n = name.toLowerCase().trim();
  if (SUBCAPTION_CONTENT_VARIANTS.some(v => n.includes(v))) return "Content";
  if (SUBCAPTION_ACHIEVEMENT_VARIANTS.some(v => n.includes(v))) return "Achievement";
  return "Other";
};

const normalizeSubcaptionScore = (score: number) => score / 10.0;

export const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

type Caption = (typeof CAPTIONS)[number];

const captionProxy = (p: Record<string, string>) => new Proxy(p, {
  get: (target, prop) => {
    if (prop in target) return target[prop as string];
    // Fuzzy matching DISABLED - only exact key matches allowed
    // The fuzzy matching by string length was causing false matches
    // (e.g., "Special CG" matched "Color Guard" because both have similar length)
    return undefined;
  }
})

const CAPTION_MAP: Record<string, string> = captionProxy({
  "General Effect 1": "GE1",
  "General Effect 2": "GE2",
  "Visual Proficiency": "VP",
  "Visual - Proficiency": "VP",
  "Visual Analysis": "VA",
  "Visual - Analysis": "VA",
  "Color Guard": "CG",
  "Music - Brass": "MB",
  "Music Brass": "MB",
  "Music - Analysis": "MA",
  "Music - Percussion": "MP",
  "Brass": "MB",
  "Percussion": "MP",
})

const FULL_CAPTION_BY_SHORT: Record<string, string> = {};
for (const [fullCaptionName, shortCaptionName] of Object.entries(CAPTION_MAP)) {
  FULL_CAPTION_BY_SHORT[shortCaptionName] ??= fullCaptionName;
}

const fullCaptionNameFor = (caption: string) => FULL_CAPTION_BY_SHORT[caption] ?? caption;

const SEASONS = ["2013", "2014", "2015", "2016", "2017", "2018", "2019", "2022", "2023", "2024", "2025"];
const DIVISIONS = ["World Class", "Open Class"];

const SEQ_LEN = 15;
const FINALS_CUTOFF = 12;

const CAPTION_COUNT = CAPTIONS.length;
const CAPTION_FEATURES = 4;
const OPPONENT_TIMESTEP_FEATURES = 7 + 27; // 7 (existing) + 27 (opponent last-3 totals + per-caption stats)
const COMPARATIVE_FEATURES = 10; // relative_total + relative_caption×8 + show_competitiveness
const TIMESTEP_FEATURES = cliDataContract === "clean-v10"
  ? ACTIVE_V10_SCHEMA.sequenceDim
  : 7 + 11 + CAPTION_COUNT * CAPTION_FEATURES + OPPONENT_TIMESTEP_FEATURES + 4 + COMPARATIVE_FEATURES + 3; // 98 + 3 = 101
const COLD_START_FEATURES = 10;
const STATIC_FEATURES = cliDataContract === "clean-v10" ? ACTIVE_V10_SCHEMA.rawStaticDim : V9_RAW_STATIC_DIM;
const BASE_STATIC_FEATURES = STATIC_FEATURES - V9_CAPTION_FINGERPRINT_DIM;

const EMA_ALPHA = 0.3;

const normalizeRank = (rank: number) => rank / 25;
const normalizeScore = (score: number) => (score - 70) / 30;
const normalizeCaptionScore = (score: number) => score / 20;
const normalizeGap = (gap: number) => gap / 25;
const normalizeDays = (days: number) => Math.min(days, 120) / 120;
const normalizeRecentGap = (days: number) => Math.min(days, 14) / 14;
const normalizeOffseasonGap = (days: number) => Math.min(Math.max(days, 0), 365) / 365;

const INITIAL_ELO = 1500;
const INITIAL_CONFIDENCE = 50;
const K_FACTOR_NEW = 32;
const K_FACTOR_STABLE = 16;
const CONFIDENCE_THRESHOLD = 20;
const CONFIDENCE_DECAY = 0.95;
const MAX_SCORE = 20;

type EloState = {
  elo: number;
  confidence: number;
  numScores: number;
};

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const hasCompleteCaptionScores = (show: { captions?: Record<string, { score?: number }> }) =>
  CAPTIONS.every((caption) => {
    const score = show.captions?.[caption]?.score;
    return Number.isFinite(score) && score! > 0 && score! <= MAX_SCORE;
  });

const captionDerivedTotal = (captions: Record<string, { score?: number }>) =>
  ((captions.GE1?.score ?? 0) + (captions.GE2?.score ?? 0)) +
  (((captions.VP?.score ?? 0) + (captions.VA?.score ?? 0) + (captions.CG?.score ?? 0)) / 2) +
  (((captions.MB?.score ?? 0) + (captions.MA?.score ?? 0) + (captions.MP?.score ?? 0)) / 2);

const hasConsistentCaptionTotal = (show: { captions?: Record<string, { score?: number }>; total_score?: number }) => {
  if (!hasCompleteCaptionScores(show)) return false;
  if (!Number.isFinite(show.total_score) || show.total_score! <= 0 || show.total_score! > 100) return false;
  return Math.abs(captionDerivedTotal(show.captions!) - show.total_score!) <= 0.05;
};

const std = (values: number[]) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
};

const rebuildShowAggregatesV7 = (sql: SqlClient.SqlClient, asOfDate?: string) =>
  Effect.gen(function* () {
    console.log("Rebuilding show_aggregates_v7...");
    yield* (sql`DELETE FROM show_aggregates_v7`);

    const competitions = yield* (sql<{
      season: string;
      slug: string;
      competition_date: string;
    }>`
      SELECT season, slug, date as competition_date
      FROM competitions
      WHERE date <= ${asOfDate ?? "9999-12-31"}
      ORDER BY date ASC
    `);
    console.log(`Computing show aggregates for ${competitions.length} competitions...`);

    let processed = 0;
    for (const comp of competitions) {
      const scores = yield* (sql<{
        total_score: number;
        ge1: number;
        ge2: number;
        vp: number;
        va: number;
        cg: number;
        mb: number;
        ma: number;
        mp: number;
      }>`
        SELECT
          cs.total_score,
          MAX(CASE WHEN js.caption_name = 'GE1' THEN js.score ELSE 0 END) as ge1,
          MAX(CASE WHEN js.caption_name = 'GE2' THEN js.score ELSE 0 END) as ge2,
          MAX(CASE WHEN js.caption_name = 'VP' THEN js.score ELSE 0 END) as vp,
          MAX(CASE WHEN js.caption_name = 'VA' THEN js.score ELSE 0 END) as va,
          MAX(CASE WHEN js.caption_name = 'CG' THEN js.score ELSE 0 END) as cg,
          MAX(CASE WHEN js.caption_name = 'MB' THEN js.score ELSE 0 END) as mb,
          MAX(CASE WHEN js.caption_name = 'MA' THEN js.score ELSE 0 END) as ma,
          MAX(CASE WHEN js.caption_name = 'MP' THEN js.score ELSE 0 END) as mp
        FROM corps_scores cs
        JOIN judge_scores js ON js.competition_slug = cs.competition_slug AND js.corps_key = cs.corps_key
        WHERE cs.competition_slug = ${comp.slug}
        GROUP BY cs.corps_key
      `);

      if (scores.length === 0) continue;

      const aggregates = {
        competition_slug: comp.slug,
        avg_total: mean(scores.map((s) => s.total_score)),
        std_total: std(scores.map((s) => s.total_score)),
        avg_ge1: mean(scores.map((s) => s.ge1)),
        avg_ge2: mean(scores.map((s) => s.ge2)),
        avg_vp: mean(scores.map((s) => s.vp)),
        avg_va: mean(scores.map((s) => s.va)),
        avg_cg: mean(scores.map((s) => s.cg)),
        avg_ma: mean(scores.map((s) => s.ma)),
        avg_mb: mean(scores.map((s) => s.mb)),
        avg_mp: mean(scores.map((s) => s.mp)),
        field_size: scores.length,
        created_at: new Date().toISOString(),
      };

      yield* (sql`INSERT OR REPLACE INTO show_aggregates_v7 ${sql.insert(aggregates)}`);

      processed++;
      if (processed % 100 === 0) {
        console.log(`Rebuilt ${processed} / ${competitions.length} show aggregates...`);
      }
    }

    console.log("Done rebuilding show_aggregates_v7.");
  });

const flushEloHistory = (sql: SqlClient.SqlClient, judgeHistory: any[], corpsHistory: any[]) =>
  Effect.gen(function* () {
    if (judgeHistory.length > 0) {
      yield* (sql`INSERT INTO judge_elo_history ${sql.insert(judgeHistory)}`);
      judgeHistory.length = 0;
    }
    if (corpsHistory.length > 0) {
      yield* (sql`INSERT INTO corps_elo_history ${sql.insert(corpsHistory)}`);
      corpsHistory.length = 0;
    }
  });

const saveFinalEloRatings = (
  sql: SqlClient.SqlClient,
  judgeEloMap: Map<string, EloState>,
  corpsEloMap: Map<string, EloState>
) =>
  Effect.gen(function* () {
    const judgeRatings: any[] = [];
    for (const [key, state] of judgeEloMap) {
      const [id, season, division, caption] = key.split(":");
      judgeRatings.push({
        judge_id: id,
        season,
        division_name: division,
        caption_name: caption,
        elo_rating: state.elo,
        confidence: state.confidence,
        num_scores: state.numScores,
        last_updated: new Date().toISOString(),
      });

      if (judgeRatings.length > 500) {
        yield* (sql`INSERT INTO judge_elo_ratings ${sql.insert(judgeRatings)}`);
        judgeRatings.length = 0;
      }
    }
    if (judgeRatings.length > 0) {
      yield* (sql`INSERT INTO judge_elo_ratings ${sql.insert(judgeRatings)}`);
    }

    const corpsRatings: any[] = [];
    for (const [key, state] of corpsEloMap) {
      const [id, season, division, caption] = key.split(":");
      corpsRatings.push({
        corps_key: id,
        season,
        division_name: division,
        caption_name: caption,
        elo_rating: state.elo,
        confidence: state.confidence,
        num_shows: state.numScores,
        last_updated: new Date().toISOString(),
      });

      if (corpsRatings.length > 500) {
        yield* (sql`INSERT INTO corps_elo_ratings ${sql.insert(corpsRatings)}`);
        corpsRatings.length = 0;
      }
    }
    if (corpsRatings.length > 0) {
      yield* (sql`INSERT INTO corps_elo_ratings ${sql.insert(corpsRatings)}`);
    }
  });

const rebuildEloRatingsV7 = (sql: SqlClient.SqlClient, asOfDate?: string) =>
  Effect.gen(function* () {
    console.log("Rebuilding judge/corps Elo tables...");

    yield* (sql`DROP TABLE IF EXISTS judge_elo_history`);
    yield* (sql`DROP TABLE IF EXISTS corps_elo_history`);
    yield* (sql`DROP TABLE IF EXISTS judge_elo_ratings`);
    yield* (sql`DROP TABLE IF EXISTS corps_elo_ratings`);

    yield* (sql`
      CREATE TABLE judge_elo_ratings (
        judge_id TEXT NOT NULL,
        season TEXT NOT NULL,
        division_name TEXT NOT NULL,
        caption_name TEXT NOT NULL,
        elo_rating REAL NOT NULL DEFAULT 1500,
        confidence REAL NOT NULL DEFAULT 50,
        num_scores INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT,
        PRIMARY KEY (judge_id, season, division_name, caption_name)
      )
    `);
    yield* (sql`
      CREATE TABLE judge_elo_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        judge_id TEXT NOT NULL,
        season TEXT NOT NULL,
        division_name TEXT NOT NULL,
        competition_slug TEXT NOT NULL,
        caption_name TEXT NOT NULL,
        elo_before REAL NOT NULL,
        elo_after REAL NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    yield* (sql`
      CREATE TABLE corps_elo_ratings (
        corps_key TEXT NOT NULL,
        season TEXT NOT NULL,
        division_name TEXT NOT NULL,
        caption_name TEXT NOT NULL DEFAULT 'overall',
        elo_rating REAL NOT NULL DEFAULT 1500,
        confidence REAL NOT NULL DEFAULT 50,
        num_shows INTEGER NOT NULL DEFAULT 0,
        last_updated TEXT,
        PRIMARY KEY (corps_key, season, division_name, caption_name)
      )
    `);
    yield* (sql`
      CREATE TABLE corps_elo_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        corps_key TEXT NOT NULL,
        season TEXT NOT NULL,
        division_name TEXT NOT NULL,
        competition_slug TEXT NOT NULL,
        caption_name TEXT,
        elo_before REAL NOT NULL,
        elo_after REAL NOT NULL,
        competition_date TEXT NOT NULL
      )
    `);

    const competitions = yield* (sql<{
      season: string;
      slug: string;
      competition_date: string;
    }>`
      SELECT season, slug, date as competition_date
      FROM competitions
      WHERE date <= ${asOfDate ?? "9999-12-31"}
      ORDER BY date ASC
    `);
    console.log(`Computing Elo for ${competitions.length} competitions...`);

    const judgeEloMap = new Map<string, EloState>();
    const corpsEloMap = new Map<string, EloState>();
    const judgeHistory: any[] = [];
    const corpsHistory: any[] = [];

    let processed = 0;
    for (const comp of competitions) {
      const scores = yield* (sql<{
        corps_key: string;
        division_name: string;
        caption_name: string;
        judge_id: string;
        score: number;
      }>`
        SELECT js.corps_key, cs.division_name, js.caption_name, js.judge_id, js.score
        FROM judge_scores js
        JOIN corps_scores cs ON cs.competition_slug = js.competition_slug AND cs.corps_key = js.corps_key
        WHERE js.competition_slug = ${comp.slug}
          AND cs.division_name IN ('World Class', 'Open Class')
          AND js.score > 0
          AND js.score <= ${MAX_SCORE}
          AND js.judge_id NOT LIKE '%unknown%'
      `);

      const competitionJudgeEloBefore = new Map<string, number>();
      const competitionCorpsEloBefore = new Map<string, number>();
      for (const score of scores) {
        const judgeKey = `${score.judge_id}:${comp.season}:${score.division_name}:${score.caption_name}`;
        const corpsKey = `${score.corps_key}:${comp.season}:${score.division_name}:${score.caption_name}`;
        if (!competitionJudgeEloBefore.has(judgeKey)) {
          competitionJudgeEloBefore.set(judgeKey, judgeEloMap.get(judgeKey)?.elo ?? INITIAL_ELO);
        }
        if (!competitionCorpsEloBefore.has(corpsKey)) {
          competitionCorpsEloBefore.set(corpsKey, corpsEloMap.get(corpsKey)?.elo ?? INITIAL_ELO);
        }
      }

      for (const score of scores) {
        const judgeKey = `${score.judge_id}:${comp.season}:${score.division_name}:${score.caption_name}`;
        const corpsKey = `${score.corps_key}:${comp.season}:${score.division_name}:${score.caption_name}`;

        const judgeState = judgeEloMap.get(judgeKey) ?? {
          elo: INITIAL_ELO,
          confidence: INITIAL_CONFIDENCE,
          numScores: 0,
        };
        const corpsState = corpsEloMap.get(corpsKey) ?? {
          elo: INITIAL_ELO,
          confidence: INITIAL_CONFIDENCE,
          numScores: 0,
        };

        const expected = 1 / (1 + Math.exp(-(corpsState.elo - judgeState.elo) / 400));
        const actual = score.score / MAX_SCORE;
        const kJudge = judgeState.numScores < CONFIDENCE_THRESHOLD ? K_FACTOR_NEW : K_FACTOR_STABLE;
        const kCorps = corpsState.numScores < CONFIDENCE_THRESHOLD ? K_FACTOR_NEW : K_FACTOR_STABLE;
        const delta = actual - expected;

        const judgeEloBefore = competitionJudgeEloBefore.get(judgeKey) ?? judgeState.elo;
        const corpsEloBefore = competitionCorpsEloBefore.get(corpsKey) ?? corpsState.elo;

        judgeState.elo += kJudge * delta;
        corpsState.elo += kCorps * delta;
        judgeState.confidence *= CONFIDENCE_DECAY;
        corpsState.confidence *= CONFIDENCE_DECAY;
        judgeState.numScores++;
        corpsState.numScores++;

        judgeEloMap.set(judgeKey, judgeState);
        corpsEloMap.set(corpsKey, corpsState);

        const updatedAt =
          (comp.competition_date as any) instanceof Date
            ? (comp.competition_date as any).toISOString()
            : String(comp.competition_date);

        judgeHistory.push({
          judge_id: score.judge_id,
          season: comp.season,
          division_name: score.division_name,
          competition_slug: comp.slug,
          caption_name: score.caption_name,
          elo_before: judgeEloBefore,
          elo_after: judgeState.elo,
          updated_at: updatedAt,
        });

        corpsHistory.push({
          corps_key: score.corps_key,
          season: comp.season,
          division_name: score.division_name,
          competition_slug: comp.slug,
          caption_name: score.caption_name,
          elo_before: corpsEloBefore,
          elo_after: corpsState.elo,
          competition_date: updatedAt,
        });
      }

      if (judgeHistory.length > 1000) {
        yield* (flushEloHistory(sql, judgeHistory, corpsHistory));
      }

      processed++;
      if (processed % 100 === 0) {
        console.log(`Processed ${processed} / ${competitions.length} competitions for Elo...`);
      }
    }

    yield* (flushEloHistory(sql, judgeHistory, corpsHistory));
    yield* (saveFinalEloRatings(sql, judgeEloMap, corpsEloMap));

    console.log("Done rebuilding Elo tables.");
  });

const getBaseline = (rank: number, pct: number, caption: string, division = "World Class"): number => {
  const safeRank = Math.max(1, Math.min(25, Math.round(Number.isFinite(rank) ? rank : 12)));
  const bucket = Math.max(0, Math.min(100, Math.round((Number.isFinite(pct) ? pct : 50) / 5) * 5));
  const key = `${division}|${safeRank}-${bucket}`;
  const legacyKey = `${safeRank}-${bucket}`;
  const curves = REFERENCE_CURVES.curves;

  if (curves[key] && curves[key][caption]) {
    return curves[key][caption];
  }

  return curves[`${division}|${safeRank}-50`]?.[caption] ||
    curves[legacyKey]?.[caption] ||
    curves[`${safeRank}-50`]?.[caption] ||
    15.0;
};

const computeSlope = (values: number[]): number => {
  if (values.length < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < values.length; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }
  const denom = values.length * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (values.length * sumXY - sumX * sumY) / denom;
};

const computeEma = (values: number[], alpha: number): number => {
  if (values.length === 0) return 0;
  let ema = values[0]!;
  for (let i = 1; i < values.length; i++) {
    ema = alpha * values[i]! + (1 - alpha) * ema;
  }
  return ema;
};

const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base]!;
  const upper = sorted[base + 1] ?? lower;
  return lower + rest * (upper - lower);
};

const computeStats = (values: number[]) => {
  if (values.length === 0) {
    return {
      mean: 0,
      median: 0,
      std: 0,
      min: 0,
      max: 0,
      p25: 0,
      p75: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;

  return {
    mean,
    median: quantile(sorted, 0.5),
    std: Math.sqrt(variance),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
  };
};

const computeSeriesStats = (values: number[]) => {
  if (values.length === 0) {
    return { mean: 0, slope: 0, volatility: 0 };
  }
  const meanValue = values.reduce((sum, value) => sum + value, 0) / values.length;
  const slope = computeSlope(values);
  const volatility = values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - meanValue) ** 2, 0) / values.length)
    : 0;
  return { mean: meanValue, slope, volatility };
};

const emptyCaptionResidualRecord = () =>
  Object.fromEntries(CAPTIONS.map((caption) => [caption, 0])) as Record<Caption, number>;

type CaptionFingerprintEntry = {
  season: number;
  date: string;
  percentThrough: number;
  residuals: Record<Caption, number>;
};

const averageResiduals = (entries: CaptionFingerprintEntry[]) => {
  const result = emptyCaptionResidualRecord();
  if (entries.length === 0) return result;
  for (const caption of CAPTIONS) {
    result[caption] = mean(entries.map((entry) => entry.residuals[caption] ?? 0));
  }
  return result;
};

const weightedResiduals = (entries: CaptionFingerprintEntry[]) => {
  const result = emptyCaptionResidualRecord();
  if (entries.length === 0) return result;
  const maxSeason = Math.max(...entries.map((entry) => entry.season));
  for (const caption of CAPTIONS) {
    let weightedSum = 0;
    let weightSum = 0;
    for (const entry of entries) {
      const age = Math.max(0, maxSeason - entry.season);
      const weight = Math.pow(0.65, age);
      weightedSum += (entry.residuals[caption] ?? 0) * weight;
      weightSum += weight;
    }
    result[caption] = weightSum > 0 ? weightedSum / weightSum : 0;
  }
  return result;
};

const volatilityResiduals = (entries: CaptionFingerprintEntry[]) => {
  const result = emptyCaptionResidualRecord();
  for (const caption of CAPTIONS) {
    result[caption] = std(entries.map((entry) => entry.residuals[caption] ?? 0));
  }
  return result;
};

const growthResiduals = (entries: CaptionFingerprintEntry[]) => {
  const result = emptyCaptionResidualRecord();
  if (entries.length < 2) return result;

  for (const caption of CAPTIONS) {
    const bySeason = new Map<number, { early: number[]; late: number[] }>();
    for (const entry of entries) {
      const bucket = bySeason.get(entry.season) ?? { early: [], late: [] };
      if (entry.percentThrough <= 35) bucket.early.push(entry.residuals[caption] ?? 0);
      if (entry.percentThrough >= 75) bucket.late.push(entry.residuals[caption] ?? 0);
      bySeason.set(entry.season, bucket);
    }
    const seasonGrowth = [...bySeason.values()]
      .filter((bucket) => bucket.early.length > 0 && bucket.late.length > 0)
      .map((bucket) => mean(bucket.late) - mean(bucket.early));
    result[caption] = mean(seasonGrowth);
  }
  return result;
};

const buildCaptionFingerprintFeatures = (
  fingerprints: Map<string, CaptionFingerprintEntry[]>,
  corpsKey: string,
  division: string,
  targetSeason: string
) => {
  const seasonNum = Number(targetSeason);
  const entries = (fingerprints.get(`${division}:${corpsKey}`) ?? [])
    .filter((entry) => entry.season < seasonNum)
    .sort((a, b) => a.season - b.season || a.date.localeCompare(b.date));
  const priorSeason = entries.filter((entry) => entry.season === seasonNum - 1);
  const priorOrLatestSeason = priorSeason.length
    ? priorSeason
    : entries.filter((entry) => entry.season === Math.max(...entries.map((candidate) => candidate.season), -Infinity));
  const lastThreeSeasonFloor = seasonNum - 3;
  const multiYear = entries.filter((entry) => entry.season >= lastThreeSeasonFloor);
  const priorAvg = averageResiduals(priorOrLatestSeason);
  const multiAvg = weightedResiduals(multiYear.length ? multiYear : entries);
  const growth = growthResiduals(multiYear.length ? multiYear : entries);
  const vol = volatilityResiduals(multiYear.length ? multiYear : entries);
  const confidence = Math.min(1, entries.length / 24);

  const features: number[] = [];
  for (const caption of CAPTIONS) {
    features.push(
      priorAvg[caption] / 2,
      multiAvg[caption] / 2,
      growth[caption] / 2,
      Math.min(vol[caption] / 2, 2)
    );
  }
  features.push(confidence);
  return features;
};

const bucketPercent = (percent: number) => Math.max(0, Math.min(100, Math.round(percent / 5) * 5));

const getAgnosticShowId = (slug: string) => {
  // Remove year prefix (e.g., "2022-dci-world-championship" -> "dci-world-championship")
  const baseSlug = slug.replace(/^\d{4}-/, "");
  return SHOW_INDEX_MAP[baseSlug] ?? 0;
};

type OpponentSnapshot = {
  residualMean: number;
  rank: number;
};

type OpponentHistoryEntry = {
  date: string;
  residualMean: number;
  rank: number;
  totalScore: number;
  captionScores: number[];
};

const computeWeightedMean = (values: number[], weights: number[]) => {
  if (values.length === 0) return 0;
  let total = 0;
  let weightSum = 0;
  for (let i = 0; i < values.length; i++) {
    const weight = weights[i] ?? 0;
    total += values[i]! * weight;
    weightSum += weight;
  }
  return weightSum === 0 ? 0 : total / weightSum;
};

const summarizeOpponents = (snapshots: OpponentSnapshot[], fieldSize: number, topK = 3) => {
  const residuals = snapshots.map((snap) => snap.residualMean);
  const ranks = snapshots.map((snap) => snap.rank || fieldSize);
  const residualStats = computeStats(residuals);
  const rankStats = computeStats(ranks);
  const weights = ranks.map((rank) => (fieldSize - Math.min(rank, fieldSize) + 1) / fieldSize);
  const weightedResidualMean = computeWeightedMean(residuals, weights);

  const sortedByRank = [...snapshots].sort((a, b) => (a.rank || fieldSize) - (b.rank || fieldSize));
  const topResiduals: number[] = [];
  const topRanks: number[] = [];
  for (let i = 0; i < topK; i++) {
    const snapshot = sortedByRank[i];
    topResiduals.push(snapshot ? snapshot.residualMean : 0);
    topRanks.push(snapshot ? normalizeRank(snapshot.rank) : normalizeRank(fieldSize));
  }

  return {
    residualStats,
    weightedResidualMean,
    rankMean: normalizeRank(rankStats.mean || fieldSize),
    rankBest: normalizeRank(rankStats.min || fieldSize),
    topResiduals,
    topRanks,
  };
};

const meanOrZero = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

const summarizeOpponentLast3 = (
  opponentHistoryMap: Map<string, OpponentHistoryEntry[]>,
  opponentKeys: string[],
  cutoffMs: number
) => {
  const totalMeans: number[] = [];
  const totalSlopes: number[] = [];
  const totalVols: number[] = [];
  const captionMeans = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const captionSlopes = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);
  const captionVols = Array.from({ length: CAPTION_COUNT }, () => [] as number[]);

  for (const opponentKey of opponentKeys) {
    const history = opponentHistoryMap.get(opponentKey) ?? [];
    const last3 = history.filter((entry) => new Date(entry.date).getTime() < cutoffMs).slice(-3);
    if (!last3.length) continue;

    const totalSeries = last3.map((entry) => entry.totalScore);
    const totalStats = computeSeriesStats(totalSeries);
    totalMeans.push(totalStats.mean);
    totalSlopes.push(totalStats.slope);
    totalVols.push(totalStats.volatility);

    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      const series = last3.map((entry) => entry.captionScores[idx] ?? 0);
      const stats = computeSeriesStats(series);
      captionMeans[idx]!.push(stats.mean);
      captionSlopes[idx]!.push(stats.slope);
      captionVols[idx]!.push(stats.volatility);
    }
  }

  return {
    total: {
      mean: meanOrZero(totalMeans),
      slope: meanOrZero(totalSlopes),
      volatility: meanOrZero(totalVols),
    },
    captions: {
      mean: captionMeans.map(meanOrZero),
      slope: captionSlopes.map(meanOrZero),
      volatility: captionVols.map(meanOrZero),
    }
  };
};

export const ensureSequenceTablesV6 = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_sequence_rows_v6_production (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      competition_slug TEXT NOT NULL,
      competition_date TEXT NOT NULL,
      division_name TEXT NOT NULL,
      corps_key TEXT NOT NULL,
      corps_id INTEGER NOT NULL,
      x_sequence_json TEXT NOT NULL,
      x_static_json TEXT NOT NULL,
      y_residuals_json TEXT NOT NULL,
      y_recap_json TEXT NOT NULL,
      split TEXT NOT NULL CHECK(split IN ('train','val','test')),
      UNIQUE(season, competition_slug, division_name, corps_key)
    )
  `);
});

type CorpsHistorical = {
  years_in_world_class: number;
  historical_mean_rank: number;
  historical_std_rank: number;
  historical_best_rank: number;
  best_rank_recency: number;
  made_finals_rate: number;
  first_season: number;
};

type V10TemporalHistory = CorpsHistorical & {
  row_key: string;
  previous_season_rank: number;
  last_season_final_score: number;
  last_season_final_date: string;
};

type V10TemporalCaption = {
  row_key: string;
  caption: Caption;
  reference_baseline: number;
  prior_range_min: number;
  prior_range_max: number;
  corps_elo_before: number;
  as_of_date: string;
};

type V10TemporalFieldPace = {
  row_key: string;
  field_level_vs_reference: number;
  shrunk_residual_slope: number;
  residual_ema: number;
  confidence: number;
  as_of_date: string;
};

const v10RowKey = (season: string, slug: string, division: string, corpsKey: string) =>
  `${season}|${slug}|${division}|${corpsKey}`;

type CompetitionContext = {
  field_size: number;
  leader_score: number;
  score_by_rank: Map<number, number>;
  corps_present: string[];
};

type BuildV9SubcaptionOptions = {
  rebuildLoadedData?: boolean;
  asOfDate?: string;
  captionSource?: "raw-v9" | "clean-v10";
  targetTable?: string;
  builderVersion?: string;
  outputDbPath?: string;
  // Serving (Phase A2): build INFERENCE rows for these upcoming/unscored event
  // slugs. Each is injected into corpsMap as a target for its lineup corps, using
  // the same leakage-safe feature computation as scored shows (history strictly
  // before the event) but with y left 0. Pair with asOfDate = the event's eve so
  // the event itself is not double-built from any scored rows.
  inferenceEvents?: string[];
};

export const buildSequencesV9 = (
  seasons: string[] = SEASONS,
  options: BuildV9SubcaptionOptions = {},
) => Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const captionSource = options.captionSource ?? "raw-v9";

  // Serving (Phase A2): resolve the lineup + target context for each --inference-events
  // slug, keyed by `${season}__${division}` → [{slug,date,percentThrough,corpsKeys}].
  // Lineup comes from corps_competition_results (announced/scored field); scores are
  // NOT read (an inference target carries no y).
  const inferenceBySeasonDivision = new Map<
    string,
    Array<{ slug: string; date: string; percentThrough: number; corpsKeys: string[] }>
  >();
  if (options.inferenceEvents?.length) {
    for (const slug of options.inferenceEvents) {
      const res = yield* (sql<{
        season: string;
        division_name: string;
        competition_date: string;
        percent_through: number | null;
        corps_key: string;
      }>`SELECT season, division_name, competition_date, percent_through, corps_key
         FROM corps_competition_results WHERE competition_slug = ${slug}`);
      const byDiv = new Map<string, { season: string; date: string; pct: number; corps: string[] }>();
      for (const r of res) {
        const key = `${r.season}__${r.division_name}`;
        const e = byDiv.get(key) ?? {
          season: String(r.season),
          date: String(r.competition_date),
          pct: Number(r.percent_through ?? 50),
          corps: [],
        };
        if (!e.corps.includes(r.corps_key)) e.corps.push(r.corps_key);
        byDiv.set(key, e);
      }
      for (const [key, e] of byDiv) {
        const list = inferenceBySeasonDivision.get(key) ?? [];
        list.push({ slug, date: e.date, percentThrough: e.pct, corpsKeys: e.corps });
        inferenceBySeasonDivision.set(key, list);
      }
    }
    console.log(`Inference targets: ${options.inferenceEvents.join(", ")}`);
  }
  const targetTable = options.outputDbPath ? `v10out.${options.targetTable ?? V10_TARGET_TABLE}` : options.targetTable ?? V9_TARGET_TABLE;
  const builderVersion = options.builderVersion ?? V9_BUILDER_VERSION;

  if (options.outputDbPath) {
    yield* (sql.unsafe("ATTACH DATABASE ? AS v10out", [options.outputDbPath]));
    yield* (sql.unsafe("CREATE TEMP VIEW v10_training_performances AS SELECT * FROM v10out.v10_training_performances"));
    yield* (sql.unsafe("CREATE TEMP VIEW v10_temporal_caption_features AS SELECT * FROM v10out.v10_temporal_caption_features"));
    yield* (sql.unsafe("CREATE TEMP VIEW v10_temporal_corps_history AS SELECT * FROM v10out.v10_temporal_corps_history"));
    yield* (sql.unsafe("CREATE TEMP VIEW v10_temporal_judge_elo AS SELECT * FROM v10out.v10_temporal_judge_elo"));
    if (cliV10FeatureProfile === "field-pace") {
      yield* (sql.unsafe("CREATE TEMP VIEW v10_temporal_field_pace AS SELECT * FROM v10out.v10_temporal_field_pace"));
    }
  }

  yield* (sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${targetTable} (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      competition_slug TEXT NOT NULL,
      competition_date TEXT NOT NULL,
      division_name TEXT NOT NULL,
      corps_key TEXT NOT NULL,
      corps_id INTEGER,
      x_sequence_json TEXT NOT NULL,
      x_static_json TEXT NOT NULL,
      judge_indices_json TEXT NOT NULL,
      y_residuals_json TEXT NOT NULL,
      y_recap_json TEXT NOT NULL,
      y_total REAL NOT NULL,
      agnostic_show_id INTEGER NOT NULL DEFAULT 0,
      builder_version TEXT NOT NULL,
      reference_curves_version TEXT NOT NULL,
      map_version TEXT NOT NULL,
      split TEXT NOT NULL CHECK(split IN ('train','val','test')),
      created_at TEXT NOT NULL,
      UNIQUE(season, competition_slug, division_name, corps_key)
    )
  `));

  const historicalRows = captionSource === "clean-v10"
    ? yield* (sql<V10TemporalHistory>`
      SELECT row_key, years_in_world_class, historical_mean_rank, historical_std_rank,
        historical_best_rank, best_rank_recency, made_finals_rate, first_season,
        previous_season_rank, last_season_final_score, last_season_final_date
      FROM v10_temporal_corps_history
    `)
    : yield* (
    sql<{
      corps_key: string;
      years_in_world_class: number;
      historical_mean_rank: number;
      historical_std_rank: number;
      historical_best_rank: number;
      best_rank_recency: number;
      made_finals_rate: number;
      first_season: number;
    }>`
      SELECT
        corps_key,
        years_in_world_class,
        historical_mean_rank,
        historical_std_rank,
        historical_best_rank,
        best_rank_recency,
        made_finals_rate,
        first_season
      FROM corps_historical_features_v6
    `
  );

  const historicalMap = new Map<string, CorpsHistorical>();
  for (const row of captionSource === "clean-v10" ? [] : historicalRows as Array<CorpsHistorical & { corps_key: string }>) {
    historicalMap.set(row.corps_key, {
      years_in_world_class: row.years_in_world_class,
      historical_mean_rank: row.historical_mean_rank,
      historical_std_rank: row.historical_std_rank,
      historical_best_rank: row.historical_best_rank,
      best_rank_recency: row.best_rank_recency,
      made_finals_rate: row.made_finals_rate,
      first_season: row.first_season,
    });
  }
  const temporalHistoryMap = new Map<string, V10TemporalHistory>();
  if (captionSource === "clean-v10") {
    for (const row of historicalRows as V10TemporalHistory[]) temporalHistoryMap.set(row.row_key, row);
  }

  const temporalCaptionRows = captionSource === "clean-v10"
    ? yield* (sql<V10TemporalCaption>`SELECT row_key, caption, reference_baseline, prior_range_min, prior_range_max, corps_elo_before, as_of_date FROM v10_temporal_caption_features`)
    : [];
  const temporalCaptionMap = new Map<string, V10TemporalCaption>();
  for (const row of temporalCaptionRows) temporalCaptionMap.set(`${row.row_key}|${row.caption}`, row);
  const temporalFieldPaceRows = captionSource === "clean-v10" && cliV10FeatureProfile === "field-pace"
    ? yield* (sql<V10TemporalFieldPace>`SELECT row_key, field_level_vs_reference, shrunk_residual_slope, residual_ema, confidence, as_of_date FROM v10_temporal_field_pace`)
    : [];
  const temporalFieldPaceMap = new Map<string, V10TemporalFieldPace>();
  for (const row of temporalFieldPaceRows) temporalFieldPaceMap.set(row.row_key, row);
  // Serving (Phase A2): inference targets have no temporal caption feature row —
  // tolerate the miss so baselineFor falls back to getBaseline (the dev3 curve,
  // which IS the reference_baseline). Training rows still hard-fail on a real gap.
  const inferenceSlugSet = new Set(options.inferenceEvents ?? []);
  const isInferenceRowKey = (rowKey: string) => {
    for (const slug of inferenceSlugSet) if (rowKey.includes(slug)) return true;
    return false;
  };
  const temporalCaptionFor = (rowKey: string, caption: Caption) => {
    const row = temporalCaptionMap.get(`${rowKey}|${caption}`);
    if (captionSource === "clean-v10" && !row && !isInferenceRowKey(rowKey))
      throw new Error(`Missing V10 temporal caption feature ${rowKey}|${caption}`);
    return row;
  };
  const baselineFor = (rowKey: string, rank: number, pct: number, caption: Caption, division: string) =>
    temporalCaptionFor(rowKey, caption)?.reference_baseline ?? getBaseline(rank, pct, caption, division);

  const seasonRowsMap = new Map<string, ReadonlyArray<any>>();
  const captionRangeMap = new Map<string, { min: number; max: number }>();
  const seasonDivisionKey = (season: string, division: string) => `${season}__${division}`;

  const contextSeasons = captionSource === "clean-v10"
    ? [...new Set([...SEASONS, ...seasons])].sort()
    : seasons;
  for (const season of contextSeasons) {
    for (const division of DIVISIONS) {
      const queriedRows = yield* (
        captionSource === "clean-v10"
          ? MlQueries.querySeasonCaptionsV10Clean(season, division)
          : MlQueries.querySeasonCaptionsV6(season, division)
      );
      const seasonRows = options.asOfDate
        ? queriedRows.filter((row) => row.date <= options.asOfDate!)
        : queriedRows;
      seasonRowsMap.set(seasonDivisionKey(season, division), seasonRows);

      for (const row of captionSource === "clean-v10" ? [] : seasonRows) {
        const capKey = CAPTION_MAP[row.caption_name];
        if (!capKey) continue;

        // SKIP INVALID SCORES to prevent history poisoning
        if (row.total_score <= 0) continue;

        const bucket = bucketPercent(row.percent_through ?? 0);
        const rangeKey = `${division}_${bucket}_${capKey}`;
        const existing = captionRangeMap.get(rangeKey);
        if (!existing) {
          captionRangeMap.set(rangeKey, { min: row.score, max: row.score });
        } else {
          existing.min = Math.min(existing.min, row.score);
          existing.max = Math.max(existing.max, row.score);
        }
      }
    }
  }

  const getCaptionRange = (rowKey: string, percentThrough: number, caption: Caption, division: string) => {
    const temporal = temporalCaptionFor(rowKey, caption);
    if (temporal) return { min: temporal.prior_range_min, max: temporal.prior_range_max };
    const bucket = bucketPercent(percentThrough);
    const range = captionRangeMap.get(`${division}_${bucket}_${caption}`);
    return {
      min: range?.min ?? 0,
      max: range?.max ?? 20,
    };
  };

  const prevSeasonRanks: Record<string, Record<string, Record<string, number>>> = {};
  const prevSeasonFinalState: Record<string, Record<string, Record<string, { total: number; rank: number; date: string }>>> = {};
  for (const season of contextSeasons) {
    let prevYear = parseInt(season, 10) - 1;
    if (season === "2022") prevYear = 2019;

    prevSeasonRanks[season] = {};
    prevSeasonFinalState[season] = {};
    for (const division of DIVISIONS) {
      const raw = yield* (MlQueries.queryPreviousSeasonFinalRankings(prevYear.toString(), division));
      const sortedRaw = [...raw].sort((a, b) => b.best_total - a.best_total);
      prevSeasonRanks[season]![division] = {};
      prevSeasonFinalState[season]![division] = {};
      sortedRaw.forEach((row, idx) => {
        const rank = idx + 1;
        prevSeasonRanks[season]![division]![row.corps_key] = rank;
        prevSeasonFinalState[season]![division]![row.corps_key] = {
          total: row.best_total,
          rank,
          date: `${prevYear}-08-15`,
        };
      });
    }
  }

  const captionFingerprintHistory = new Map<string, CaptionFingerprintEntry[]>();
  for (const season of contextSeasons) {
    for (const division of DIVISIONS) {
      const rows = seasonRowsMap.get(seasonDivisionKey(season, division)) ?? [];
      const byShowCorps = new Map<string, {
        corpsKey: string;
        slug: string;
        date: string;
        percentThrough: number;
        rank: number;
        captions: Partial<Record<Caption, number>>;
      }>();

      for (const row of rows) {
        if (!Number.isFinite(row.total_score) || row.total_score <= 0 || row.total_score > 100) continue;
        const caption = CAPTION_MAP[row.caption_name] as Caption | undefined;
        if (!caption || !Number.isFinite(row.score) || row.score <= 0 || row.score > MAX_SCORE) continue;
        const key = `${row.slug}:${row.corps_key}`;
        const existing = byShowCorps.get(key) ?? {
          corpsKey: row.corps_key,
          slug: row.slug,
          date: row.date,
          percentThrough: Number(row.percent_through ?? 50),
          rank: Number(row.rank ?? 12),
          captions: {} as Partial<Record<Caption, number>>,
        };
        existing.captions[caption] = Number(row.score);
        byShowCorps.set(key, existing);
      }

      for (const show of byShowCorps.values()) {
        if (!CAPTIONS.every((caption) => Number.isFinite(show.captions[caption]))) continue;
        const residuals = emptyCaptionResidualRecord();
        for (const caption of CAPTIONS) {
          residuals[caption] =
            Number(show.captions[caption]) - baselineFor(v10RowKey(season, show.slug, division, show.corpsKey), show.rank, show.percentThrough, caption, division);
        }
        const key = `${division}:${show.corpsKey}`;
        const list = captionFingerprintHistory.get(key) ?? [];
        list.push({
          season: Number(season),
          date: show.date,
          percentThrough: show.percentThrough,
          residuals,
        });
        captionFingerprintHistory.set(key, list);
      }
    }
  }
  console.log(`Prepared caption fingerprint history for ${captionFingerprintHistory.size} corps/division pairs.`);

  console.log("Loading show aggregates...");
  const showAggregatesRows = captionSource === "clean-v10" ? [] : yield* (sql<{
    competition_slug: string;
    avg_total: number;
    std_total: number;
    avg_ge1: number;
    avg_ge2: number;
    avg_vp: number;
    avg_va: number;
    avg_cg: number;
    avg_ma: number;
    avg_mb: number;
    avg_mp: number;
    field_size: number;
  }>`SELECT competition_slug, avg_total, std_total, avg_ge1, avg_ge2, avg_vp, avg_va, avg_cg, avg_ma, avg_mb, avg_mp, field_size FROM show_aggregates_v7`);

  const showAggregatesMap = new Map<string, typeof showAggregatesRows[0]>();
  for (const row of showAggregatesRows) {
    showAggregatesMap.set(row.competition_slug, row);
  }
  console.log(`Loaded ${showAggregatesMap.size} show aggregates`);

  console.log("Pre-caching pre-show corps Elo history...");
  const allCorpsElos = captionSource === "clean-v10" ? [] : yield* (sql<{
    corps_key: string;
    season: string;
    division_name: string;
    competition_slug: string;
    caption_name: string;
    elo_before: number;
  }>`
    SELECT h.corps_key, h.season, h.division_name, h.competition_slug, h.caption_name, h.elo_before
    FROM corps_elo_history h
    JOIN (
      SELECT corps_key, season, division_name, competition_slug, caption_name, MIN(history_id) AS history_id
      FROM corps_elo_history
      GROUP BY corps_key, season, division_name, competition_slug, caption_name
    ) first
      ON first.history_id = h.history_id
  `);

  const corpsPreShowEloCache = new Map<string, number>();
  for (const row of allCorpsElos) {
    const key = `${row.corps_key}:${row.season}:${row.division_name}:${row.competition_slug}:${row.caption_name}`;
    corpsPreShowEloCache.set(key, row.elo_before);
  }
  console.log(`Cached ${corpsPreShowEloCache.size} pre-show corps Elo entries.`);

  console.log("Pre-caching pre-show judge Elo history...");
  const allJudgeElos = captionSource === "clean-v10"
    ? yield* (sql<{
      judge_id: string; season: string; division_name: string; competition_slug: string; caption_name: string; elo_before: number;
    }>`SELECT DISTINCT j.judge_id, p.season, j.division_name, j.competition_slug, j.caption AS caption_name, j.elo_before
      FROM v10_temporal_judge_elo j JOIN v10_training_performances p
        ON p.competition_slug=j.competition_slug AND p.division_name=j.division_name`)
    : yield* (sql<{
    judge_id: string;
    season: string;
    division_name: string;
    competition_slug: string;
    caption_name: string;
    elo_before: number;
  }>`
    SELECT h.judge_id, h.season, h.division_name, h.competition_slug, h.caption_name, h.elo_before
    FROM judge_elo_history h
    JOIN (
      SELECT judge_id, season, division_name, competition_slug, caption_name, MIN(history_id) AS history_id
      FROM judge_elo_history
      GROUP BY judge_id, season, division_name, competition_slug, caption_name
    ) first
      ON first.history_id = h.history_id
  `);

  const judgePreShowEloCache = new Map<string, number>();
  for (const row of allJudgeElos) {
    const key = `${row.judge_id}:${row.season}:${row.division_name}:${row.competition_slug}:${row.caption_name}`;
    judgePreShowEloCache.set(key, row.elo_before);
  }
  console.log(`Cached ${judgePreShowEloCache.size} pre-show judge Elo entries.`);

  for (const season of seasons) {
    console.log(`Processing season ${season}...`);
    const performanceOrderRows = yield* (MlQueries.queryPerformanceOrder(season));

    const performanceOrderMap = new Map<string, {
      orderOverall: number | null;
      orderInClass: number | null;
      countOverall: number;
      countInClass: number;
    }>();

    let totalRows = 0;
    let rowsWithOrder = 0;
    let rowsWithoutOrder = 0;

    for (const row of performanceOrderRows) {
      totalRows++;
      const key = `${row.competition_slug}_${row.corps_key}`;

      const hasOrder = row.performance_order_in_class !== null;
      if (hasOrder) {
        rowsWithOrder++;
      } else {
        rowsWithoutOrder++;
      }

      performanceOrderMap.set(key, {
        orderOverall: row.performance_order_overall,
        orderInClass: row.performance_order_in_class,
        countOverall: row.number_of_performers_overall ?? 0,
        countInClass: row.number_of_performers_in_class ?? 0,
      });
    }

    console.log(`Performance order data: ${totalRows} total corps, ${rowsWithOrder} with explicit order, ${rowsWithoutOrder} without order`);

    for (const division of DIVISIONS) {
      console.log(`Processing season ${season} ${division}...`);
      const rows = seasonRowsMap.get(seasonDivisionKey(season, division)) ?? [];
      if (rows.length === 0) {
        console.log(`No rows for ${season} ${division}. Skipping.`);
        continue;
      }

      const corpsMap = new Map<string, any[]>();
      const competitionMap = new Map<string, CompetitionContext>();

      for (const row of rows) {
        if (!corpsMap.has(row.corps_key)) corpsMap.set(row.corps_key, []);
        const shows = corpsMap.get(row.corps_key)!;

        let lastShow = shows[shows.length - 1];
        if (!lastShow || lastShow.slug !== row.slug) {
          // Double check score validity before starting a new show entry
          if (row.total_score <= 0) continue;

          lastShow = {
            slug: row.slug,
            date: row.date,
            event_name: row.event_name,
            percent_through: row.percent_through,
            rank: row.rank,
            total_score: row.total_score,
            division_name: row.division_name,
            captions: {},
          };
          shows.push(lastShow);
        }

        const capKey = CAPTION_MAP[row.caption_name];
        if (capKey) {
          lastShow.captions[capKey] = { score: row.score, rank: row.caption_rank };
        }

        const context = competitionMap.get(row.slug) ?? {
          field_size: 0,
          leader_score: 0,
          score_by_rank: new Map<number, number>(),
          corps_present: [],
        };
        if (!context.corps_present.includes(row.corps_key)) {
          context.corps_present.push(row.corps_key);
          context.field_size += 1;
        }
        if (row.rank && row.total_score) {
          context.score_by_rank.set(row.rank, row.total_score);
          if (row.rank === 1) context.leader_score = row.total_score;
        }
        competitionMap.set(row.slug, context);
      }

      // Serving (Phase A2): inject inference targets for this season+division. Each
      // becomes the latest show for its lineup corps, so the row loop builds it from
      // all prior (scored) shows with the event's target context and y left empty.
      for (const inf of inferenceBySeasonDivision.get(seasonDivisionKey(season, division)) ?? []) {
        const infContext: CompetitionContext = {
          field_size: 0,
          leader_score: 0,
          score_by_rank: new Map<number, number>(),
          corps_present: [],
        };
        for (const corpsKey of inf.corpsKeys) {
          if (!corpsMap.has(corpsKey)) corpsMap.set(corpsKey, []);
          const shows = corpsMap.get(corpsKey)!;
          if (shows.some((s) => s.slug === inf.slug)) continue; // already present
          shows.push({
            slug: inf.slug,
            date: inf.date,
            event_name: inf.slug,
            percent_through: inf.percentThrough,
            rank: undefined,
            total_score: 0,
            division_name: division,
            captions: {},
            is_inference: true,
          });
          if (!infContext.corps_present.includes(corpsKey)) {
            infContext.corps_present.push(corpsKey);
            infContext.field_size += 1;
          }
        }
        competitionMap.set(inf.slug, infContext);
      }

      const showLookup = new Map<string, Map<string, any>>();
      for (const [corpsKey, shows] of corpsMap.entries()) {
        for (const show of shows) {
          const byCorps = showLookup.get(show.slug) ?? new Map<string, any>();
          byCorps.set(corpsKey, show);
          showLookup.set(show.slug, byCorps);
        }
      }

      for (const [slug, context] of competitionMap.entries()) {
        const byCorps = showLookup.get(slug);
        if (!byCorps) continue;
        const ranked = context.corps_present
          .map((corpsKey) => byCorps.get(corpsKey))
          .filter((show): show is any => !!show && Number.isFinite(show.total_score) && show.total_score > 0)
          .sort((a, b) => b.total_score - a.total_score);

        context.score_by_rank = new Map<number, number>();
        context.leader_score = ranked[0]?.total_score ?? 0;
        ranked.forEach((show, index) => {
          show.rank = index + 1;
          context.score_by_rank.set(index + 1, show.total_score);
        });
      }

      const localShowAggregatesMap = new Map<string, {
        avg_total: number;
        std_total: number;
        avg_ge1: number;
        avg_ge2: number;
        avg_vp: number;
        avg_va: number;
        avg_cg: number;
        avg_ma: number;
        avg_mb: number;
        avg_mp: number;
        field_size: number;
      }>();
      for (const [slug, byCorps] of showLookup.entries()) {
        const completeShows = Array.from(byCorps.values()).filter(hasConsistentCaptionTotal);
        if (!completeShows.length) continue;
        const totals = completeShows.map((show) => show.total_score as number);
        const captionAverage = (caption: Caption) =>
          mean(completeShows.map((show) => show.captions[caption]!.score!));
        localShowAggregatesMap.set(slug, {
          avg_total: mean(totals),
          std_total: std(totals),
          avg_ge1: captionAverage("GE1"),
          avg_ge2: captionAverage("GE2"),
          avg_vp: captionAverage("VP"),
          avg_va: captionAverage("VA"),
          avg_cg: captionAverage("CG"),
          avg_ma: captionAverage("MA"),
          avg_mb: captionAverage("MB"),
          avg_mp: captionAverage("MP"),
          field_size: completeShows.length,
        });
      }

      const defaultRank = Math.max(1, corpsMap.size);

      for (const shows of corpsMap.values()) {
        shows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
      }
      const historyFor = (corpsKey: string, slug: string): V10TemporalHistory | CorpsHistorical | undefined =>
        temporalHistoryMap.get(v10RowKey(season, slug, division, corpsKey)) ?? historicalMap.get(corpsKey);
      const previousRankFor = (corpsKey: string, slug: string) => {
        const temporal = temporalHistoryMap.get(v10RowKey(season, slug, division, corpsKey));
        return temporal?.previous_season_rank ?? prevSeasonRanks[season]?.[division]?.[corpsKey] ?? defaultRank;
      };

      const overallRankCache = new Map<string, Map<string, number>>();
      const dateSet = new Set<string>();
      for (const shows of corpsMap.values()) {
        for (const show of shows) {
          dateSet.add(show.date);
        }
      }

      const sortedDates = [...dateSet].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      const rankTrackers = new Map<string, { shows: any[]; idx: number; latest: any | null; prevRank: number }>();
      for (const [corpsKey, shows] of corpsMap.entries()) {
        rankTrackers.set(corpsKey, {
          shows,
          idx: 0,
          latest: null,
          prevRank: previousRankFor(corpsKey, shows[0]?.slug ?? ""),
        });
      }

      for (const date of sortedDates) {
        const standings: Array<{ corpsKey: string; hasScore: boolean; total: number; prevRank: number }> = [];
        for (const [corpsKey, tracker] of rankTrackers.entries()) {
          const targetMs = new Date(date).getTime();
          while (tracker.idx < tracker.shows.length && new Date(tracker.shows[tracker.idx]!.date).getTime() < targetMs) {
            tracker.latest = tracker.shows[tracker.idx]!;
            tracker.idx += 1;
          }
          standings.push({
            corpsKey,
            hasScore: !!tracker.latest,
            total: tracker.latest?.total_score ?? 0,
            prevRank: tracker.prevRank,
          });
        }

        standings.sort((a, b) => {
          if (a.hasScore !== b.hasScore) return (b.hasScore ? 1 : 0) - (a.hasScore ? 1 : 0);
          if (a.hasScore && b.hasScore) return b.total - a.total;
          return a.prevRank - b.prevRank;
        });

        const rankMap = new Map<string, number>();
        standings.forEach((entry, index) => {
          rankMap.set(entry.corpsKey, index + 1);
        });
        overallRankCache.set(date, rankMap);
      }

      const getOverallRank = (date: string, corpsKey: string, fallback: number) =>
        overallRankCache.get(date)?.get(corpsKey) ?? fallback;

      const opponentHistoryMap = new Map<string, OpponentHistoryEntry[]>();
      const scoredSeasonDates = Array.from(new Set(
        Array.from(corpsMap.values())
          .flat()
          .filter(hasConsistentCaptionTotal)
          .map((show) => show.date)
      )).sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
      const firstScoredDateOfSeason = scoredSeasonDates[0];

      for (const [corpsKey, shows] of corpsMap.entries()) {
        const prevRank = previousRankFor(corpsKey, shows[0]?.slug ?? "");
        shows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

        const history: OpponentHistoryEntry[] = [];
        for (let i = 0; i < shows.length; i++) {
          const show = shows[i];
          if (show.is_inference) continue; // unscored target: no real residual to contribute
          const rankEntering = getOverallRank(show.date, corpsKey, prevRank);
          let residualSum = 0;
          const captionScores = CAPTIONS.map((caption) => {
            const score = show.captions[caption]?.score ?? 0;
            const baseline = baselineFor(v10RowKey(season, show.slug, division, corpsKey), rankEntering, show.percent_through, caption, division);
            residualSum += score - baseline;
            return score;
          });
          history.push({
            date: show.date,
            residualMean: residualSum / CAPTIONS.length,
            rank: show.rank ?? rankEntering,
            totalScore: show.total_score ?? 0,
            captionScores,
          });
        }

        opponentHistoryMap.set(corpsKey, history);
      }

      const allInserts: any[] = [];

      for (const [corpsKey, shows] of corpsMap.entries()) {
        if (shows.length === 0) continue;

        const prevRank = previousRankFor(corpsKey, shows[0]?.slug ?? "");

        for (let i = 0; i < shows.length; i++) {
          const targetShow = shows[i];
          const pastShows = shows.slice(0, i);
          const seasonStartDate = pastShows[0]?.date ?? targetShow.date;
          const pastCount = pastShows.length || 1;

          const x_sequence: number[][] = [];
          for (let j = 0; j < SEQ_LEN; j++) {
            const showIdx = pastShows.length - (SEQ_LEN - j);
            if (showIdx < 0) {
              const padding = new Array(TIMESTEP_FEATURES).fill(0);
              padding[3] = 1;
              x_sequence.push(padding);
              continue;
            }

            const show = pastShows[showIdx];
            const prevShow = showIdx > 0 ? pastShows[showIdx - 1] : null;
            const rankEntering = getOverallRank(show.date, corpsKey, prevRank);

            const competition = competitionMap.get(show.slug);
            const fieldSize = competition?.field_size ?? 25;
            const leaderScore = competition?.leader_score ?? show.total_score;
            const scoreByRank = competition?.score_by_rank ?? new Map<number, number>();
            const gapToLeader = leaderScore - show.total_score;
            const gapToNext = show.rank > 1 ? (scoreByRank.get(show.rank - 1) ?? leaderScore) - show.total_score : 0;
            const percentile = fieldSize > 1 ? 1 - (show.rank - 1) / (fieldSize - 1) : 1;
            const totalScoreDelta = prevShow ? show.total_score - prevShow.total_score : 0;

            const feats: number[] = [];

            feats.push(show.percent_through / 100);
            const daysSince = prevShow ? Math.min(MlQueries.daysBetween(prevShow.date, show.date), 14) / 14 : 0.5;
            feats.push(daysSince);
            feats.push((showIdx + 1) / SEQ_LEN);
            feats.push(0);
            feats.push(normalizeDays(MlQueries.daysBetween(seasonStartDate, show.date)));
            feats.push((showIdx + 1) / pastCount);
            feats.push((pastCount - (showIdx + 1)) / pastCount);

            // New Timestep Features: Cyclic Date (2) + Progress (1)
            const d = new Date(show.date);
            const startOfYear = new Date(d.getFullYear(), 0, 1);
            const dayOfYear = (d.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24);
            const dayRad = (dayOfYear / 366) * 2 * Math.PI;
            feats.push(Math.sin(dayRad), Math.cos(dayRad));
            feats.push((showIdx + 1) / 40.0); // progressNorm

            const rankDelta = prevShow ? show.rank - prevShow.rank : 0;
            feats.push(normalizeScore(show.total_score));
            feats.push(normalizeRank(show.rank));
            feats.push(rankDelta / 25);
            feats.push(normalizeGap(gapToLeader));
            feats.push(normalizeGap(gapToNext));
            feats.push(percentile);
            feats.push(normalizeGap(totalScoreDelta));

            const orderKey = `${show.slug}_${corpsKey}`;
            const perfOrder = performanceOrderMap.get(orderKey);
            // Use -1 to indicate missing data (vs 0 for first performer)
            const orderInClass = perfOrder?.orderInClass ?? -1;
            const countInClass = perfOrder?.countInClass ?? fieldSize;
            const orderOverall = perfOrder?.orderOverall ?? -1;
            const countOverall = perfOrder?.countOverall ?? fieldSize;
            const orderInClassNorm = orderInClass >= 0 && countInClass > 0 ? orderInClass / countInClass : -1;
            const orderOverallNorm = orderOverall >= 0 && countOverall > 0 ? orderOverall / countOverall : -1;
            feats.push(orderInClass, orderInClassNorm, orderOverall, orderOverallNorm);

            for (const caption of CAPTIONS) {
              const captionScore = show.captions[caption]?.score;
              const captionRank = show.captions[caption]?.rank;
              const prevCaptionScore = prevShow?.captions[caption]?.score ?? captionScore;
              if (captionScore !== undefined) {
                const baseline = baselineFor(v10RowKey(season, show.slug, division, corpsKey), rankEntering, show.percent_through, caption, division);
                feats.push(captionScore - baseline);
                feats.push(captionRank ? captionRank / fieldSize : 0);
                feats.push(normalizeCaptionScore(captionScore));
                feats.push(normalizeCaptionScore(captionScore - (prevCaptionScore ?? captionScore)));
              } else {
                feats.push(0, 0, 0, 0);
              }
            }

            const opponentSnapshots: OpponentSnapshot[] = [];
            const showDateMs = new Date(show.date).getTime();
            const showCorpsPresent = competition?.corps_present ?? [];
            for (const opponentKey of showCorpsPresent) {
              if (opponentKey === corpsKey) continue;
              const history = opponentHistoryMap.get(opponentKey) ?? [];
              for (let idx = history.length - 1; idx >= 0; idx--) {
                const entry = history[idx]!;
                if (new Date(entry.date).getTime() < showDateMs) {
                  opponentSnapshots.push({
                    residualMean: entry.residualMean,
                    rank: entry.rank ?? fieldSize,
                  });
                  break;
                }
              }
            }
            const opponentSeriesSummary = summarizeOpponents(opponentSnapshots, fieldSize);
            feats.push(
              opponentSeriesSummary.residualStats.mean,
              opponentSeriesSummary.residualStats.std,
              opponentSeriesSummary.rankMean,
              opponentSeriesSummary.rankBest,
              ...opponentSeriesSummary.topResiduals
            );

            const opponentLast3 = summarizeOpponentLast3(opponentHistoryMap, showCorpsPresent.filter((key) => key !== corpsKey), showDateMs);
            feats.push(
              normalizeScore(opponentLast3.total.mean),
              normalizeGap(opponentLast3.total.slope),
              normalizeGap(opponentLast3.total.volatility),
              ...opponentLast3.captions.mean.map((value) => normalizeCaptionScore(value)),
              ...opponentLast3.captions.slope.map((value) => normalizeCaptionScore(value)),
              ...opponentLast3.captions.volatility.map((value) => normalizeCaptionScore(value))
            );

            const slug = show.slug.toLowerCase();
            const isFinals = slug.includes("finals") ? 1 : 0;
            const isSemis = slug.includes("semi") ? 1 : 0;
            const isRegional = slug.includes("regional") ? 1 : 0;
            const showDate = new Date(show.date);
            const isEarlySeason = showDate.getMonth() < 6 ? 1 : 0;
            feats.push(isFinals, isSemis, isRegional, isEarlySeason);

            const showAgg = localShowAggregatesMap.get(show.slug) ?? showAggregatesMap.get(show.slug);
            if (showAgg) {
              const relativeTotal = showAgg.std_total > 0 ? (show.total_score - showAgg.avg_total) / showAgg.std_total : 0;
              feats.push(relativeTotal);

              const captionAggMap: Record<string, number> = {
                "GE1": showAgg.avg_ge1,
                "GE2": showAgg.avg_ge2,
                "VP": showAgg.avg_vp,
                "VA": showAgg.avg_va,
                "CG": showAgg.avg_cg,
                "MB": showAgg.avg_mb,
                "MA": showAgg.avg_ma,
                "MP": showAgg.avg_mp
              };

              for (const caption of CAPTIONS) {
                const captionScore = show.captions[caption]?.score;
                const avgCaption = captionAggMap[caption] ?? 0;
                const relativeCaption = captionScore !== undefined ? captionScore - avgCaption : 0;
                feats.push(relativeCaption);
              }

              feats.push(showAgg.std_total / 10);
            } else {
              feats.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
            }

            x_sequence.push(feats);
          }

          const rankEntering = getOverallRank(targetShow.date, corpsKey, prevRank);

          const y_residuals: Record<string, number> = {};
          const y_recap: Record<string, number> = {};

          for (const caption of CAPTIONS) {
            const actual = targetShow.captions[caption]?.score;
            if (actual !== undefined) {
              y_recap[caption] = actual;
              const baseline = baselineFor(v10RowKey(season, targetShow.slug, division, corpsKey), rankEntering, targetShow.percent_through, caption, division);
              y_residuals[caption] = Number((actual - baseline).toFixed(4));
            } else {
              y_recap[caption] = 0;
              y_residuals[caption] = 0;
            }
          }

          const historical = historyFor(corpsKey, targetShow.slug);
          const yearsInWorldClass = historical?.years_in_world_class ?? 0;
          const meanRank = historical?.historical_mean_rank ?? 15;
          const stdRank = historical?.historical_std_rank ?? 0;
          const bestRank = historical?.historical_best_rank ?? 15;
          const bestRankRecency = historical?.best_rank_recency ?? 10;
          const madeFinalsRate = historical?.made_finals_rate ?? 0;
          const firstSeason = historical?.first_season ?? Number(season);
          const isNew = firstSeason === Number(season) ? 1 : 0;

          const sequenceLength = pastShows.length;
          const currentRank = getOverallRank(targetShow.date, corpsKey, prevRank);

          const rankEma = (() => {
            const ranks = pastShows.map((show) => getOverallRank(show.date, corpsKey, prevRank));
            if (!ranks.length) return currentRank;
            let ema = ranks[0]!;
            for (let i = 1; i < ranks.length; i++) {
              ema = EMA_ALPHA * ranks[i]! + (1 - EMA_ALPHA) * ema;
            }
            return ema;
          })();

          const captionResidualSeries: Record<Caption, number[]> = {} as Record<Caption, number[]>;
          for (const caption of CAPTIONS) {
            captionResidualSeries[caption] = [];
          }

          // Track Content/Achievement per caption
          const captionContentSeries: Record<Caption, number[]> = {} as Record<Caption, number[]>;
          const captionAchievementSeries: Record<Caption, number[]> = {} as Record<Caption, number[]>;
          for (const caption of CAPTIONS) {
            captionContentSeries[caption] = [];
            captionAchievementSeries[caption] = [];
          }

          const meanResidualSeries: number[] = [];
          pastShows.forEach((show) => {
            const rankEnter = getOverallRank(show.date, corpsKey, prevRank);
            let residualSum = 0;
            for (const caption of CAPTIONS) {
              const score = show.captions[caption]?.score ?? 0;
              const baseline = baselineFor(v10RowKey(season, show.slug, division, corpsKey), rankEnter, show.percent_through, caption, division);
              const residual = score - baseline;
              residualSum += residual;
              captionResidualSeries[caption]!.push(residual);
            }
            meanResidualSeries.push(residualSum / CAPTIONS.length);
          });

          // Fetch and aggregate subcaption scores for past shows
          for (const show of pastShows) {
            const subcaptionRows = yield* (sql<{
              caption_name: string;
              judge_id: string;
              subcaption_name: string;
              score: number;
            }>`
              SELECT caption_name, judge_id, subcaption_name, score
              FROM subcaption_scores
              WHERE competition_slug = ${show.slug} AND corps_key = ${corpsKey}
            `);

            // Aggregate by caption
            const captionSubcaptionMap = new Map<string, { content: number; achievement: number; count: number }>();

            for (const sub of subcaptionRows) {
              const capKey = CAPTION_MAP[sub.caption_name];
              if (!capKey) continue;

              const category = normalizeSubcaptionCategory(sub.subcaption_name);
              if (category === "Other") continue;

              if (!captionSubcaptionMap.has(capKey)) {
                captionSubcaptionMap.set(capKey, { content: 0, achievement: 0, count: 0 });
              }
              const entry = captionSubcaptionMap.get(capKey)!;

              if (category === "Content") entry.content += sub.score;
              else if (category === "Achievement") entry.achievement += sub.score;
              entry.count += 1;
            }

            // Add to series
            for (const caption of CAPTIONS) {
              const data = captionSubcaptionMap.get(caption);
              if (data && data.count > 0) {
                captionContentSeries[caption].push(data.content);
                captionAchievementSeries[caption].push(data.achievement);
              } else {
                // No subcaption data - use 0 as default (graceful degradation)
                captionContentSeries[caption].push(0);
                captionAchievementSeries[caption].push(0);
              }
            }
          }

          const residualEmaMean = computeEma(meanResidualSeries, EMA_ALPHA);
          const residualSlope = computeSlope(meanResidualSeries);
          const residualVolatility = meanResidualSeries.length > 1
            ? Math.sqrt(meanResidualSeries.reduce((sum, value) => sum + (value - residualEmaMean) ** 2, 0) / meanResidualSeries.length)
            : 0;

          const lastResidualMean = meanResidualSeries.length
            ? meanResidualSeries[meanResidualSeries.length - 1]!
            : 0;
          const lastResidualByCaption = CAPTIONS.map((caption) => {
            const series = captionResidualSeries[caption];
            return series.length ? series[series.length - 1]! : 0;
          });
          const emaResidualByCaption = CAPTIONS.map((caption) => computeEma(captionResidualSeries[caption], EMA_ALPHA));

          // Compute subcaption features
          const lastContentByCaption = CAPTIONS.map((caption) => {
            const series = captionContentSeries[caption];
            return series.length ? normalizeSubcaptionScore(series[series.length - 1]!) : 0;
          });

          const lastAchievementByCaption = CAPTIONS.map((caption) => {
            const series = captionAchievementSeries[caption];
            return series.length ? normalizeSubcaptionScore(series[series.length - 1]!) : 0;
          });

          const emaContentByCaption = CAPTIONS.map((caption) =>
            normalizeSubcaptionScore(computeEma(captionContentSeries[caption], EMA_ALPHA))
          );

          const emaAchievementByCaption = CAPTIONS.map((caption) =>
            normalizeSubcaptionScore(computeEma(captionAchievementSeries[caption], EMA_ALPHA))
          );

          const rankVsHistorical = currentRank - meanRank;
          const targetDate = new Date(targetShow.date);
          const premiereDate = new Date(pastShows[0]?.date ?? targetShow.date);
          const daysSinceSeasonStart = normalizeDays(MlQueries.daysBetween(firstScoredDateOfSeason ?? pastShows[0]?.date ?? targetShow.date, targetShow.date));
          const lastHistoryDate = pastShows[pastShows.length - 1]?.date;
          const daysSinceLastMatch = lastHistoryDate
            ? normalizeRecentGap(MlQueries.daysBetween(lastHistoryDate, targetShow.date))
            : 0.5;
          const showsRemainingApprox = Math.max(0, SEQ_LEN - (pastShows.length + 1)) / SEQ_LEN;
          const isSeasonDebutForCorps = pastShows.length === 0 ? 1 : 0;
          const sameSeasonHistoryCountNorm = Math.min(pastShows.length, 40) / 40;
          const daysSinceLastSameSeasonShowNorm = lastHistoryDate
            ? normalizeRecentGap(MlQueries.daysBetween(lastHistoryDate, targetShow.date))
            : 1;
          const temporalHistorical = temporalHistoryMap.get(v10RowKey(season, targetShow.slug, division, corpsKey));
          const lastPriorSeasonShow = temporalHistorical
            ? { total: temporalHistorical.last_season_final_score, rank: temporalHistorical.previous_season_rank, date: temporalHistorical.last_season_final_date }
            : prevSeasonFinalState[season]?.[division]?.[corpsKey];
          const daysSinceLastScoredAnySeasonNorm = lastHistoryDate
            ? normalizeOffseasonGap(MlQueries.daysBetween(lastHistoryDate, targetShow.date))
            : lastPriorSeasonShow
              ? normalizeOffseasonGap(MlQueries.daysBetween(lastPriorSeasonShow.date, targetShow.date))
              : 1;
          const lastSeasonFinalScoreNorm = lastPriorSeasonShow ? normalizeScore(lastPriorSeasonShow.total) : normalizeScore(70);
          const lastSeasonFinalRankNorm = lastPriorSeasonShow ? normalizeRank(lastPriorSeasonShow.rank) : normalizeRank(prevRank);
          const isFirstScoredEventOfSeason = firstScoredDateOfSeason === targetShow.date ? 1 : 0;
          const eventWeekIndexNorm = firstScoredDateOfSeason
            ? Math.min(Math.floor(MlQueries.daysBetween(firstScoredDateOfSeason, targetShow.date) / 7), 12) / 12
            : 0;
          const targetDayOfSeasonNorm = firstScoredDateOfSeason
            ? normalizeDays(MlQueries.daysBetween(firstScoredDateOfSeason, targetShow.date))
            : 0;

          const competition = competitionMap.get(targetShow.slug);
          const fieldSize = competition?.field_size ?? 25;
          const topCorpsPresent = competition?.corps_present.filter((corps) => {
            const h = historyFor(corps, targetShow.slug);
            return h ? h.historical_best_rank <= 5 : false;
          }).length ?? 0;
          const divisionStrength = competition?.corps_present.length
            ? competition.corps_present
              .map((corps) => historyFor(corps, targetShow.slug)?.historical_mean_rank ?? 15)
              .reduce((sum, value) => sum + value, 0) / competition.corps_present.length
            : 15;
          const isMajorShow = targetShow.slug.toLowerCase().includes("finals") ||
            targetShow.slug.toLowerCase().includes("regional") ? 1 : 0;
          const captionRangeFeatures = CAPTIONS.flatMap((caption) => {
            const range = getCaptionRange(v10RowKey(season, targetShow.slug, division, corpsKey), targetShow.percent_through, caption, division);
            return [normalizeCaptionScore(range.min), normalizeCaptionScore(range.max)];
          });

          const rankBaselineFeatures = CAPTIONS.map((caption) =>
            normalizeCaptionScore(baselineFor(v10RowKey(season, targetShow.slug, division, corpsKey), rankEntering, targetShow.percent_through, caption, division))
          );

          const opponentSnapshots: OpponentSnapshot[] = [];

          const targetDateMs = new Date(targetShow.date).getTime();
          const corpsPresent = competition?.corps_present ?? [];
          for (const opponentKey of corpsPresent) {
            if (opponentKey === corpsKey) continue;
            const history = opponentHistoryMap.get(opponentKey) ?? [];
            for (let idx = history.length - 1; idx >= 0; idx--) {
              const entry = history[idx]!;
              if (new Date(entry.date).getTime() < targetDateMs) {
                opponentSnapshots.push({
                  residualMean: entry.residualMean,
                  rank: entry.rank ?? fieldSize,
                });
                break;
              }
            }
          }
          const opponentSummary = summarizeOpponents(opponentSnapshots, fieldSize);
          const opponentLast3Summary = summarizeOpponentLast3(opponentHistoryMap, corpsPresent.filter((key) => key !== corpsKey), targetDateMs);

          const targetOrderKey = `${targetShow.slug}_${corpsKey}`;
          const targetOrder = performanceOrderMap.get(targetOrderKey);
          // Use -1 to indicate missing data
          const targetOrderInClass = targetOrder?.orderInClass ?? -1;
          const targetCountInClass = targetOrder?.countInClass ?? fieldSize;
          const targetOrderInClassNorm = targetOrderInClass >= 0 && targetCountInClass > 0
            ? targetOrderInClass / targetCountInClass
            : -1;
          const targetOrderOverall = targetOrder?.orderOverall ?? -1;
          const targetCountOverall = targetOrder?.countOverall ?? fieldSize;
          const targetOrderOverallNorm = targetOrderOverall >= 0 && targetCountOverall > 0
            ? targetOrderOverall / targetCountOverall
            : -1;

          const judgeIndices: number[] = new Array(CAPTIONS.length).fill(0);
          const judgeElos: number[] = [];
          const perCaptionJudgeElo: number[] = [];

          const judgeAssignments = captionSource === "clean-v10" ? yield* (sql<{
            judge_id: string;
            caption_name: string;
          }>`SELECT judge_id, normalized_caption_name AS caption_name FROM judge_assignments
              WHERE competition_slug = ${targetShow.slug}
                AND normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
                AND judge_id NOT LIKE '%unknown%'`) : yield* (sql<{
            judge_id: string;
            caption_name: string;
          }>`SELECT judge_id, caption_name FROM judge_assignments WHERE competition_slug = ${targetShow.slug}`);

          const captionJudgeEloMap = new Map<string, number[]>();
          for (const assignment of judgeAssignments) {
            const judgeId = assignment.judge_id;
            const captionName = assignment.caption_name;

            const eloKey = `${judgeId}:${season}:${division}:${targetShow.slug}:${captionName}`;
            const elo = judgePreShowEloCache.get(eloKey) ?? 1500;
            judgeElos.push(elo);

            if (!captionJudgeEloMap.has(captionName)) {
              captionJudgeEloMap.set(captionName, []);
            }
            captionJudgeEloMap.get(captionName)!.push(elo);

            const capKey = (captionSource === "clean-v10" && (CAPTIONS as readonly string[]).includes(captionName)
              ? captionName
              : CAPTION_MAP[captionName]) as Caption | undefined;
            if (capKey) {
              const slotIdx = (CAPTIONS as readonly string[]).indexOf(capKey);
              if (slotIdx !== -1) {
                judgeIndices[slotIdx] = JUDGE_INDEX_MAP[judgeId] ?? 0;
              }
            }
          }

          for (const caption of CAPTIONS) {
            const fullCaptionName = captionSource === "clean-v10" ? caption : fullCaptionNameFor(caption);
            const elos = captionJudgeEloMap.get(fullCaptionName) ?? [];
            const avgElo = elos.length > 0 ? elos.reduce((a, b) => a + b, 0) / elos.length : 1500;
            perCaptionJudgeElo.push((avgElo - 1500) / 200);
          }

          let panelEloMean = 1500;
          let panelEloStd = 0;
          let panelEloMax = 1500;
          let panelEloMin = 1500;
          if (judgeElos.length > 0) {
            panelEloMean = judgeElos.reduce((a, b) => a + b, 0) / judgeElos.length;
            const variance = judgeElos.reduce((sum, elo) => sum + Math.pow(elo - panelEloMean, 2), 0) / judgeElos.length;
            panelEloStd = Math.sqrt(variance);
            panelEloMax = Math.max(...judgeElos);
            panelEloMin = Math.min(...judgeElos);
          }

          const perCaptionCorpsElo: number[] = [];
          for (const caption of CAPTIONS) {
            const fullCaptionName = fullCaptionNameFor(caption);
            const corpsElo = temporalCaptionFor(v10RowKey(season, targetShow.slug, division, corpsKey), caption)?.corps_elo_before
              ?? corpsPreShowEloCache.get(`${corpsKey}:${season}:${division}:${targetShow.slug}:${fullCaptionName}`)
              ?? 1500;
            perCaptionCorpsElo.push((corpsElo - 1500) / 200);
          }

          // Judge-completeness is a TRAINING-DATA quality filter. Current-season rows
          // (seasons not in the historical SEASONS list) are inference TEMPLATES built
          // pre-panel, so keep them even when the panel is unknown — inference
          // recomputes judge context anyway. Dropping them would strand in-season
          // corps on a synthetic/preseason fallback (the very regression we're fixing).
          if (captionSource !== "clean-v10" && SEASONS.includes(season) && judgeIndices.some((idx) => idx <= 0)) {
            continue;
          }

          const divisionName = targetShow.division_name?.toLowerCase() ?? "";
          const isWorldClass = divisionName.includes("world") ? 1 : 0;
          const isOpenClass = divisionName.includes("open") ? 1 : 0;
          const isAllAgeClass = divisionName.includes("all-age") || divisionName.includes("all age") ? 1 : 0;
          const captionFingerprintFeatures = buildCaptionFingerprintFeatures(
            captionFingerprintHistory,
            corpsKey,
            division,
            season
          );
          const targetRowKey = v10RowKey(season, targetShow.slug, division, corpsKey);
          const fieldPace = temporalFieldPaceMap.get(targetRowKey);
          if (captionSource === "clean-v10" && cliV10FeatureProfile === "field-pace" && !fieldPace) {
            throw new Error(`Missing V10 temporal field-pace feature ${targetRowKey}`);
          }
          const fieldPaceFeatures = fieldPace
            ? [
                fieldPace.field_level_vs_reference / 10,
                fieldPace.shrunk_residual_slope / 10,
                fieldPace.residual_ema / 10,
                fieldPace.confidence,
              ]
            : [];

          const x_static: number[] = [
            normalizeRank(prevRank),
            yearsInWorldClass / 20,
            normalizeRank(meanRank),
            stdRank / 10,
            normalizeRank(bestRank),
            bestRankRecency / 20,
            madeFinalsRate,
            isNew,
            sequenceLength / SEQ_LEN,
            normalizeRank(rankEma),
            residualEmaMean,
            residualSlope,
            residualVolatility,
            rankVsHistorical / 25,
            daysSinceSeasonStart,
            daysSinceLastMatch,
            showsRemainingApprox,
            fieldSize / 25,
            targetOrderInClass,
            targetOrderInClassNorm,
            targetOrderOverall,
            targetOrderOverallNorm,
            topCorpsPresent / FINALS_CUTOFF,
            normalizeRank(divisionStrength),
            isMajorShow,
            ...captionRangeFeatures,
            lastResidualMean,
            ...lastResidualByCaption,
            ...emaResidualByCaption,
            opponentSummary.residualStats.mean,
            opponentSummary.residualStats.median,
            opponentSummary.residualStats.std,
            opponentSummary.residualStats.min,
            opponentSummary.residualStats.max,
            opponentSummary.residualStats.p25,
            opponentSummary.residualStats.p75,
            opponentSummary.weightedResidualMean,
            opponentSummary.rankMean,
            opponentSummary.rankBest,
            ...opponentSummary.topResiduals,
            ...opponentSummary.topRanks,
            normalizeScore(opponentLast3Summary.total.mean),
            normalizeGap(opponentLast3Summary.total.slope),
            normalizeGap(opponentLast3Summary.total.volatility),
            ...opponentLast3Summary.captions.mean.map((value) => normalizeCaptionScore(value)),
            ...opponentLast3Summary.captions.slope.map((value) => normalizeCaptionScore(value)),
            ...opponentLast3Summary.captions.volatility.map((value) => normalizeCaptionScore(value)),
            ...perCaptionJudgeElo,
            (panelEloMean - 1500) / 200,
            panelEloStd / 100,
            (panelEloMax - 1500) / 200,
            (panelEloMin - 1500) / 200,
            ...perCaptionCorpsElo,
            ...rankBaselineFeatures,
            isWorldClass,
            isOpenClass,
            isAllAgeClass,
            // 2026-01-23 New Static (5)
            targetDate.getMonth() / 12,
            targetDate.getDate() / 31,
            premiereDate.getMonth() / 12,
            premiereDate.getDate() / 31,
            pastShows.length / 40.0,
            // Subcaption features (32)
            ...lastContentByCaption,
            ...lastAchievementByCaption,
            ...emaContentByCaption,
            ...emaAchievementByCaption,
            // Cold-start / 2026 opener features (10)
            isSeasonDebutForCorps,
            sameSeasonHistoryCountNorm,
            daysSinceLastSameSeasonShowNorm,
            daysSinceLastScoredAnySeasonNorm,
            lastSeasonFinalScoreNorm,
            lastSeasonFinalRankNorm,
            isFirstScoredEventOfSeason,
            eventWeekIndexNorm,
            targetDayOfSeasonNorm,
            targetShow.percent_through / 100,
            // Caption fingerprint features (33):
            // per caption: prior-season residual, 3-year residual, growth, volatility; then confidence.
            ...captionFingerprintFeatures,
            // Strictly date-prior, division-aware field pace (field-pace profile only).
            ...fieldPaceFeatures,
          ];

          if (x_static.length - captionFingerprintFeatures.length !== BASE_STATIC_FEATURES) {
            throw new Error(
              `Expected ${BASE_STATIC_FEATURES} base static features before caption fingerprints, ` +
              `got ${x_static.length - captionFingerprintFeatures.length}`
            );
          }
          if (
            captionFingerprintFeatures.length !== V9_CAPTION_FINGERPRINT_DIM ||
            x_static[V9_CAPTION_FINGERPRINT_CONFIDENCE_IDX] !== captionFingerprintFeatures.at(-1)
          ) {
            throw new Error(
              `Caption fingerprint block is misaligned: start=${V9_CAPTION_FINGERPRINT_START}, ` +
              `featuresPerCaption=${V9_CAPTION_FINGERPRINT_FEATURES_PER_CAPTION}, ` +
              `got ${captionFingerprintFeatures.length}`
            );
          }
          if (x_static.length !== STATIC_FEATURES) {
            throw new Error(`Expected ${STATIC_FEATURES} static features, got ${x_static.length}`);
          }

          const split = (() => {
            if (season === "2024" && targetShow.slug.toLowerCase().includes("finals")) return "test";
            if (season === "2023") return "val";
            return "train";
          })();

          allInserts.push({
            season,
            competition_slug: targetShow.slug,
            competition_date: targetShow.date,
            division_name: targetShow.division_name,
            corps_key: corpsKey,
            corps_id: CORPS_INDEX_MAP[corpsKey] ?? 0,
            x_sequence_json: JSON.stringify(x_sequence),
            x_static_json: JSON.stringify(x_static),
            judge_indices_json: JSON.stringify(judgeIndices),
            y_residuals_json: JSON.stringify(y_residuals),
            y_recap_json: JSON.stringify(y_recap),
            y_total: targetShow.total_score,
            agnostic_show_id: getAgnosticShowId(targetShow.slug),
            builder_version: builderVersion,
            reference_curves_version: REFERENCE_CURVES.version ?? "unknown",
            map_version: MAP_VERSION,
            split,
            created_at: new Date().toISOString(),
          });
        }
      }

      console.log(`Inserting ${allInserts.length} rows for ${season} ${division}...`);
      const CHUNK_SIZE = 100;
      for (let i = 0; i < allInserts.length; i += CHUNK_SIZE) {
        const chunk = allInserts.slice(i, i + CHUNK_SIZE);
        yield* (insertBatch(sql, targetTable, chunk));
      }
    }
  }
});

const insertBatch = (
  sql: SqlClient.SqlClient,
  targetTable: string,
  rows: any[],
) =>
  Effect.forEach(
    rows,
    (row) =>
      sql.unsafe(`
        INSERT OR REPLACE INTO ${targetTable} (
          season,
          competition_slug,
          competition_date,
          division_name,
          corps_key,
          corps_id,
          x_sequence_json,
          x_static_json,
          judge_indices_json,
          y_residuals_json,
          y_recap_json,
          y_total,
          agnostic_show_id,
          builder_version,
          reference_curves_version,
          map_version,
          split,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        row.season,
        row.competition_slug,
        row.competition_date,
        row.division_name,
        row.corps_key,
        row.corps_id,
        row.x_sequence_json,
        row.x_static_json,
        row.judge_indices_json,
        row.y_residuals_json,
        row.y_recap_json,
        row.y_total,
        row.agnostic_show_id,
        row.builder_version,
        row.reference_curves_version,
        row.map_version,
        row.split,
        row.created_at,
      ]).pipe(Effect.asVoid),
    { concurrency: 50, discard: true }
  );

const dataContract = cliDataContract;
if (dataContract !== "raw-v9" && dataContract !== "clean-v10") {
  throw new Error(`Unsupported --data-contract ${dataContract}`);
}
const dbPath = valueAfter("--db") ?? "./dci-relational.db";
const outputDbPath = valueAfter("--output-db");
const SqlLayer = LibsqlClient.layer({ url: `file:${dbPath}` });

// `--seasons 2026` (comma-separated) restricts the build; INSERT OR REPLACE is an
// upsert keyed by (season, competition_slug, division, corps_key), so a single-season
// run can't disturb other seasons' rows. For a current-season build, buildSequencesV9
// still loads global history (prev-season ranks, corps_historical) so the base features
// are correct; the fingerprint block is recomputed at inference regardless.
const seasonsArgIdx = process.argv.indexOf("--seasons");
const seasonsArg =
  seasonsArgIdx >= 0 && process.argv[seasonsArgIdx + 1]
    ? process.argv[seasonsArgIdx + 1]!.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
if (seasonsArg) console.log(`Building V9 subcaption sequences for seasons: ${seasonsArg.join(", ")}`);

const inferenceEventsArg = valueAfter("--inference-events");
const inferenceEvents = inferenceEventsArg
  ? inferenceEventsArg.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;
// Normalize a bare YYYY-MM-DD to end-of-day: stored dates carry a T00:00:00.000Z
// suffix, so string `date <= "2026-07-10"` would WRONGLY exclude same-day shows
// (they sort AFTER the bare date). End-of-day makes all `date <= asOfDate`
// comparisons (this filter + the SQL elo/aggregate rebuilds) include that day.
const rawAsOf = valueAfter("--as-of");
const asOfArg = rawAsOf && /^\d{4}-\d{2}-\d{2}$/.test(rawAsOf)
  ? `${rawAsOf}T23:59:59.999Z`
  : rawAsOf;
const v10Clean = dataContract === "clean-v10";
const buildOptions: BuildV9SubcaptionOptions = v10Clean
  ? {
      captionSource: "clean-v10",
      targetTable: V10_TARGET_TABLE,
      builderVersion: V10_BUILDER_VERSION,
      outputDbPath,
      inferenceEvents,
      asOfDate: asOfArg,
    }
  : { inferenceEvents, asOfDate: asOfArg };
console.log(
  `Data contract: ${dataContract}; target: ${buildOptions.targetTable ?? V9_TARGET_TABLE}; source DB: ${dbPath}; output DB: ${outputDbPath ?? dbPath}`,
);

Effect.runPromise(buildSequencesV9(seasonsArg ?? SEASONS, buildOptions).pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done building V9 sequences."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
