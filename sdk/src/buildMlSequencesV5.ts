import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import * as MlQueries from "./mlQueries.js";
import * as fs from "node:fs";

const REFERENCE_CURVES = JSON.parse(fs.readFileSync("./src/training/referenceCurvesV4.json", "utf-8"));

export const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

type Caption = (typeof CAPTIONS)[number];

const CAPTION_MAP: Record<string, string> = {
  "General Effect 1": "GE1",
  "General Effect 2": "GE2",
  "Visual Proficiency": "VP",
  "Visual Analysis": "VA",
  "Color Guard": "CG",
  "Music - Brass": "MB",
  "Music - Analysis": "MA",
  "Music - Percussion": "MP",
};

const SEASONS = ["2013", "2014", "2015", "2016", "2017", "2018", "2019", "2022", "2023", "2024"];
const DIVISION = "World Class";
const SEQ_LEN = 15;
const FINALS_CUTOFF = 12;

const CAPTION_COUNT = CAPTIONS.length;
const CAPTION_FEATURES = 4;
const OPPONENT_TIMESTEP_FEATURES = 7;
const TIMESTEP_FEATURES = 7 + 7 + CAPTION_COUNT * CAPTION_FEATURES + OPPONENT_TIMESTEP_FEATURES + 4;
const STATIC_FEATURES = 53;

const EMA_ALPHA = 0.3;

const normalizeRank = (rank: number) => rank / 25;
const normalizeScore = (score: number) => (score - 75) / 25;
const normalizeCaptionScore = (score: number) => score / 20;
const normalizeGap = (gap: number) => gap / 25;
const normalizeDays = (days: number) => Math.min(days, 120) / 120;

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

type OpponentSnapshot = {
  residualMean: number;
  rank: number;
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

export const ensureSequenceTablesV5 = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  yield* (sql`
    CREATE TABLE IF NOT EXISTS ml_sequence_rows_v5 (
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

export const buildSequencesV5 = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (ensureSequenceTablesV5);

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
      FROM corps_historical_features_v5
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

  const prevSeasonRanks: Record<string, Record<string, number>> = {};
  for (const season of SEASONS) {
    let prevYear = parseInt(season, 10) - 1;
    if (season === "2022") prevYear = 2019;

    const raw = yield* (MlQueries.queryPreviousSeasonFinalRankings(prevYear.toString(), DIVISION));
    const sortedRaw = [...raw].sort((a, b) => b.best_total - a.best_total);
    prevSeasonRanks[season] = {};
    sortedRaw.forEach((row, idx) => {
      prevSeasonRanks[season]![row.corps_key] = idx + 1;
    });
  }

  for (const season of SEASONS) {
    console.log(`Processing season ${season}...`);
    const rows = yield* (MlQueries.querySeasonCaptionsV5(season, DIVISION));

    const corpsMap = new Map<string, any[]>();
    const competitionMap = new Map<string, CompetitionContext>();

    for (const row of rows) {
      if (!corpsMap.has(row.corps_key)) corpsMap.set(row.corps_key, []);
      const shows = corpsMap.get(row.corps_key)!;

      let lastShow = shows[shows.length - 1];
      if (!lastShow || lastShow.slug !== row.slug) {
        lastShow = {
          slug: row.slug,
          date: row.date,
          event_name: row.event_name,
          percent_through: row.percent_through,
          rank: row.rank,
          total_score: row.total_score,
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

    const opponentHistoryMap = new Map<string, Array<{ date: string; residualMean: number; rank: number }>>();

    for (const [corpsKey, shows] of corpsMap.entries()) {
      const prevRank = prevSeasonRanks[season]?.[corpsKey] ?? 15;
      shows.sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

      const history: Array<{ date: string; residualMean: number; rank: number }> = [];
      for (let i = 0; i < shows.length; i++) {
        const show = shows[i];
        const rankEntering = i > 0 ? shows[i - 1].rank : prevRank;
        let residualSum = 0;
        for (const caption of CAPTIONS) {
          const score = show.captions[caption]?.score ?? 0;
          const baseline = getBaseline(rankEntering, show.percent_through, caption);
          residualSum += score - baseline;
        }
        history.push({
          date: show.date,
          residualMean: residualSum / CAPTIONS.length,
          rank: show.rank ?? rankEntering,
        });
      }

      opponentHistoryMap.set(corpsKey, history);
    }

    const allInserts: any[] = [];

    for (const [corpsKey, shows] of corpsMap.entries()) {
      const prevRank = prevSeasonRanks[season]?.[corpsKey] ?? 15;

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
          const rankEntering = showIdx > 0 ? pastShows[showIdx - 1].rank : prevRank;
          const competition = competitionMap.get(show.slug);
          const fieldSize = competition?.field_size ?? 25;
          const leaderScore = competition?.leader_score ?? show.total_score;
          const scoreByRank = competition?.score_by_rank ?? new Map<number, number>();
          const gapToLeader = leaderScore - show.total_score;
          const gapToNext = show.rank > 1 ? (scoreByRank.get(show.rank - 1) ?? leaderScore) - show.total_score : 0;
          const percentile = fieldSize > 1 ? 1 - (show.rank - 1) / (fieldSize - 1) : 1;
          const totalScoreDelta = prevShow ? show.total_score - prevShow.total_score : 0;

          const feats: number[] = [];

          // Temporal
          feats.push(show.percent_through / 100);
          const daysSince = prevShow ? Math.min(MlQueries.daysBetween(prevShow.date, show.date), 14) / 14 : 0.5;
          feats.push(daysSince);
          feats.push((showIdx + 1) / SEQ_LEN);
          feats.push(0);
          feats.push(normalizeDays(MlQueries.daysBetween(seasonStartDate, show.date)));
          feats.push((showIdx + 1) / pastCount);
          feats.push((pastCount - (showIdx + 1)) / pastCount);

          // Performance Context
          const rankDelta = prevShow ? show.rank - prevShow.rank : 0;
          feats.push(normalizeScore(show.total_score));
          feats.push(normalizeRank(show.rank));
          feats.push(rankDelta / 25);
          feats.push(normalizeGap(gapToLeader));
          feats.push(normalizeGap(gapToNext));
          feats.push(percentile);
          feats.push(normalizeGap(totalScoreDelta));

          // Per-caption features
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

          // Opponent time-series context (past only)
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

          // Show context
          const slug = show.slug.toLowerCase();
          const isFinals = slug.includes("finals") ? 1 : 0;
          const isSemis = slug.includes("semi") ? 1 : 0;
          const isRegional = slug.includes("regional") ? 1 : 0;
          const showDate = new Date(show.date);
          const isEarlySeason = showDate.getMonth() < 6 ? 1 : 0;
          feats.push(isFinals, isSemis, isRegional, isEarlySeason);

          x_sequence.push(feats);
        }


        const rankEntering = pastShows.length > 0 ? pastShows[pastShows.length - 1].rank : prevRank;
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
        const lastShow = pastShows[pastShows.length - 1];
        const currentRank = lastShow?.rank ?? prevRank;

        const rankEma = (() => {
          let ema = currentRank;
          pastShows.forEach((show, idx) => {
            if (idx === 0) {
              ema = show.rank;
            } else {
              ema = EMA_ALPHA * show.rank + (1 - EMA_ALPHA) * ema;
            }
          });
          return ema;
        })();

        const captionResidualSeries: Record<Caption, number[]> = {} as Record<Caption, number[]>;
        for (const caption of CAPTIONS) {
          captionResidualSeries[caption] = [];
        }

        const meanResidualSeries: number[] = [];
        pastShows.forEach((show, idx) => {
          const rankEnter = idx > 0 ? pastShows[idx - 1].rank : prevRank;
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
        const firstShowDate = pastShows[0]?.date ?? targetShow.date;
        const daysSinceSeasonStart = normalizeDays(MlQueries.daysBetween(firstShowDate, targetShow.date));
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
          showsRemainingApprox,
          fieldSize / 25,
          topCorpsPresent / FINALS_CUTOFF,
          normalizeRank(divisionStrength),
          isMajorShow,
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
        ];

        if (x_static.length !== STATIC_FEATURES) {
          throw new Error(`Expected ${STATIC_FEATURES} static features, got ${x_static.length}`);
        }

        let split = "train";
        if (season === "2024") split = "test";
        else if (season === "2023" || season === "2022") split = "val";

        allInserts.push({
          season,
          competition_slug: targetShow.slug,
          competition_date: targetShow.date,
          division_name: DIVISION,
          corps_key: corpsKey,
          corps_id: 0,
          x_sequence_json: JSON.stringify(x_sequence),
          x_static_json: JSON.stringify(x_static),
          y_residuals_json: JSON.stringify(y_residuals),
          y_recap_json: JSON.stringify(y_recap),
          split,
        });
      }
    }

    console.log(`Inserting ${allInserts.length} rows for ${season}...`);
    const CHUNK_SIZE = 100;
    for (let i = 0; i < allInserts.length; i += CHUNK_SIZE) {
      const chunk = allInserts.slice(i, i + CHUNK_SIZE);
      yield* (insertBatch(sql, chunk));
    }
  }
});

const insertBatch = (sql: SqlClient.SqlClient, rows: any[]) =>
  Effect.forEach(
    rows,
    (row) =>
      sql`
        INSERT OR REPLACE INTO ml_sequence_rows_v5 (
          season,
          competition_slug,
          competition_date,
          division_name,
          corps_key,
          corps_id,
          x_sequence_json,
          x_static_json,
          y_residuals_json,
          y_recap_json,
          split
        ) VALUES (
          ${row.season},
          ${row.competition_slug},
          ${row.competition_date},
          ${row.division_name},
          ${row.corps_key},
          ${row.corps_id},
          ${row.x_sequence_json},
          ${row.x_static_json},
          ${row.y_residuals_json},
          ${row.y_recap_json},
          ${row.split}
        )
      `.pipe(Effect.asVoid),
    { concurrency: 50, discard: true }
  );

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(buildSequencesV5.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done building V5 sequences."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
