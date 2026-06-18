import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";

export interface JudgeAssignmentFilters {
  readonly judgeId?: string;
  readonly judgeName?: string;
  readonly corpsKey?: string;
  readonly divisionName?: string;
  readonly groupTypeId?: number;
  readonly competitionTypeId?: number;
  readonly competitionSlug?: string;
  readonly captionName?: string;
  readonly season?: string;
  readonly seasons?: ReadonlyArray<string>;
  readonly after?: Date | string;
  readonly before?: Date | string;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: "recent" | "score" | "season";
}

export interface JudgeAssignmentRow {
  readonly season: string;
  readonly competitionSlug: string;
  readonly eventName: string;
  readonly competitionDate: string;
  readonly location: string | null;
  readonly percentThrough: number | null;
  readonly competitionLevel: number | null;
  readonly corpsKey: string;
  readonly corpsName: string;
  readonly divisionName: string | null;
  readonly groupTypeId: number | null;
  readonly competitionTypeId: number | null;
  readonly corpsRank: number | null;
  readonly corpsTotalScore: number | null;
  readonly captionName: string;
  readonly judgeScore: number | null;
  readonly judgeRank: number | null;
  readonly judgeId: string | null;
  readonly judgeName: string | null;
  readonly recapApiUrl: string | null;
}

const isoDate = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : value;

const buildJudgeWhereClause = (
  sql: SqlClient.SqlClient,
  filters: JudgeAssignmentFilters
) => {
  const predicates: Fragment[] = [];
  if (filters.judgeId) predicates.push(sql`judge_id = ${filters.judgeId}`);
  if (filters.judgeName) predicates.push(sql`judge_name = ${filters.judgeName}`);
  if (filters.corpsKey) predicates.push(sql`corps_key = ${filters.corpsKey}`);
  if (filters.divisionName) predicates.push(sql`division_name = ${filters.divisionName}`);
  if (filters.groupTypeId !== undefined) {
    predicates.push(sql`group_type_id = ${filters.groupTypeId}`);
  }
  if (filters.competitionTypeId !== undefined) {
    predicates.push(sql`competition_type_id = ${filters.competitionTypeId}`);
  }
  if (filters.competitionSlug) {
    predicates.push(sql`competition_slug = ${filters.competitionSlug}`);
  }
  if (filters.captionName) {
    predicates.push(sql`caption_name = ${filters.captionName}`);
  }
  if (filters.season) {
    predicates.push(sql`season = ${filters.season}`);
  } else if (filters.seasons && filters.seasons.length > 0) {
    predicates.push(sql`${sql.in("season", filters.seasons)}`);
  }
  if (filters.after) {
    predicates.push(sql`competition_date >= ${isoDate(filters.after)}`);
  }
  if (filters.before) {
    predicates.push(sql`competition_date <= ${isoDate(filters.before)}`);
  }

  return predicates.length > 0 ? sql`WHERE ${sql.and(predicates)}` : sql``;
};

const resolveOrderClause = (sql: SqlClient.SqlClient, filters: JudgeAssignmentFilters) => {
  switch (filters.orderBy) {
    case "score":
      return sql`ORDER BY judge_score DESC, competition_date DESC`;
    case "season":
      return sql`ORDER BY season DESC, competition_date DESC`;
    case "recent":
    default:
      return sql`ORDER BY competition_date DESC, event_name ASC`;
  }
};

export const listJudgeAssignments = (
  filters: JudgeAssignmentFilters = {}
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const whereClause = buildJudgeWhereClause(sql, filters);
    const orderClause = resolveOrderClause(sql, filters);
    const limitClause =
      typeof filters.limit === "number" ? sql`LIMIT ${filters.limit}` : sql``;
    const offsetClause =
      typeof filters.offset === "number" ? sql`OFFSET ${filters.offset}` : sql``;

    return yield* (
      sql<JudgeAssignmentRow>`
        SELECT
          season,
          competition_slug AS "competitionSlug",
          event_name AS "eventName",
          competition_date AS "competitionDate",
          location,
          percent_through AS "percentThrough",
          competition_level AS "competitionLevel",
          corps_key AS "corpsKey",
          corps_name AS "corpsName",
          division_name AS "divisionName",
          group_type_id AS "groupTypeId",
          competition_type_id AS "competitionTypeId",
          corps_rank AS "corpsRank",
          corps_total_score AS "corpsTotalScore",
          caption_name AS "captionName",
          judge_score AS "judgeScore",
          judge_rank AS "judgeRank",
          judge_id AS "judgeId",
          judge_name AS "judgeName",
          recap_api_url AS "recapApiUrl"
        FROM judge_scores_enriched
        ${whereClause}
        ${orderClause}
        ${limitClause}
        ${offsetClause}
      `
    );
  });

export interface SeasonRankingFilters {
  readonly season: string;
  readonly metric?: string;
  readonly metricPosition?: number;
  readonly corpsKey?: string;
  readonly limit?: number;
  readonly snapshotIndex?: number;
  readonly orderBy?: "metric" | "snapshot" | "score";
}

export interface SeasonRankingEntryRow {
  readonly season: string;
  readonly snapshotIndex: number;
  readonly competitionSlug: string | null;
  readonly competitionDate: string | null;
  readonly metric: string;
  readonly metricPosition: number;
  readonly corpsKey: string | null;
  readonly corpsName: string;
  readonly divisionName: string | null;
  readonly score: number | null;
  readonly entryPercentThrough: number | null;
  readonly dayOfSeason: number | null;
  readonly daysTillFinals: number | null;
  readonly percentThrough: number | null;
  readonly competitionRank: number | null;
}

const buildRankingWhereClause = (
  sql: SqlClient.SqlClient,
  filters: SeasonRankingFilters
) => {
  const predicates: Fragment[] = [sql`season = ${filters.season}`];
  if (filters.metric) {
    predicates.push(sql`metric = ${filters.metric}`);
  }
  if (filters.metricPosition !== undefined) {
    predicates.push(sql`metric_position = ${filters.metricPosition}`);
  }
  if (filters.corpsKey) {
    predicates.push(sql`corps_key = ${filters.corpsKey}`);
  }
  if (filters.snapshotIndex !== undefined) {
    predicates.push(sql`snapshot_index = ${filters.snapshotIndex}`);
  }
  return sql`WHERE ${sql.and(predicates)}`;
};

const resolveRankingOrderClause = (
  sql: SqlClient.SqlClient,
  filters: SeasonRankingFilters
) => {
  switch (filters.orderBy) {
    case "score":
      return sql`ORDER BY score DESC, snapshot_index DESC`;
    case "metric":
      return sql`ORDER BY metric, metric_position`;
    case "snapshot":
    default:
      return sql`ORDER BY snapshot_index DESC, metric_position ASC`;
  }
};

export const listSeasonRankingEntries = (
  filters: SeasonRankingFilters
) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const whereClause = buildRankingWhereClause(sql, filters);
    const orderClause = resolveRankingOrderClause(sql, filters);
    const limitClause =
      typeof filters.limit === "number" ? sql`LIMIT ${filters.limit}` : sql``;

    return yield* (
      sql<SeasonRankingEntryRow>`
        SELECT
          season,
          snapshot_index AS "snapshotIndex",
          competition_slug AS "competitionSlug",
          competition_date AS "competitionDate",
          metric,
          metric_position AS "metricPosition",
          corps_key AS "corpsKey",
          corps_name AS "corpsName",
          division_name AS "divisionName",
          score,
          entry_percent_through AS "entryPercentThrough",
          day_of_season AS "dayOfSeason",
          days_till_finals AS "daysTillFinals",
          percent_through AS "percentThrough",
          competition_rank AS "competitionRank"
        FROM season_ranking_entries_long
        ${whereClause}
        ${orderClause}
        ${limitClause}
      `
    );
  });

export interface AppearancesFilters {
  readonly eventSlug?: string;
  readonly competitionSlug?: string;
  readonly corpsKey?: string;
  readonly divisionName?: string;
  readonly season?: string;
  readonly seasons?: ReadonlyArray<string>;
  readonly groupTypeId?: number | string;
  readonly competitionTypeId?: number | string;
  readonly after?: Date | string;
  readonly before?: Date | string;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: "lineup" | "event" | "score" | "season";
}

export interface AppearancesRow {
  readonly eventSlug: string;
  readonly eventId: string | null;
  readonly eventName: string;
  readonly eventStartDate: string | null;
  readonly eventStartTime: string | null;
  readonly eventEdtStartTime: string | null;
  readonly locationCity: string | null;
  readonly locationState: string | null;
  readonly venueCity: string | null;
  readonly venueState: string | null;
  readonly timezone: string | null;
  readonly competitionSlug: string | null;
  readonly competitionEventName: string | null;
  readonly competitionDate: string | null;
  readonly season: string | null;
  readonly competitionLevel: number | null;
  readonly scoresReleased: number | null;
  readonly recapReleased: number | null;
  readonly categoryRecapReleased: number | null;
  readonly recapId: string | null;
  readonly lineupId: string;
  readonly performanceTime: string | null;
  readonly lineupUnitName: string;
  readonly lineupDisplayCity: string | null;
  readonly participantId: string | null;
  readonly participantSlug: string | null;
  readonly participantName: string | null;
  readonly corpsKey: string | null;
  readonly corpsName: string | null;
  readonly corpsSlug: string | null;
  readonly groupName: string;
  readonly divisionName: string | null;
  readonly round: string | null;
  readonly rank: number | null;
  readonly totalScore: number | null;
  readonly subtotalScore: number | null;
  readonly subtotalRank: number | null;
  readonly groupTypeId: number | string | null;
  readonly groupTypeName: string | null;
  readonly competitionTypeId: number | string | null;
  readonly competitionTypeName: string | null;
  readonly performanceOrderOverall: number | null;
  readonly performanceOrderInClass: number | null;
  readonly numberOfPerformersInClass: number | null;
}

const buildAppearancesWhereClause = (
  sql: SqlClient.SqlClient,
  filters: AppearancesFilters
) => {
  const predicates: Fragment[] = [];
  if (filters.eventSlug) {
    predicates.push(sql`event_slug = ${filters.eventSlug}`);
  }
  if (filters.competitionSlug) {
    predicates.push(sql`competition_slug = ${filters.competitionSlug}`);
  }
  if (filters.corpsKey) {
    predicates.push(sql`corps_key = ${filters.corpsKey}`);
  }
  if (filters.divisionName) {
    predicates.push(sql`division_name = ${filters.divisionName}`);
  }
  if (filters.season) {
    predicates.push(sql`season = ${filters.season}`);
  } else if (filters.seasons && filters.seasons.length > 0) {
    predicates.push(sql`${sql.in("season", filters.seasons)}`);
  }
  if (filters.groupTypeId !== undefined) {
    predicates.push(sql`group_type_id = ${filters.groupTypeId}`);
  }
  if (filters.competitionTypeId !== undefined) {
    predicates.push(sql`competition_type_id = ${filters.competitionTypeId}`);
  }
  if (filters.after) {
    predicates.push(sql`event_start_date >= ${isoDate(filters.after)}`);
  }
  if (filters.before) {
    predicates.push(sql`event_start_date <= ${isoDate(filters.before)}`);
  }

  return predicates.length > 0 ? sql`WHERE ${sql.and(predicates)}` : sql``;
};

const resolveAppearancesOrderClause = (
  sql: SqlClient.SqlClient,
  filters: AppearancesFilters
) => {
  switch (filters.orderBy) {
    case "score":
      return sql`ORDER BY total_score DESC, event_start_date DESC, performance_order_overall ASC`;
    case "season":
      return sql`ORDER BY season DESC, event_start_date DESC, performance_order_overall ASC`;
    case "lineup":
      return sql`ORDER BY event_start_date ASC, performance_order_overall ASC`;
    case "event":
    default:
      return sql`ORDER BY event_start_date DESC, event_name ASC, performance_order_overall ASC`;
  }
};

export const listAppearances = (filters: AppearancesFilters = {}) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const whereClause = buildAppearancesWhereClause(sql, filters);
    const orderClause = resolveAppearancesOrderClause(sql, filters);
    const limitClause =
      typeof filters.limit === "number" ? sql`LIMIT ${filters.limit}` : sql``;
    const offsetClause =
      typeof filters.offset === "number" ? sql`OFFSET ${filters.offset}` : sql``;

    return yield* (
      sql<AppearancesRow>`
        SELECT
          event_slug AS "eventSlug",
          event_id AS "eventId",
          event_name AS "eventName",
          event_start_date AS "eventStartDate",
          event_start_time AS "eventStartTime",
          event_edt_start_time AS "eventEdtStartTime",
          location_city AS "locationCity",
          location_state AS "locationState",
          venue_city AS "venueCity",
          venue_state AS "venueState",
          timezone,
          competition_slug AS "competitionSlug",
          competition_event_name AS "competitionEventName",
          competition_date AS "competitionDate",
          season,
          competition_level AS "competitionLevel",
          scores_released AS "scoresReleased",
          recap_released AS "recapReleased",
          category_recap_released AS "categoryRecapReleased",
          recap_id AS "recapId",
          lineup_id AS "lineupId",
          performance_time AS "performanceTime",
          lineup_unit_name AS "lineupUnitName",
          lineup_display_city AS "lineupDisplayCity",
          participant_id AS "participantId",
          participant_slug AS "participantSlug",
          participant_name AS "participantName",
          corps_key AS "corpsKey",
          corps_name AS "corpsName",
          corps_slug AS "corpsSlug",
          group_name AS "groupName",
          division_name AS "divisionName",
          round,
          rank,
          total_score AS "totalScore",
          subtotal_score AS "subtotalScore",
          subtotal_rank AS "subtotalRank",
          group_type_id AS "groupTypeId",
          group_type_name AS "groupTypeName",
          competition_type_id AS "competitionTypeId",
          competition_type_name AS "competitionTypeName",
          performance_order_overall AS "performanceOrderOverall",
          performance_order_in_class AS "performanceOrderInClass",
          number_of_performers_in_class AS "numberOfPerformersInClass"
        FROM appearances
        ${whereClause}
        ${orderClause}
        ${limitClause}
        ${offsetClause}
      `
    );
  });
