import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import * as MlQueries from "../src/mlQueries.js";
import * as fs from "node:fs";

const REFERENCE_CURVES = JSON.parse(fs.readFileSync("./src/training/referenceCurvesV4.json", "utf-8"));
const JUDGE_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync("./src/training/judgeIndexMap.json", "utf-8"));
const CORPS_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync("./src/training/corpsIndexMap.json", "utf-8"));
const SHOW_INDEX_MAP: Record<string, number> = JSON.parse(fs.readFileSync("./src/training/showIndexMap.json", "utf-8"));

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

const CAPTION_MAP: Record<string, string> = {
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
};

const SEASONS = ["2013", "2014", "2015", "2016", "2017", "2018", "2019", "2022", "2023", "2024", "2025"];
const DIVISIONS = ["World Class", "Open Class"];

const SEQ_LEN = 15;
const FINALS_CUTOFF = 12;

const CAPTION_COUNT = CAPTIONS.length;
const CAPTION_FEATURES = 4;
const OPPONENT_TIMESTEP_FEATURES = 7 + 27;
const COMPARATIVE_FEATURES = 10;
const TIMESTEP_FEATURES = 7 + 11 + CAPTION_COUNT * CAPTION_FEATURES + OPPONENT_TIMESTEP_FEATURES + 4 + COMPARATIVE_FEATURES + 3;
const STATIC_FEATURES = 53 + 12 + 8 + 3 + 4 + 27 + 16 + 8 + 1 + 5 + 32;

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
    return { mean: 0, median: 0, std: 0, min: 0, max: 0, p25: 0, p75: 0 };
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

export const buildSequencesV9SubcaptionMTL = (seasons: string[] = SEASONS) => Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Setting up v9subcaption_mtl table...");
  yield* (sql`DROP TABLE IF EXISTS ml_sequence_rows_v9subcaption_mtl`);
  yield* (sql`
    CREATE TABLE ml_sequence_rows_v9subcaption_mtl (
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
      y_subcaption_json TEXT NOT NULL,
      y_subbaselines_json TEXT NOT NULL,
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
  }>`SELECT * FROM show_aggregates_v7`);

  const showAggregatesMap = new Map<string, typeof showAggregatesRows[0]>();
  for (const row of showAggregatesRows) {
    showAggregatesMap.set(row.competition_slug, row);
  }

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

  for (const season of seasons) {
    console.log(`Processing season ${season}...`);
    const performanceOrderRows = yield* (MlQueries.queryPerformanceOrder(season));

    const performanceOrderMap = new Map<string, {
      orderOverall: number | null;
      orderInClass: number | null;
      countOverall: number;
      countInClass: number;
    }>();

    for (const row of performanceOrderRows) {
      const key = `${row.competition_slug}_${row.corps_key}`;
      performanceOrderMap.set(key, {
        orderOverall: row.performance_order_overall,
        orderInClass: row.performance_order_in_class,
        countOverall: row.number_of_performers_overall ?? 0,
        countInClass: row.number_of_performers_in_class ?? 0,
      });
    }

    for (const division of DIVISIONS) {
      console.log(`Processing season ${season} ${division}...`);
      const rows = seasonRowsMap.get(seasonDivisionKey(season, division)) ?? [];
      if (rows.length === 0) continue;

      const corpsMap = new Map<string, any[]>();
      const competitionMap = new Map<string, CompetitionContext>();

      for (const row of rows) {
        if (!corpsMap.has(row.corps_key)) corpsMap.set(row.corps_key, []);
        const shows = corpsMap.get(row.corps_key)!;

        let lastShow = shows[shows.length - 1];
        if (!lastShow || lastShow.slug !== row.slug) {
          if (row.total_score <= 0) continue;
          lastShow = {
            slug: row.slug,
            date: row.date,
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
          prevRank: prevSeasonRanks[season]?.[division]?.[corpsKey] ?? Math.max(1, corpsMap.size),
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
        const prevRank = prevSeasonRanks[season]?.[division]?.[corpsKey] ?? Math.max(1, corpsMap.size);
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
        const prevRank = prevSeasonRanks[season]?.[division]?.[corpsKey] ?? Math.max(1, corpsMap.size);

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
            feats.push(prevShow ? Math.min(MlQueries.daysBetween(prevShow.date, show.date), 14) / 14 : 0.5);
            feats.push((showIdx + 1) / SEQ_LEN);
            feats.push(0);
            feats.push(normalizeDays(MlQueries.daysBetween(seasonStartDate, show.date)));
            feats.push((showIdx + 1) / pastCount);
            feats.push((pastCount - (showIdx + 1)) / pastCount);

            const d = new Date(show.date);
            const startOfYear = new Date(d.getFullYear(), 0, 1);
            const dayOfYear = (d.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24);
            const dayRad = (dayOfYear / 366) * 2 * Math.PI;
            feats.push(Math.sin(dayRad), Math.cos(dayRad));
            feats.push((showIdx + 1) / 40.0);

            feats.push(normalizeScore(show.total_score));
            feats.push(normalizeRank(show.rank));
            feats.push((prevShow ? show.rank - prevShow.rank : 0) / 25);
            feats.push(normalizeGap(gapToLeader));
            feats.push(normalizeGap(gapToNext));
            feats.push(percentile);
            feats.push(normalizeGap(totalScoreDelta));

            const orderKey = `${show.slug}_${corpsKey}`;
            const perfOrder = performanceOrderMap.get(orderKey);
            feats.push(perfOrder?.orderInClass ?? -1, perfOrder?.orderInClass != null && perfOrder.countInClass > 0 ? perfOrder.orderInClass / perfOrder.countInClass : -1, perfOrder?.orderOverall ?? -1, perfOrder?.orderOverall != null && perfOrder.countOverall > 0 ? perfOrder.orderOverall / perfOrder.countOverall : -1);

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
                  opponentSnapshots.push({ residualMean: entry.residualMean, rank: entry.rank ?? fieldSize });
                  break;
                }
              }
            }
            const opponentSummary = summarizeOpponents(opponentSnapshots, fieldSize);
            x_sequence.push([...feats, ...[opponentSummary.residualStats.mean, opponentSummary.residualStats.median, opponentSummary.residualStats.std, opponentSummary.residualStats.min, opponentSummary.residualStats.max, opponentSummary.residualStats.p25, opponentSummary.residualStats.p75, opponentSummary.weightedResidualMean, opponentSummary.rankMean, opponentSummary.rankBest, ...opponentSummary.topResiduals, ...opponentSummary.topRanks]]);
          }

          const rankEntering = getOverallRank(targetShow.date, corpsKey, prevRank);
          const y_residuals: Record<string, number> = {};
          const y_recap: Record<string, number> = {};
          const y_subcaption: Record<string, { content: number; achievement: number }> = {};

          // Fetch target subcaptions for the show we are predicting
          const subcaptionRows = yield* (sql<{ caption_name: string; subcaption_name: string; score: number; }>`
            SELECT caption_name, subcaption_name, score FROM subcaption_scores 
            WHERE competition_slug = ${targetShow.slug} AND corps_key = ${corpsKey}
          `);

          const captionSubcatMap = new Map<string, { content: number; achievement: number; count: number }>();
          for (const sub of subcaptionRows) {
            const capKey = CAPTION_MAP[sub.caption_name]; if (!capKey) continue;
            const category = normalizeSubcaptionCategory(sub.subcaption_name); if (category === "Other") continue;
            if (!captionSubcatMap.has(capKey)) captionSubcatMap.set(capKey, { content: 0, achievement: 0, count: 0 });
            const entry = captionSubcatMap.get(capKey)!;
            if (category === "Content") entry.content += sub.score; else if (category === "Achievement") entry.achievement += sub.score;
            entry.count += 1;
          }

          for (const caption of CAPTIONS) {
            const actual = targetShow.captions[caption]?.score;
            if (actual !== undefined) {
              y_recap[caption] = actual;
              y_residuals[caption] = Number((actual - getBaseline(rankEntering, targetShow.percent_through, caption)).toFixed(4));
              const subData = captionSubcatMap.get(caption);
              y_subcaption[caption] = { content: subData?.content ?? 0, achievement: subData?.achievement ?? 0 };
            } else {
              y_recap[caption] = 0; y_residuals[caption] = 0;
              y_subcaption[caption] = { content: 0, achievement: 0 };
            }
          }

          const historical = historicalMap.get(corpsKey);
          const meanRank = historical?.historical_mean_rank ?? 15;
          const currentRank = getOverallRank(targetShow.date, corpsKey, prevRank);
          const rankEma = pastShows.length ? pastShows.reduce((ema, s, idx) => { const r = getOverallRank(s.date, corpsKey, prevRank); return idx === 0 ? r : EMA_ALPHA * r + (1 - EMA_ALPHA) * ema; }, 0) : currentRank;

          const captionResidualSeries: Record<Caption, number[]> = {} as any;
          const captionContentSeries: Record<Caption, number[]> = {} as any;
          const captionAchievementSeries: Record<Caption, number[]> = {} as any;
          CAPTIONS.forEach(c => { captionResidualSeries[c] = []; captionContentSeries[c] = []; captionAchievementSeries[c] = []; });

          const meanResidualSeries: number[] = [];
          for (const show of pastShows) {
            const re = getOverallRank(show.date, corpsKey, prevRank);
            let rs = 0;
            for (const c of CAPTIONS) {
              const s = show.captions[c]?.score ?? 0;
              const res = s - getBaseline(re, show.percent_through, c);
              rs += res; captionResidualSeries[c].push(res);
            }
            meanResidualSeries.push(rs / CAPTION_COUNT);
          }

          for (const pastShow of pastShows) {
            const pastSubs = yield* (sql<{ caption_name: string; subcaption_name: string; score: number }>`SELECT caption_name, subcaption_name, score FROM subcaption_scores WHERE competition_slug = ${pastShow.slug} AND corps_key = ${corpsKey}`);
            const tempMap = new Map<string, { c: number, a: number, cnt: number }>();
            for (const sub of pastSubs) {
              const ck = CAPTION_MAP[sub.caption_name]; if (!ck) continue;
              const cat = normalizeSubcaptionCategory(sub.subcaption_name); if (cat === "Other") continue;
              if (!tempMap.has(ck)) tempMap.set(ck, { c: 0, a: 0, cnt: 0 });
              const e = tempMap.get(ck)!; if (cat === "Content") e.c += sub.score; else if (cat === "Achievement") e.a += sub.score; e.cnt++;
            }
            CAPTIONS.forEach(c => { const d = tempMap.get(c); captionContentSeries[c].push(d?.c ?? 0); captionAchievementSeries[c].push(d?.a ?? 0); });
          }

          const resEma = computeEma(meanResidualSeries, EMA_ALPHA);
          const showAgg = showAggregatesMap.get(targetShow.slug);
          const judgeIndices: number[] = new Array(CAPTION_COUNT).fill(0);
          const judgeAssignments = yield* (sql<{ judge_id: string; caption_name: string; }>`SELECT judge_id, caption_name FROM judge_assignments WHERE competition_slug = ${targetShow.slug}`);
          for (const asgn of judgeAssignments) {
            const capKey = CAPTION_MAP[asgn.caption_name] as Caption;
            if (capKey) { const idx = CAPTIONS.indexOf(capKey); if (idx !== -1) judgeIndices[idx] = JUDGE_INDEX_MAP[asgn.judge_id] ?? 0; }
          }

          const fSize = showAgg?.field_size ?? 25;
          const perfOrder = performanceOrderMap.get(`${targetShow.slug}_${corpsKey}`);

          const x_static = [
            normalizeRank(prevRank),
            (historical?.years_in_world_class ?? 0) / 20,
            normalizeRank(meanRank),
            (historical?.historical_std_rank ?? 0) / 10,
            normalizeRank(historical?.historical_best_rank ?? 15),
            (historical?.best_rank_recency ?? 10) / 20,
            historical?.made_finals_rate ?? 0,
            (historical?.first_season === Number(season) ? 1 : 0),
            pastShows.length / SEQ_LEN,
            normalizeRank(rankEma),
            resEma,
            computeSlope(meanResidualSeries),
            meanResidualSeries.length > 1 ? Math.sqrt(meanResidualSeries.reduce((s, v) => s + (v - resEma) ** 2, 0) / meanResidualSeries.length) : 0,
            (currentRank - meanRank) / 25,
            normalizeDays(MlQueries.daysBetween(pastShows[0]?.date ?? targetShow.date, targetShow.date)),
            pastShows[pastShows.length - 1] ? normalizeRecentGap(MlQueries.daysBetween(pastShows[pastShows.length - 1]!.date, targetShow.date)) : 0.5,
            Math.max(0, SEQ_LEN - (pastShows.length + 1)) / SEQ_LEN,
            fSize / 25,
            perfOrder?.orderInClass ?? -1,
            perfOrder?.orderInClass != null && fSize > 0 ? perfOrder.orderInClass / fSize : -1,
            perfOrder?.orderOverall ?? -1,
            perfOrder?.orderOverall != null && fSize > 0 ? perfOrder.orderOverall / fSize : -1,
            (historical?.made_finals_rate ?? 0) > 0.8 ? 1 : 0,
            normalizeRank(showAgg?.avg_total ? (showAgg.avg_total - 70) / 30 : 0.5),
            targetShow.slug.toLowerCase().includes("finals") ? 1 : 0,
            ...judgeIndices.map(j => (j > 0 ? 1 : 0)),
            ...CAPTIONS.map(c => normalizeSubcaptionScore(captionContentSeries[c].slice(-1)[0] ?? 0)),
            ...CAPTIONS.map(c => normalizeSubcaptionScore(captionAchievementSeries[c].slice(-1)[0] ?? 0)),
            ...CAPTIONS.map(c => normalizeSubcaptionScore(computeEma(captionContentSeries[c], EMA_ALPHA))),
            ...CAPTIONS.map(c => normalizeSubcaptionScore(computeEma(captionAchievementSeries[c], EMA_ALPHA)))
          ];

          // Compute subcaption-specific EMA baselines
          const y_subbaselines: Record<string, { content: number; achievement: number }> = {};
          for (const c of CAPTIONS) {
            y_subbaselines[c] = {
              content: computeEma(captionContentSeries[c], EMA_ALPHA),
              achievement: computeEma(captionAchievementSeries[c], EMA_ALPHA)
            };
          }

          allInserts.push({ season, competition_slug: targetShow.slug, competition_date: targetShow.date, division_name: targetShow.division_name, corps_key: corpsKey, corps_id: CORPS_INDEX_MAP[corpsKey] ?? 0, x_sequence_json: JSON.stringify(x_sequence), x_static_json: JSON.stringify(x_static), judge_indices_json: JSON.stringify(judgeIndices), y_residuals_json: JSON.stringify(y_residuals), y_recap_json: JSON.stringify(y_recap), y_subcaption_json: JSON.stringify(y_subcaption), y_subbaselines_json: JSON.stringify(y_subbaselines), y_total: targetShow.total_score, agnostic_show_id: getAgnosticShowId(targetShow.slug), split: (season === "2024" && targetShow.slug.includes("finals")) ? "test" : (season === "2023" ? "val" : "train"), created_at: new Date().toISOString() });
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
        INSERT OR REPLACE INTO ml_sequence_rows_v9subcaption_mtl (
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
          y_subcaption_json,
          y_subbaselines_json,
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
          ${row.y_subcaption_json},
          ${row.y_subbaselines_json},
          ${row.y_total},
          ${row.agnostic_show_id},
          ${row.split},
          ${row.created_at}
        )
      `.pipe(Effect.asVoid),
    { concurrency: 50, discard: true }
  );


const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
Effect.runPromise(buildSequencesV9SubcaptionMTL().pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done building V9Subcaption-MTL sequences."))
  .catch(err => { console.error(err); process.exit(1); });
