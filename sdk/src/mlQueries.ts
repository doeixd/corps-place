// mlQueries.ts
// SQL query helpers for ML feature computation.
// All queries enforce as-of semantics to prevent data leakage.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// ----- Types -----

export interface PriorShowRow {
  competition_slug: string;
  competition_date: string;
  total_score: number;
  rank: number | null;
  leader_corps_key: string;
  leader_score: number;
  day_of_season: number;
  percent_through: number;
  latitude: number | null;
  longitude: number | null;
}

export interface CaptionData {
  caption_name: string;
  score: number;
  rank: number;
  judge_id?: string;
}

export interface SubcaptionData {
  caption_name: string;
  subcaption_name: string;
  score: number;
  rank: number;
}

export interface BestSoFarRow {
  corps_key: string;
  best_total: number;
}

export interface WeatherRow {
  temperature_f: number | null;
  humidity_pct: number | null;
  wind_speed_mps: number | null;
  precipitation_mm: number | null;
}

export interface JudgePanelRow {
  judge_id: string;
  judge_name: string;
  caption_name: string;
}

export interface CompetitionMetaRow {
  season: string;
  slug: string;
  competition_date: string;
  day_of_season: number | null;
  days_till_finals: number | null;
  percent_through: number | null;
  event_name: string;
}

export interface CorpsResultRow {
  corps_key: string;
  corps_name: string;
  division_name: string;
  total_score: number;
  rank: number | null;
}

// ----- Query Functions -----

/**
 * Get the last N shows for a corps in a season BEFORE the target date.
 * Returns in descending order (most recent first).
 */
export const queryPriorShows = (
  season: string,
  divisionName: string,
  corpsKey: string,
  beforeDate: string,
  limit: number = 3
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<PriorShowRow>`
        SELECT 
          ccr.competition_slug,
          ccr.competition_date,
          ccr.total_score,
          ccr.corps_rank as rank,
          (SELECT corps_key FROM corps_competition_results WHERE competition_slug = ccr.competition_slug AND corps_rank = 1 LIMIT 1) as leader_corps_key,
          (SELECT total_score FROM corps_competition_results WHERE competition_slug = ccr.competition_slug AND corps_rank = 1 LIMIT 1) as leader_score,
          ccr.day_of_season,
          ccr.percent_through,
          NULL as latitude,
          NULL as longitude
        FROM corps_competition_results ccr
        WHERE ccr.season = ${season}
          AND ccr.division_name = ${divisionName}
          AND ccr.corps_key = ${corpsKey}
          AND ccr.competition_date < ${beforeDate}
        ORDER BY ccr.competition_date DESC
        LIMIT ${limit}
      `
    );
    return rows;
  });

/**
 * Get the highest score achieved by ANY corps in a season BEFORE the target date.
 */
export const queryMaxScoreSoFar = (
  season: string,
  beforeDate: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<{ score: number }>`
        SELECT MAX(total_score) as score
        FROM corps_competition_results
        WHERE season = ${season}
          AND competition_date < ${beforeDate}
      `
    );
    return rows[0] || { score: 0 };
  });

/**
 * Get best score so far for all corps in division BEFORE target date.
 * Use for computing overall rankings as-of.
 */
export const queryBestSoFar = (
  season: string,
  divisionName: string,
  beforeDate: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<BestSoFarRow>`
        SELECT 
          ccr.corps_key,
          MAX(ccr.total_score) AS best_total
        FROM corps_competition_results ccr
        WHERE ccr.season = ${season}
          AND ccr.division_name = ${divisionName}
          AND ccr.competition_date < ${beforeDate}
        GROUP BY ccr.corps_key
        ORDER BY best_total DESC
      `
    );
    return rows;
  });

/**
 * Get final rankings from a previous season.
 * Used for cross-season continuity - provides priors for early-season predictions.
 */
export const queryPreviousSeasonFinalRankings = (
  previousSeason: string,
  divisionName: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<BestSoFarRow>`
        SELECT 
          corps_key,
          MAX(total_score) AS best_total
        FROM corps_competition_results
        WHERE season = ${previousSeason}
          AND division_name = ${divisionName}
        GROUP BY corps_key
        ORDER BY best_total DESC
      `
    );
    return rows;
  });

/**
 * Get corps count in class for a specific competition/division.
 */
export const queryCorpsCountInClass = (
  competitionSlug: string,
  divisionName: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM corps_scores
        WHERE competition_slug = ${competitionSlug}
          AND division_name = ${divisionName}
      `
    );
    return rows[0]?.count ?? 0;
  });

/**
 * Get judge panel for a competition/division.
 */
export const queryJudgePanel = (
  competitionSlug: string,
  divisionName: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<JudgePanelRow>`
        SELECT DISTINCT 
          js.judge_id,
          j.display_name as judge_name,
          js.caption_name
        FROM judge_scores js
        LEFT JOIN judges j ON j.judge_id = js.judge_id
        WHERE js.competition_slug = ${competitionSlug}
          AND EXISTS (
            SELECT 1 FROM corps_scores cs 
            WHERE cs.competition_slug = js.competition_slug 
              AND cs.corps_key = js.corps_key 
              AND cs.division_name = ${divisionName}
          )
      `
    );
    return rows;
  });

/**
 * Get all corps results for a specific competition/division.
 */
export const queryCorpsResults = (
  competitionSlug: string,
  divisionName: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<CorpsResultRow>`
        SELECT 
          corps_key,
          corps_name,
          division_name,
          total_score,
          rank
        FROM corps_scores
        WHERE competition_slug = ${competitionSlug}
          AND division_name = ${divisionName}
        ORDER BY total_score DESC
      `
    );
    return rows;
  });

/**
 * Get all competitions with recap data for specified seasons.
 */
export const queryCompetitionsWithRecaps = (
  seasons?: string[],
  divisionName?: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    // Build query - we need to handle the optional filters
    const baseQuery = sql<CompetitionMetaRow & { division_name: string }>`
      SELECT DISTINCT
        c.season,
        c.slug,
        c.date as competition_date,
        c.event_name,
        c.day_of_season,
        c.days_till_finals,
        c.percent_through,
        cs.division_name
      FROM competitions c
      JOIN corps_scores cs ON cs.competition_slug = c.slug
      WHERE c.recap_released = 1
      ORDER BY c.season, c.date
    `;

    let rows = yield* (baseQuery);

    // Filter in memory if needed (Effect SQL doesn't support dynamic WHERE well)
    if (seasons && seasons.length > 0) {
      const seasonSet = new Set(seasons);
      rows = rows.filter(r => seasonSet.has(r.season));
    }
    if (divisionName) {
      rows = rows.filter(r => r.division_name === divisionName);
    }

    return rows;
  });

/**
 * Get show count for a corps in a season before a date.
 */
export const queryShowCountSoFar = (
  season: string,
  corpsKey: string,
  beforeDate: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM corps_competition_results ccr
        WHERE ccr.season = ${season}
          AND ccr.corps_key = ${corpsKey}
          AND ccr.competition_date < ${beforeDate}
      `
    );
    return rows[0]?.count ?? 0;
  });



/**
 * Get caption breakdown for a specific corps at a competition.
 */
export const queryCaptionsForCompetition = (
  competitionSlug: string,
  corpsKey: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<CaptionData>`
        SELECT 
          caption_name,
          score,
          rank
        FROM caption_scores
        WHERE competition_slug = ${competitionSlug}
          AND corps_key = ${corpsKey}
      `
    );
    return rows;
  });

/**
 * Get detailed judge-level caption scores for a corps show.
 */
export const queryDetailedCaptions = (
  competitionSlug: string,
  corpsKey: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<CaptionData>`
        SELECT 
          caption_name,
          score,
          rank,
          judge_id
        FROM judge_scores
        WHERE competition_slug = ${competitionSlug}
          AND corps_key = ${corpsKey}
      `
    );
    return rows;
  });

/**
 * Get subcaption breakdown for a corps show.
 */
export const querySubcaptions = (
  competitionSlug: string,
  corpsKey: string
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<SubcaptionData>`
        SELECT 
          caption_name,
          subcaption_name,
          score,
          rank
        FROM subcaption_scores
        WHERE competition_slug = ${competitionSlug}
          AND corps_key = ${corpsKey}
      `
    );
    return rows;
  });

// ----- Feature Computation Helpers -----

/**
 * Compute rolling features from prior shows.
 */
export function computeRollingFeatures(priorShows: PriorShowRow[]): {
  hasLastShow: boolean;
  hasLast3: boolean;
  count: number;
  lastScoreTotal: number | null;
  lastGapToLeaderTotal: number | null;
  avgLast3Total: number | null;
  avgLast3GapTotal: number | null;
  slopeLast3Total: number | null;
  daysSinceLastShow: number | null;
} {
  const hasLastShow = priorShows.length >= 1;
  const hasLast3 = priorShows.length >= 3;
  const count = priorShows.length;

  let lastScoreTotal: number | null = null;
  let lastGapToLeaderTotal: number | null = null;
  let avgLast3Total: number | null = null;
  let avgLast3GapTotal: number | null = null;
  let slopeLast3Total: number | null = null;
  let daysSinceLastShow: number | null = null;

  if (hasLastShow) {
    lastScoreTotal = priorShows[0]!.total_score;
    lastGapToLeaderTotal = priorShows[0]!.leader_score - priorShows[0]!.total_score;
  }

  if (hasLast3) {
    const last3 = priorShows.slice(0, 3);
    avgLast3Total = last3.reduce((sum, s) => sum + s.total_score, 0) / 3;
    avgLast3GapTotal = last3.reduce((sum, s) => sum + (s.leader_score - s.total_score), 0) / 3;

    // Compute slope: linear regression on chronological order
    const chronological = [...last3].reverse();
    const scores = chronological.map((s) => s.total_score);
    slopeLast3Total = computeSlope(scores);
  } else if (priorShows.length > 0) {
    // Fallback for avg if < 3 shows
    avgLast3Total = priorShows.reduce((sum, s) => sum + s.total_score, 0) / priorShows.length;
    avgLast3GapTotal = priorShows.reduce((sum, s) => sum + (s.leader_score - s.total_score), 0) / priorShows.length;
  }

  return {
    hasLastShow,
    hasLast3,
    count,
    lastScoreTotal,
    lastGapToLeaderTotal,
    avgLast3Total,
    avgLast3GapTotal,
    slopeLast3Total,
    daysSinceLastShow,
  };
}

/**
 * Compute overall rank and gap-to-leader from best-so-far data.
 */
export function computeRankingsAsOf(
  corpsKey: string,
  bestSoFar: BestSoFarRow[]
): {
  hasOverallRank: boolean;
  overallRankAsOf: number | null;
  overallGapToLeader: number | null;
} {
  const sorted = [...bestSoFar].sort((a, b) => b.best_total - a.best_total);
  const corpsBest = sorted.find((r) => r.corps_key === corpsKey);

  if (!corpsBest) {
    return {
      hasOverallRank: false,
      overallRankAsOf: null,
      overallGapToLeader: null,
    };
  }

  const rank = sorted.findIndex((r) => r.corps_key === corpsKey) + 1;
  const leaderScore = sorted[0]?.best_total ?? 0;
  const gap = leaderScore - corpsBest.best_total;

  return {
    hasOverallRank: true,
    overallRankAsOf: rank,
    overallGapToLeader: gap,
  };
}

/**
 * Simple linear regression slope for equally-spaced data.
 */
function computeSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;

  // Simple linear regression: y = mx + b
  // x = 0, 1, 2, ...
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

/**
 * Compute days between two ISO date strings.
 */
export function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffMs = d2.getTime() - d1.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}


/**
 * flatten query result for building sequences efficiently
 */
export interface SeasonCaptionRow {
  season: string;
  slug: string;
  date: string;
  percent_through: number;
  corps_key: string;
  rank: number;
  total_score: number;
  caption_name: string;
  score: number;
  caption_rank: number;
  division_name: string;
  event_name: string;
}

export const querySeasonCaptions = (season: string, division: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    return yield* (
      sql<SeasonCaptionRow>`
        SELECT
          c.season,
          c.slug,
          c.date,
          c.percent_through,
          c.event_name,
          cs.corps_key,
          cs.rank,
          cs.total_score,
          caps.caption_name,
          caps.score,
          caps.rank as caption_rank,
          cs.division_name
        FROM competitions c
        JOIN corps_scores cs ON cs.competition_slug = c.slug
        JOIN caption_scores caps ON caps.competition_slug = cs.competition_slug AND caps.corps_key = cs.corps_key
        WHERE c.season = ${season}
          AND cs.division_name = ${division}
          AND c.recap_released = 1
        ORDER BY c.date, c.slug, cs.corps_key
      `
    );
  });

/**
 * Query season captions with proper aggregation from subcaption_scores.
 * Aggregates Level 3 breakdown scores (Rep, Perf, Cont, Achv) to get Level 2 caption scores (GE1, GE2, VP, VA, CG, MB, MA, MP).
 * Averages across multiple judges for the same caption.
 */
export const querySeasonCaptionsV5 = (season: string, division: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    return yield* (
      sql<SeasonCaptionRow>`
        SELECT
          c.season,
          c.slug,
          c.date,
          c.percent_through,
          c.event_name,
          cs.corps_key,
          cs.rank,
          cs.total_score,
          judge_totals.caption_name,
          AVG(judge_totals.judge_score) as score,
          MIN(judge_totals.caption_rank) as caption_rank,
          cs.division_name
        FROM competitions c
        JOIN corps_scores cs ON cs.competition_slug = c.slug
        JOIN (
          SELECT
            sc.competition_slug,
            sc.corps_key,
            ja.caption_name,
            sc.judge_id,
            SUM(sc.score) as judge_score,
            MIN(sc.rank) as caption_rank
          FROM subcaption_scores sc
          JOIN judge_assignments ja ON ja.competition_slug = sc.competition_slug
                                     AND ja.judge_id = sc.judge_id
          GROUP BY sc.competition_slug, sc.corps_key, ja.caption_name, sc.judge_id
        ) AS judge_totals ON judge_totals.competition_slug = cs.competition_slug
                          AND judge_totals.corps_key = cs.corps_key
        WHERE c.season = ${season}
          AND c.slug = cs.competition_slug
          AND cs.division_name IN ('World Class', 'Open Class')
          AND c.recap_released = 1
        GROUP BY c.season, c.slug, c.date, c.percent_through, c.event_name,
                 cs.corps_key, cs.division_name, cs.rank, cs.total_score, judge_totals.caption_name
        ORDER BY c.date, c.slug, cs.corps_key
      `
    );
  });
/**
 * Query season captions using the official caption_scores table.
 * This is more reliable than V5 which manually aggregated from subcaptions.
 * Standardizes caption names to: GE1, GE2, VP, VA, CG, MB, MA, MP.
 */
export const querySeasonCaptionsV6 = (season: string, division: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    return yield* (
      sql<SeasonCaptionRow>`
        SELECT
          c.season,
          c.slug,
          c.date,
          c.percent_through,
          c.event_name,
          cs.corps_key,
          cs.division_name,
          cs.rank,
          cs.total_score,
          caps.caption_name,
          caps.score,
          caps.rank as caption_rank
        FROM competitions c
        JOIN corps_scores cs ON cs.competition_slug = c.slug
        JOIN caption_scores caps ON caps.competition_slug = cs.competition_slug AND caps.corps_key = cs.corps_key
        WHERE c.season = ${season}
          AND cs.division_name = ${division}
          AND c.recap_released = 1
        ORDER BY c.date, c.slug, cs.corps_key
      `
    );
  });

export interface PerformanceOrderRow {
  competition_slug: string;
  corps_key: string;
  division_name: string;
  performance_order_overall: number | null;
  performance_order_in_class: number | null;
  number_of_performers_in_class: number | null;
  number_of_performers_overall: number | null;
}

export const queryPerformanceOrder = (season: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    return yield* (
      sql<PerformanceOrderRow>`
        WITH scored_corps AS (
          SELECT DISTINCT
            cs.competition_slug,
            cs.corps_key,
            cs.division_name,
            e.slug as event_slug,
            e.event_id
          FROM corps_scores cs
          JOIN competitions c ON c.slug = cs.competition_slug
          JOIN events e ON e.slug = c.slug
          WHERE c.season = ${season}
        ),
        lineup_order AS (
          SELECT
            sc.competition_slug,
            sc.corps_key,
            sc.division_name,
            ele.performance_order,
            ROW_NUMBER() OVER (
              PARTITION BY sc.event_slug
              ORDER BY ele.performance_order NULLS LAST, ele.entry_id
            ) as order_overall,
            ROW_NUMBER() OVER (
              PARTITION BY sc.event_slug, sc.division_name
              ORDER BY ele.performance_order NULLS LAST, ele.entry_id
            ) as order_in_class,
            COUNT(*) OVER (
              PARTITION BY sc.event_slug, sc.division_name
            ) as count_in_class,
            COUNT(*) OVER (
              PARTITION BY sc.event_slug
            ) as count_overall
          FROM scored_corps sc
          LEFT JOIN event_lineup_entries ele
            ON ele.event_slug = sc.event_slug
            AND LOWER(REPLACE(REPLACE(ele.unit_name, ' ', ''), '-', '')) =
                LOWER(REPLACE(REPLACE((SELECT name FROM corps WHERE corps_key = sc.corps_key LIMIT 1), ' ', ''), '-', ''))
        ),
        participant_order AS (
          SELECT
            sc.competition_slug,
            sc.corps_key,
            sc.division_name,
            ep.performance_order,
            ROW_NUMBER() OVER (
              PARTITION BY sc.event_slug
              ORDER BY ep.performance_order NULLS LAST, ep.participant_id
            ) as order_overall,
            ROW_NUMBER() OVER (
              PARTITION BY sc.event_slug, sc.division_name
              ORDER BY ep.performance_order NULLS LAST, ep.participant_id
            ) as order_in_class,
            COUNT(*) OVER (
              PARTITION BY sc.event_slug, sc.division_name
            ) as count_in_class,
            COUNT(*) OVER (
              PARTITION BY sc.event_slug
            ) as count_overall
          FROM scored_corps sc
          LEFT JOIN event_participants ep
            ON ep.event_slug = sc.event_slug
            AND ep.corps_key = sc.corps_key
        )
        SELECT
          sc.competition_slug,
          sc.corps_key,
          sc.division_name,
          COALESCE(lo.performance_order, po.performance_order, lo.order_overall, po.order_overall) as performance_order_overall,
          COALESCE(lo.performance_order, po.performance_order, lo.order_in_class, po.order_in_class) as performance_order_in_class,
          COALESCE(lo.count_in_class, po.count_in_class) as number_of_performers_in_class,
          COALESCE(lo.count_overall, po.count_overall) as number_of_performers_overall
        FROM scored_corps sc
        LEFT JOIN lineup_order lo ON lo.competition_slug = sc.competition_slug AND lo.corps_key = sc.corps_key
        LEFT JOIN participant_order po ON po.competition_slug = sc.competition_slug AND po.corps_key = sc.corps_key
      `
    );
  });

// ===== V7 CURRICULUM LEARNING QUERIES =====

export interface JudgeEloRow {
  judge_id: string;
  season: string;
  caption_name: string;
  elo_rating: number;
  confidence: number;
  num_scores: number;
}

export interface CorpsEloRow {
  corps_key: string;
  season: string;
  caption_name: string | null;
  elo_rating: number;
  confidence: number;
  num_shows: number;
}

export interface JudgePanelEloRow {
  judge_id: string;
  caption_name: string;
  elo_rating: number;
  confidence: number;
}

/**
 * Get judge Elo ratings for a specific season and caption.
 * Used for adding judge intelligence features to training sequences.
 */
export const queryJudgeEloRatings = (season: string, captionName?: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    if (captionName) {
      return yield* (
        sql<JudgeEloRow>`
          SELECT judge_id, season, caption_name, elo_rating, confidence, num_scores
          FROM judge_elo_ratings
          WHERE season = ${season} AND caption_name = ${captionName}
        `
      );
    } else {
      return yield* (
        sql<JudgeEloRow>`
          SELECT judge_id, season, caption_name, elo_rating, confidence, num_scores
          FROM judge_elo_ratings
          WHERE season = ${season}
        `
      );
    }
  });

/**
 * Get corps Elo history for trajectory/momentum features.
 * Returns chronological Elo progression across a season.
 */
export const queryCorpsEloHistory = (corpsKey: string, season: string, captionName?: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    if (captionName) {
      return yield* (
        sql<{ competition_slug: string; competition_date: string; elo_before: number; elo_after: number }>`
          SELECT competition_slug, competition_date, elo_before, elo_after
          FROM corps_elo_history
          WHERE corps_key = ${corpsKey}
            AND season = ${season}
            AND caption_name = ${captionName}
          ORDER BY competition_date ASC
        `
      );
    } else {
      return yield* (
        sql<{ competition_slug: string; competition_date: string; caption_name: string; elo_before: number; elo_after: number }>`
          SELECT competition_slug, competition_date, caption_name, elo_before, elo_after
          FROM corps_elo_history
          WHERE corps_key = ${corpsKey}
            AND season = ${season}
          ORDER BY competition_date ASC, caption_name
        `
      );
    }
  });

/**
 * Get judge panel Elo ratings for a specific show.
 * Used to compute judge intelligence features at prediction time.
 */
export const queryJudgePanelElo = (competitionSlug: string, season: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    return yield* (
      sql<JudgePanelEloRow>`
        SELECT
          ja.judge_id,
          ja.caption_name,
          COALESCE(jer.elo_rating, 1500) as elo_rating,
          COALESCE(jer.confidence, 50) as confidence
        FROM judge_assignments ja
        LEFT JOIN judge_elo_ratings jer
          ON jer.judge_id = ja.judge_id
          AND jer.season = ${season}
          AND jer.caption_name = ja.caption_name
        WHERE ja.competition_slug = ${competitionSlug}
        ORDER BY ja.caption_name, ja.judge_id
      `
    );
  });

/**
 * Get corps Elo ratings for a season/caption.
 * Used for adding corps momentum features.
 */
export const queryCorpsEloRatings = (season: string, captionName?: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);

    if (captionName) {
      return yield* (
        sql<CorpsEloRow>`
          SELECT corps_key, season, caption_name, elo_rating, confidence, num_shows
          FROM corps_elo_ratings
          WHERE season = ${season} AND caption_name = ${captionName}
        `
      );
    } else {
      return yield* (
        sql<CorpsEloRow>`
          SELECT corps_key, season, caption_name, elo_rating, confidence, num_shows
          FROM corps_elo_ratings
          WHERE season = ${season}
        `
      );
    }
  });

/**
 * Get all competitions across all seasons in chronological order.
 * Used for building historical ratings (Elo) where processing must be strictly linear.
 */
export const queryAllCompetitionsChronological = () =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    return yield* (
      sql<CompetitionMetaRow>`
        SELECT season, slug, date as competition_date, day_of_season, days_till_finals, percent_through, event_name
        FROM competitions
        ORDER BY date ASC
      `
    );
  });

/**
 * Get all judge scores for a competition.
 * Used for Elo computation.
 */
export const queryJudgeScoresForCompetition = (slug: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    return yield* (
      sql<{
        corps_key: string;
        caption_name: string;
        judge_id: string;
        score: number;
      }>`
        SELECT corps_key, caption_name, judge_id, score
        FROM judge_scores
        WHERE competition_slug = ${slug}
      `
    );
  });
