import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import * as MlQueries from "./mlQueries.js";
import * as fs from "node:fs";
import { createProxy, noSpecialChars, ignoreCase } from '@doeixd/make-with'

const REFERENCE_CURVES = JSON.parse(fs.readFileSync("./src/training/referenceCurvesV4.json", "utf-8"));
const JUDGE_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync("./src/training/judgeIndexMap.json", "utf-8"));
const CORPS_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync("./src/training/corpsIndexMap.json", "utf-8"));
const SHOW_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync("./src/training/showIndexMap.json", "utf-8"));

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


const SEASONS = ["2013", "2014", "2015", "2016", "2017", "2018", "2019", "2022", "2023", "2024"];
const DIVISIONS = ["World Class", "Open Class"];

const SEQ_LEN = 15;
const FINALS_CUTOFF = 12;

const CAPTION_COUNT = CAPTIONS.length;
const CAPTION_FEATURES = 4;
const OPPONENT_TIMESTEP_FEATURES = 7 + 27; // 7 (existing) + 27 (opponent last-3 totals + per-caption stats)
const COMPARATIVE_FEATURES = 10; // relative_total + relative_caption×8 + show_competitiveness
const TIMESTEP_FEATURES = 7 + 11 + CAPTION_COUNT * CAPTION_FEATURES + OPPONENT_TIMESTEP_FEATURES + 4 + COMPARATIVE_FEATURES + 3; // 98 + 3 = 101
const STATIC_FEATURES = 53 + 12 + 8 + 3 + 4 + 27 + 16 + 8 + 1 + 5; // V7 static + rank baselines + daysSinceLastMatch + 5 new static = 137

const EMA_ALPHA = 0.3;

const normalizeRank = (rank: number) => rank / 25;
const normalizeScore = (score: number) => (score - 70) / 30;
const normalizeCaptionScore = (score: number) => score / 20;
const normalizeGap = (gap: number) => gap / 25;
const normalizeDays = (days: number) => Math.min(days, 120) / 120;
const normalizeRecentGap = (days: number) => Math.min(days, 14) / 14;

const getBaseline = (rank: number, pct: number, caption: string): number => {
  if (rank < 1) rank = 12;
  const bucket = Math.round(pct / 5) * 5;
  const key = `${rank}-${bucket}`;
  const curves = REFERENCE_CURVES.curves;

  if (curves[key] && curves[key][caption]) {
    return curves[key][caption];
  }

  return curves[`${rank}-50`]?.[caption] || 15.0;
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

type CompetitionContext = {
  field_size: number;
  leader_score: number;
  score_by_rank: Map<number, number>;
  corps_present: string[];
};

export const buildSequencesV9 = (seasons: string[] = SEASONS) => Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_sequence_rows_v9 (
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
      split TEXT NOT NULL CHECK(split IN ('train','val','test')),
      created_at TEXT NOT NULL,
      UNIQUE(season, competition_slug, division_name, corps_key)
    )
  `);

  const historicalRows = yield* (
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
  for (const row of historicalRows) {
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

  const seasonRowsMap = new Map<string, ReadonlyArray<any>>();
  const captionRangeMap = new Map<string, { min: number; max: number }>();
  const seasonDivisionKey = (season: string, division: string) => `${season}__${division}`;

  for (const season of seasons) {
    for (const division of DIVISIONS) {
      const seasonRows = yield* (MlQueries.querySeasonCaptionsV6(season, division));
      seasonRowsMap.set(seasonDivisionKey(season, division), seasonRows);

      for (const row of seasonRows) {
        const capKey = CAPTION_MAP[row.caption_name];
        if (!capKey) continue;

        // SKIP INVALID SCORES to prevent history poisoning
        if (row.total_score <= 0) continue;

        const bucket = bucketPercent(row.percent_through ?? 0);
        const rangeKey = `${bucket}_${capKey}`;
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

  const getCaptionRange = (percentThrough: number, caption: string) => {
    const bucket = bucketPercent(percentThrough);
    const range = captionRangeMap.get(`${bucket}_${caption}`);
    return {
      min: range?.min ?? 0,
      max: range?.max ?? 20,
    };
  };

  const prevSeasonRanks: Record<string, Record<string, Record<string, number>>> = {};
  for (const season of seasons) {
    let prevYear = parseInt(season, 10) - 1;
    if (season === "2022") prevYear = 2019;

    prevSeasonRanks[season] = {};
    for (const division of DIVISIONS) {
      const raw = yield* (MlQueries.queryPreviousSeasonFinalRankings(prevYear.toString(), division));
      const sortedRaw = [...raw].sort((a, b) => b.best_total - a.best_total);
      prevSeasonRanks[season]![division] = {};
      sortedRaw.forEach((row, idx) => {
        prevSeasonRanks[season]![division]![row.corps_key] = idx + 1;
      });
    }
  }

  console.log("Loading show aggregates...");
  const showAggregatesRows = yield* (sql<{
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

  console.log("Loading judge Elo ratings...");
  const judgeEloMap = new Map<string, Map<string, number>>();
  for (const season of seasons) {
    const judgeElos = yield* (sql<{
      caption_name: string;
      avg_elo: number;
    }>`SELECT caption_name, AVG(elo_rating) as avg_elo FROM judge_elo_ratings WHERE season = ${season} GROUP BY caption_name`);

    const captionEloMap = new Map<string, number>();
    for (const row of judgeElos) {
      captionEloMap.set(row.caption_name, row.avg_elo);
    }
    judgeEloMap.set(season, captionEloMap);
  }
  console.log(`Loaded judge Elo for ${judgeEloMap.size} seasons`);

  console.log("Loading corps Elo ratings...");
  const corpsEloMap = new Map<string, Map<string, Map<string, number>>>();
  for (const season of seasons) {
    const corpsElos = yield* (sql<{
      corps_key: string;
      caption_name: string;
      elo_rating: number;
    }>`SELECT corps_key, caption_name, elo_rating FROM corps_elo_ratings WHERE season = ${season}`);

    if (!corpsEloMap.has(season)) {
      corpsEloMap.set(season, new Map());
    }
    const seasonMap = corpsEloMap.get(season)!;

    for (const row of corpsElos) {
      if (!seasonMap.has(row.corps_key)) {
        seasonMap.set(row.corps_key, new Map());
      }
      seasonMap.get(row.corps_key)!.set(row.caption_name, row.elo_rating);
    }
  }
  console.log(`Loaded corps Elo for ${corpsEloMap.size} seasons`);

  console.log("Pre-caching all judge Elo ratings...");
  const allJudgeElos = yield* (sql<{
    judge_id: string;
    season: string;
    caption_name: string;
    elo_rating: number;
  }>`SELECT judge_id, season, caption_name, elo_rating FROM judge_elo_ratings`);

  const judgeEloCache = new Map<string, number>();
  for (const row of allJudgeElos) {
    const key = `${row.judge_id}:${row.season}:${row.caption_name}`;
    judgeEloCache.set(key, row.elo_rating);
  }
  console.log(`Cached ${judgeEloCache.size} judge Elo entries.`);

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

      const defaultRank = Math.max(1, corpsMap.size);

      for (const shows of corpsMap.values()) {
        shows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
      }

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
          prevRank: prevSeasonRanks[season]?.[division]?.[corpsKey] ?? defaultRank,
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

      for (const [corpsKey, shows] of corpsMap.entries()) {
        const prevRank = prevSeasonRanks[season]?.[division]?.[corpsKey] ?? defaultRank;
        shows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

        const history: OpponentHistoryEntry[] = [];
        for (let i = 0; i < shows.length; i++) {
          const show = shows[i];
          const rankEntering = getOverallRank(show.date, corpsKey, prevRank);
          let residualSum = 0;
          const captionScores = CAPTIONS.map((caption) => {
            const score = show.captions[caption]?.score ?? 0;
            const baseline = getBaseline(rankEntering, show.percent_through, caption);
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

        const prevRank = prevSeasonRanks[season]?.[division]?.[corpsKey] ?? defaultRank;

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
                const baseline = getBaseline(rankEntering, show.percent_through, caption);
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

            const showAgg = showAggregatesMap.get(show.slug);
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
              const baseline = getBaseline(rankEntering, targetShow.percent_through, caption);
              y_residuals[caption] = Number((actual - baseline).toFixed(4));
            } else {
              y_recap[caption] = 0;
              y_residuals[caption] = 0;
            }
          }

          const historical = historicalMap.get(corpsKey);
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

          const meanResidualSeries: number[] = [];
          pastShows.forEach((show) => {
            const rankEnter = getOverallRank(show.date, corpsKey, prevRank);
            let residualSum = 0;
            for (const caption of CAPTIONS) {
              const score = show.captions[caption]?.score ?? 0;
              const baseline = getBaseline(rankEnter, show.percent_through, caption);
              const residual = score - baseline;
              residualSum += residual;
              captionResidualSeries[caption]!.push(residual);
            }
            meanResidualSeries.push(residualSum / CAPTIONS.length);
          });

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

          const rankVsHistorical = currentRank - meanRank;
          const targetDate = new Date(targetShow.date);
          const premiereDate = new Date(pastShows[0]?.date ?? targetShow.date);
          const daysSinceSeasonStart = normalizeDays(MlQueries.daysBetween(pastShows[0]?.date ?? targetShow.date, targetShow.date));
          const lastHistoryDate = pastShows[pastShows.length - 1]?.date;
          const daysSinceLastMatch = lastHistoryDate
            ? normalizeRecentGap(MlQueries.daysBetween(lastHistoryDate, targetShow.date))
            : 0.5;
          const showsRemainingApprox = Math.max(0, SEQ_LEN - (pastShows.length + 1)) / SEQ_LEN;

          const competition = competitionMap.get(targetShow.slug);
          const fieldSize = competition?.field_size ?? 25;
          const topCorpsPresent = competition?.corps_present.filter((corps) => {
            const h = historicalMap.get(corps);
            return h ? h.historical_best_rank <= 5 : false;
          }).length ?? 0;
          const divisionStrength = competition?.corps_present.length
            ? competition.corps_present
              .map((corps) => historicalMap.get(corps)?.historical_mean_rank ?? 15)
              .reduce((sum, value) => sum + value, 0) / competition.corps_present.length
            : 15;
          const isMajorShow = targetShow.slug.toLowerCase().includes("finals") ||
            targetShow.slug.toLowerCase().includes("regional") ? 1 : 0;
          const captionRangeFeatures = CAPTIONS.flatMap((caption) => {
            const range = getCaptionRange(targetShow.percent_through, caption);
            return [normalizeCaptionScore(range.min), normalizeCaptionScore(range.max)];
          });

          const rankBaselineFeatures = CAPTIONS.map((caption) =>
            normalizeCaptionScore(getBaseline(rankEntering, targetShow.percent_through, caption))
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

          const judgeAssignments = yield* (sql<{
            judge_id: string;
            caption_name: string;
          }>`SELECT judge_id, caption_name FROM judge_assignments WHERE competition_slug = ${targetShow.slug}`);

          const captionJudgeEloMap = new Map<string, number[]>();
          for (const assignment of judgeAssignments) {
            const judgeId = assignment.judge_id;
            const captionName = assignment.caption_name;

            const eloKey = `${judgeId}:${season}:${captionName}`;
            const elo = judgeEloCache.get(eloKey) ?? 1500;
            judgeElos.push(elo);

            if (!captionJudgeEloMap.has(captionName)) {
              captionJudgeEloMap.set(captionName, []);
            }
            captionJudgeEloMap.get(captionName)!.push(elo);

            const capKey = CAPTION_MAP[captionName] as Caption | undefined;
            if (capKey) {
              const slotIdx = (CAPTIONS as readonly string[]).indexOf(capKey);
              if (slotIdx !== -1) {
                judgeIndices[slotIdx] = JUDGE_INDEX_MAP[judgeId] ?? 0;
              }
            }
          }

          for (const caption of CAPTIONS) {
            const fullCaptionName = Object.keys(CAPTION_MAP).find(k => CAPTION_MAP[k] === caption) ?? caption;
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
          const seasonCorpsElo = corpsEloMap.get(season)?.get(corpsKey) ?? new Map();
          for (const caption of CAPTIONS) {
            const fullCaptionName = Object.keys(CAPTION_MAP).find(k => CAPTION_MAP[k] === caption) ?? caption;
            const corpsElo = seasonCorpsElo.get(fullCaptionName) ?? 1500;
            perCaptionCorpsElo.push((corpsElo - 1500) / 200);
          }

          const divisionName = targetShow.division_name?.toLowerCase() ?? "";
          const isWorldClass = divisionName.includes("world") ? 1 : 0;
          const isOpenClass = divisionName.includes("open") ? 1 : 0;
          const isAllAgeClass = divisionName.includes("all-age") || divisionName.includes("all age") ? 1 : 0;

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
          ];

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
            split,
            created_at: new Date().toISOString(),
          });
        }
      }

      console.log(`Inserting ${allInserts.length} rows for ${season} ${division}...`);
      const CHUNK_SIZE = 100;
      for (let i = 0; i < allInserts.length; i += CHUNK_SIZE) {
        const chunk = allInserts.slice(i, i + CHUNK_SIZE);
        yield* (insertBatch(sql, chunk));
      }
    }
  }
});

const insertBatch = (sql: SqlClient.SqlClient, rows: any[]) =>
  Effect.forEach(
    rows,
    (row) =>
      sql`
        INSERT OR REPLACE INTO ml_sequence_rows_v9 (
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
          split,
          created_at
        ) VALUES (
          ${row.season},
          ${row.competition_slug},
          ${row.competition_date},
          ${row.division_name},
          ${row.corps_key},
          ${row.corps_id},
          ${row.x_sequence_json},
          ${row.x_static_json},
          ${row.judge_indices_json},
          ${row.y_residuals_json},
          ${row.y_recap_json},
          ${row.y_total},
          ${row.agnostic_show_id},
          ${row.split},
          ${row.created_at}
        )
      `.pipe(Effect.asVoid),
    { concurrency: 50, discard: true }
  );

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(buildSequencesV9().pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done building V9 sequences."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
