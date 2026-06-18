// buildMlRows.ts
// Builds ML training rows from the relational database.
// Enforces as-of semantics to prevent data leakage.

import { Effect, Layer, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import * as MlQueries from "./mlQueries.js";
import fs from "node:fs";
import path from "node:path";

// ----- Reference Curves -----

const REF_CURVES_PATH = path.resolve(process.cwd(), "src/training/referenceCurvesPercent.json");
let referenceCurves: Record<string, number> = {};
try {
  if (fs.existsSync(REF_CURVES_PATH)) {
    referenceCurves = JSON.parse(fs.readFileSync(REF_CURVES_PATH, "utf8"));
  }
} catch (e) {
  console.warn("Could not load reference curves:", e);
}

function getReferenceScore(rank: number, percentThrough: number): number {
  const bucket = Math.floor(percentThrough / 5) * 5;
  const key = `${rank}-${bucket}`;
  return referenceCurves[key] ?? referenceCurves[`${rank}-${bucket - 5}`] ?? referenceCurves[`${rank}-100`] ?? 70;
}

// ----- Types -----

export type BuildMlRowsOptions = {
  seasons?: string[];           // default: all
  divisionName?: string;        // default: World Class (or all)
  featureVersion: string;       // align with features.json
  dbUrl?: string;               // default: file:./dci-relational.db
};

type NumericOrderItem = {
  name: string;
  defaultValue: number;
  missingFlag?: string;
};

type FeatureSpec = {
  version: string;
  numericOrder: NumericOrderItem[];
};

// ----- Schema Setup -----

export const ensureMlTables = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  // Main training rows table
  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_training_rows (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT NOT NULL,
      competition_slug TEXT NOT NULL,
      competition_date TEXT NOT NULL,
      division_name TEXT NOT NULL,
      corps_key TEXT NOT NULL,
      corps_id INTEGER NOT NULL,
      season_id INTEGER NOT NULL,
      division_id INTEGER NOT NULL,
      x_numeric_json TEXT NOT NULL,
      judge_ids_json TEXT,
      y_total REAL NOT NULL,
      y_recap_json TEXT,
      y_residuals_json TEXT,
      pct_through_season REAL,
      split TEXT NOT NULL CHECK(split IN ('train','val','test')),
      sample_weight REAL DEFAULT 1.0,
      feature_version TEXT,
      UNIQUE(season, competition_slug, division_name, corps_key)
    )
  `);

  // Vocab tables
  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_corps_vocab (
      corps_id INTEGER PRIMARY KEY AUTOINCREMENT,
      corps_key TEXT UNIQUE NOT NULL
    )
  `);

  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_season_vocab (
      season_id INTEGER PRIMARY KEY AUTOINCREMENT,
      season TEXT UNIQUE NOT NULL
    )
  `);

  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_division_vocab (
      division_id INTEGER PRIMARY KEY AUTOINCREMENT,
      division_name TEXT UNIQUE NOT NULL
    )
  `);

  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_judge_vocab (
      judge_id_numeric INTEGER PRIMARY KEY AUTOINCREMENT,
      judge_id TEXT UNIQUE NOT NULL
    )
  `);

  // Reserve UNK=0 entries
  yield* (sql`INSERT OR IGNORE INTO ml_corps_vocab (corps_id, corps_key) VALUES (0, '__UNK__')`);
  yield* (sql`INSERT OR IGNORE INTO ml_season_vocab (season_id, season) VALUES (0, '__UNK__')`);
  yield* (sql`INSERT OR IGNORE INTO ml_division_vocab (division_id, division_name) VALUES (0, '__UNK__')`);
  yield* (sql`INSERT OR IGNORE INTO ml_judge_vocab (judge_id_numeric, judge_id) VALUES (0, '__UNK__')`);
});

// ----- Vocab Management -----

const getCorpsId = (corpsKey: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    // Try to get existing
    const existing = yield* (sql<{ id: number }>`
      SELECT corps_id as id FROM ml_corps_vocab WHERE corps_key = ${corpsKey}
    `);

    if (existing.length > 0) {
      return existing[0]!.id;
    }

    // Insert new
    yield* (sql`INSERT OR IGNORE INTO ml_corps_vocab (corps_key) VALUES (${corpsKey})`);

    // Get the id
    const inserted = yield* (sql<{ id: number }>`
      SELECT corps_id as id FROM ml_corps_vocab WHERE corps_key = ${corpsKey}
    `);

    return inserted[0]?.id ?? 0;
  });

const getSeasonId = (season: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    const existing = yield* (sql<{ id: number }>`
      SELECT season_id as id FROM ml_season_vocab WHERE season = ${season}
    `);

    if (existing.length > 0) {
      return existing[0]!.id;
    }

    yield* (sql`INSERT OR IGNORE INTO ml_season_vocab (season) VALUES (${season})`);

    const inserted = yield* (sql<{ id: number }>`
      SELECT season_id as id FROM ml_season_vocab WHERE season = ${season}
    `);

    return inserted[0]?.id ?? 0;
  });

const getDivisionId = (divisionName: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    const existing = yield* (sql<{ id: number }>`
      SELECT division_id as id FROM ml_division_vocab WHERE division_name = ${divisionName}
    `);

    if (existing.length > 0) {
      return existing[0]!.id;
    }

    yield* (sql`INSERT OR IGNORE INTO ml_division_vocab (division_name) VALUES (${divisionName})`);

    const inserted = yield* (sql<{ id: number }>`
      SELECT division_id as id FROM ml_division_vocab WHERE division_name = ${divisionName}
    `);

    return inserted[0]?.id ?? 0;
  });

const getJudgeNumericId = (judgeId: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    const existing = yield* (sql<{ id: number }>`
      SELECT judge_id_numeric as id FROM ml_judge_vocab WHERE judge_id = ${judgeId}
    `);

    if (existing.length > 0) {
      return existing[0]!.id;
    }

    yield* (sql`INSERT OR IGNORE INTO ml_judge_vocab (judge_id) VALUES (${judgeId})`);

    const inserted = yield* (sql<{ id: number }>`
      SELECT judge_id_numeric as id FROM ml_judge_vocab WHERE judge_id = ${judgeId}
    `);

    return inserted[0]?.id ?? 0;
  });

// ----- Split Computation -----

function computeSplit(season: string, competitionSlug: string, corpsKey: string, competitionDate?: string): "train" | "val" | "test" {
  const y = Number(season);

  if (y < 2024) return "train";

  if (y === 2024 && competitionDate) {
    if (competitionDate < "2024-08-01") return "train";
    if (competitionDate < "2024-08-08") return "val";
    return "test"; // Includes finals
  }

  // Fallback for future seasons or missing dates
  if (competitionSlug?.includes("finals")) return "test";
  return y > 2024 ? "test" : "train";
}

// ----- Feature Spec (default) -----

const DEFAULT_FEATURE_SPEC: FeatureSpec = {
  version: "v2.6",
  numericOrder: [
    { name: "percentageThroughSeason", defaultValue: 0 },
    { name: "dayOfSeason", defaultValue: -1 },
    { name: "showOfSeason", defaultValue: 0 },
    { name: "performanceOrderInClass", defaultValue: 0 },
    { name: "corpsCountInClass", defaultValue: 0 },
    { name: "daysSinceLastShow", defaultValue: -1, missingFlag: "hasLastShow" },
    { name: "lastTotalScore", defaultValue: 70, missingFlag: "hasLastShow" },
    { name: "lastGapToLeaderTotal", defaultValue: 0, missingFlag: "hasAnyPriorShow" },
    { name: "avgLast3GapTotal", defaultValue: 0, missingFlag: "hasLast3" },
    { name: "overallRankAsOf", defaultValue: 0, missingFlag: "hasOverallRank" },
    { name: "gapToLeaderOverall", defaultValue: 0, missingFlag: "hasOverallRank" },
    { name: "avgFieldRank", defaultValue: 12 },
    { name: "isFinals", defaultValue: 0 },
    { name: "isRegional", defaultValue: 0 },
    { name: "refScoreAtRankAndPercent", defaultValue: 70 },
    { name: "prevSeasonRankAsOf", defaultValue: 0, missingFlag: "hasPrevSeasonData" },
    { name: "prevSeasonGapToLeader", defaultValue: 0, missingFlag: "hasPrevSeasonData" },
    { name: "gapToSeasonHigh", defaultValue: 0, missingFlag: "hasAnyPriorShow" },
    { name: "lastResidualToBaseline", defaultValue: 0, missingFlag: "hasLastShow" },
    // v2 Caption History (Last show gaps and ranks)
    ...["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"].flatMap(c => [
      { name: `lastGap_${c}`, defaultValue: 0, missingFlag: `hasLast_${c}` },
      { name: `lastRank_${c}`, defaultValue: 0, missingFlag: `hasLast_${c}` },
      { name: `lastScore_${c}`, defaultValue: 0, missingFlag: `hasLast_${c}` },
    ]),
    // v2 Subcaption Context (Last show Content/Achievement ranks)
    { name: "lastContentRank_Perc", defaultValue: 0, missingFlag: "hasLast_MP" },
    { name: "lastAchievementRank_Perc", defaultValue: 0, missingFlag: "hasLast_MP" },

    { name: "hasLastShow", defaultValue: 0 },
    { name: "hasLast3", defaultValue: 0 },
    { name: "hasOverallRank", defaultValue: 0 },
    { name: "hasPrevSeasonData", defaultValue: 0 },
    { name: "hasWeather", defaultValue: 0 },
    { name: "hasJudgeInfo", defaultValue: 0 },
    ...["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"].map(c => ({ name: `hasLast_${c}`, defaultValue: 0 })),
  ],
};

const CAPTION_MAP: Record<string, string> = {
  "General Effect 1": "GE1",
  "General Effect 2": "GE2",
  "Visual Proficiency": "VP",
  "Visual - Analysis": "VA",
  "Color Guard": "CG",
  "Music - Brass": "MB",
  "Music - Analysis": "MA",
  "Music - Percussion": "MP",
};

const TARGET_CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"];

// ----- Numeric Vector Builder -----

export function buildNumericVector(
  spec: FeatureSpec,
  values: Record<string, number | undefined | null>
): number[] {
  // Start with defaults
  const out: Record<string, number> = {};
  for (const item of spec.numericOrder) {
    out[item.name] = item.defaultValue;
  }

  // Apply provided values + missingFlag semantics
  for (const item of spec.numericOrder) {
    const v = values[item.name];
    const isMissing = v === undefined || v === null || Number.isNaN(v);

    if (!isMissing) {
      out[item.name] = Number(v);
      if (item.missingFlag) out[item.missingFlag] = 1;
    } else {
      // Missing: keep default
      if (item.missingFlag) out[item.missingFlag] = 0;
    }
  }

  // Return in order
  return spec.numericOrder.map((item) => out[item.name]!);
}

// ----- Main Build Function -----

export const buildMlRows = (opts: BuildMlRowsOptions) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const featureSpec = DEFAULT_FEATURE_SPEC;

    // Ensure tables exist
    yield* (ensureMlTables);

    // Get competitions to process
    const comps = yield* (MlQueries.queryCompetitionsWithRecaps(opts.seasons, opts.divisionName));

    let totalRows = 0;

    // Process each competition
    for (const comp of comps) {
      // Get corps results for this competition
      const corpsResults = yield* (MlQueries.queryCorpsResults(comp.slug, comp.division_name));

      if (corpsResults.length === 0) continue;

      // Get shared features (computed once per competition)
      const corpsCountInClass = corpsResults.length;
      const pctThrough = comp.percent_through ?? 0;
      const dayOfSeason = comp.day_of_season ?? -1;

      // Get best-so-far for rankings
      const bestSoFar = yield* (MlQueries.queryBestSoFar(comp.season, comp.division_name, comp.competition_date));

      // Get previous season's final rankings for cross-season continuity
      const prevSeason = String(Number(comp.season) - 1);
      const prevSeasonRankings = yield* (MlQueries.queryPreviousSeasonFinalRankings(prevSeason, comp.division_name));

      // Competition Type Keywords
      const lowName = (comp.event_name || "").toLowerCase();
      const isFinals = (lowName.includes("finals") || lowName.includes("championship")) ? 1 : 0;
      const isRegional = lowName.includes("regional") ? 1 : 0;

      // Lineup Strength: Average of best-so-far rankings for all corps present
      let fieldRankSum = 0;
      let fieldCount = 0;
      for (const cr of corpsResults) {
        const corpsRank = MlQueries.computeRankingsAsOf(cr.corps_key, [...bestSoFar]);
        if (corpsRank.hasOverallRank) {
          fieldRankSum += corpsRank.overallRankAsOf!;
          fieldCount++;
        }
      }
      const avgFieldRank = fieldCount > 0 ? fieldRankSum / fieldCount : 12;

      // Get judge panel
      const panel = yield* (MlQueries.queryJudgePanel(comp.slug, comp.division_name));
      const hasJudgeInfo = panel.length > 0;

      // Get judge IDs
      const judgeIds: number[] = [];
      for (const judge of panel) {
        const numericId = yield* (getJudgeNumericId(judge.judge_id));
        judgeIds.push(numericId);
      }

      // Process each corps
      for (let i = 0; i < corpsResults.length; i++) {
        const corps = corpsResults[i]!;

        // Get vocab IDs
        const corpsId = yield* (getCorpsId(corps.corps_key));
        const seasonId = yield* (getSeasonId(comp.season));
        const divisionId = yield* (getDivisionId(corps.division_name));

        // Get prior shows
        const priorShows = yield* (MlQueries.queryPriorShows(
          comp.season,
          comp.division_name,
          corps.corps_key,
          comp.competition_date,
          3
        ));

        // Compute rolling features (copy array to mutable)
        const rolling = MlQueries.computeRollingFeatures([...priorShows]);

        // Compute rankings as-of (copy array to mutable)
        const rankings = MlQueries.computeRankingsAsOf(corps.corps_key, [...bestSoFar]);

        // Compute previous season rank and score for cross-season continuity
        const prevSeasonData = MlQueries.computeRankingsAsOf(corps.corps_key, [...prevSeasonRankings]);
        const prevSeasonCorps = prevSeasonRankings.find(r => r.corps_key === corps.corps_key);

        // Compute show of season (1-indexed)
        const showCountSoFar = yield* (MlQueries.queryShowCountSoFar(
          comp.season,
          corps.corps_key,
          comp.competition_date
        ));
        const showOfSeason = showCountSoFar + 1;

        // Compute days since last show
        let daysSinceLastShow: number | null = null;
        if (priorShows.length > 0) {
          daysSinceLastShow = MlQueries.daysBetween(priorShows[0]!.competition_date, comp.competition_date);
        }

        // Performance order in class (1 = first to perform, based on score order inverse for now)
        const performanceOrderInClass = i + 1;

        // v2 Granular history (from last show)
        const lastRecap = priorShows.length > 0
          ? yield* (MlQueries.queryDetailedCaptions(priorShows[0]!.competition_slug, corps.corps_key))
          : [];
        const lastSubrecap = priorShows.length > 0
          ? yield* (MlQueries.querySubcaptions(priorShows[0]!.competition_slug, corps.corps_key))
          : [];

        // v2 Target Recap (Current show)
        const currentRecap = yield* (MlQueries.queryDetailedCaptions(comp.slug, corps.corps_key));

        const yRecap: Record<string, number> = {};
        const yResiduals: Record<string, number> = {};

        // 1. Initialize targets
        for (const tc of TARGET_CAPTIONS) {
          yRecap[tc] = 0;
          yResiduals[tc] = 0;
        }

        // 2. Fill current recap
        for (const row of currentRecap) {
          const standardName = CAPTION_MAP[row.caption_name];
          if (standardName) yRecap[standardName] = row.score;
        }

        // 3. Compute baselines for residuals
        const lastRecapMap: Record<string, number> = {};
        for (const row of lastRecap) {
          const standardName = CAPTION_MAP[row.caption_name];
          if (standardName) lastRecapMap[standardName] = row.score;
        }

        for (const tc of TARGET_CAPTIONS) {
          if (yRecap[tc] === 0) continue; // Skip if no target data for this caption

          // Baseline = Last Score if available, else Reference Curve (Percent-based)
          let baseline = lastRecapMap[tc] ?? 0;
          if (baseline === 0) {
            baseline = getReferenceScore(rankings.overallRankAsOf || 12, pctThrough) / 5.0;
          }

          yResiduals[tc] = yRecap[tc] - baseline;
        }

        // Build feature values
        const featureValues: Record<string, number | null> = {
          percentageThroughSeason: pctThrough,
          dayOfSeason,
          showOfSeason,
          performanceOrderInClass,
          corpsCountInClass,
          daysSinceLastShow,
          lastTotalScore: priorShows.length > 0 ? priorShows[0]!.total_score : null,
          lastGapToLeaderTotal: rolling.lastGapToLeaderTotal,
          avgLast3GapTotal: rolling.avgLast3GapTotal,
          overallRankAsOf: rankings.overallRankAsOf,
          gapToLeaderOverall: rankings.overallGapToLeader,
          avgFieldRank,
          isFinals,
          isRegional,
          refScoreAtRankAndPercent: getReferenceScore(rankings.overallRankAsOf || 12, pctThrough),
          prevSeasonRankAsOf: prevSeasonData.overallRankAsOf,
          prevSeasonGapToLeader: prevSeasonCorps ? (yield* (MlQueries.queryMaxScoreSoFar(comp.season, comp.competition_date))).score - prevSeasonCorps.best_total : null,
          gapToSeasonHigh: priorShows.length > 0 ? (yield* (MlQueries.queryMaxScoreSoFar(comp.season, comp.competition_date))).score - priorShows[0]!.total_score : null,
          lastResidualToBaseline: priorShows.length > 0 ? priorShows[0]!.total_score - getReferenceScore(priorShows[0]!.rank ?? 12, priorShows[0]!.percent_through ?? 0) : null,
          hasLastShow: priorShows.length > 0 ? 1 : 0,
          hasLast3: rolling.count >= 3 ? 1 : 0,
          hasOverallRank: rankings.overallRankAsOf ? 1 : 0,
          hasPrevSeasonData: prevSeasonData.overallRankAsOf ? 1 : 0,
          hasWeather: 0,
          hasJudgeInfo: hasJudgeInfo ? 1 : 0,
        };

        // Inject v2 caption history
        const lastLeaderRecap = priorShows.length > 0
          ? yield* (MlQueries.queryDetailedCaptions(priorShows[0]!.competition_slug, priorShows[0]!.leader_corps_key))
          : [];
        const lastLeaderRecapMap: Record<string, number> = {};
        for (const row of lastLeaderRecap) {
          const standardName = CAPTION_MAP[row.caption_name];
          if (standardName) lastLeaderRecapMap[standardName] = row.score;
        }

        for (const tc of TARGET_CAPTIONS) {
          const lastScore = lastRecapMap[tc] ?? 0;
          const lastLeaderScore = lastLeaderRecapMap[tc] ?? 0;
          featureValues[`lastGap_${tc}`] = lastScore ? lastLeaderScore - lastScore : null;
          featureValues[`lastRank_${tc}`] = lastRecap.find(r => CAPTION_MAP[r.caption_name] === tc)?.rank ?? null;
          featureValues[`lastScore_${tc}`] = lastScore || null;
          featureValues[`hasLast_${tc}`] = lastScore ? 1 : 0;
        }

        // Inject Percussion sub-metrics (User suggestion)
        const lastMPContent = lastSubrecap.find(s => CAPTION_MAP[s.caption_name] === "MP" && s.subcaption_name === "Content");
        const lastMPAchv = lastSubrecap.find(s => CAPTION_MAP[s.caption_name] === "MP" && s.subcaption_name === "Achievement");
        featureValues["lastContentRank_Perc"] = lastMPContent?.rank ?? null;
        featureValues["lastAchievementRank_Perc"] = lastMPAchv?.rank ?? null;

        const numericVector = buildNumericVector(featureSpec, featureValues);
        // Compute split
        const split = computeSplit(comp.season, comp.slug, corps.corps_key, comp.competition_date);

        // Insert training row
        yield* (sql`
          INSERT INTO ml_training_rows (
            season, competition_slug, competition_date, division_name, corps_key,
            corps_id, season_id, division_id,
            x_numeric_json, judge_ids_json,
            y_total, y_recap_json, y_residuals_json,
            pct_through_season, split, sample_weight, feature_version
          )
          VALUES (
            ${comp.season}, ${comp.slug}, ${comp.competition_date}, ${comp.division_name}, ${corps.corps_key},
            ${corpsId}, ${seasonId}, ${divisionId},
            ${JSON.stringify(numericVector)}, ${judgeIds.length ? JSON.stringify(judgeIds) : null},
            ${corps.total_score}, ${JSON.stringify(yRecap)}, ${JSON.stringify(yResiduals)},
            ${pctThrough}, ${split}, ${1.0}, ${opts.featureVersion}
          )
          ON CONFLICT(season, competition_slug, division_name, corps_key)
          DO UPDATE SET
            x_numeric_json=excluded.x_numeric_json,
            judge_ids_json=excluded.judge_ids_json,
            y_total=excluded.y_total,
            y_recap_json=excluded.y_recap_json,
            y_residuals_json=excluded.y_residuals_json,
            pct_through_season=excluded.pct_through_season,
            split=excluded.split,
            sample_weight=excluded.sample_weight,
            feature_version=excluded.feature_version
        `);

        totalRows++;
      }
    }

    return { totalRows, competitions: comps.length };
  });

// ----- Runnable Effect -----

export const runBuildMlRows = (opts: BuildMlRowsOptions) => {
  const dbUrl = opts.dbUrl ?? "file:./dci-relational.db";
  const SqlLayer = LibsqlClient.layer({ url: dbUrl });
  return buildMlRows(opts).pipe(Effect.provide(SqlLayer));
};

// ----- CLI Entry Point -----

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("buildMlRows.ts");

if (isMain) {
  console.log("Starting buildMlRows...");
  const opts: BuildMlRowsOptions = {
    featureVersion: "v2.0",
  };

  Effect.runPromise(runBuildMlRows(opts))
    .then((result) => {
      console.log(`Built ${result.totalRows} training rows from ${result.competitions} competitions`);
    })
    .catch((err) => {
      console.error("Failed to build ML rows:", err);
      process.exitCode = 1;
    });
}
