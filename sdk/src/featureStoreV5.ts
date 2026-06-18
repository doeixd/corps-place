import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const EMA_ALPHA = 0.3;

type Caption = (typeof CAPTIONS)[number];

type CaptionRecord = Record<Caption, number>;

export type CorpsSeasonState = {
  corps_key: string;
  season: string;
  shows_completed: number;
  last_show_date: string | null;
  residual_ema: CaptionRecord;
  residual_mean: CaptionRecord;
  residual_var: CaptionRecord;
  best_residual: CaptionRecord;
  worst_residual: CaptionRecord;
  rank_history: number[];
  total_score_history: number[];
};

export type ShowResult = {
  corps_key: string;
  season: string;
  date: string;
  rank: number;
  total_score: number;
  residuals: CaptionRecord;
};

const makeCaptionRecord = (value: number): CaptionRecord => {
  const record = {} as CaptionRecord;
  for (const caption of CAPTIONS) record[caption] = value;
  return record;
};

export const initializeCorpsSeasonState = (corps_key: string, season: string): CorpsSeasonState => ({
  corps_key,
  season,
  shows_completed: 0,
  last_show_date: null,
  residual_ema: makeCaptionRecord(0),
  residual_mean: makeCaptionRecord(0),
  residual_var: makeCaptionRecord(0),
  best_residual: makeCaptionRecord(0),
  worst_residual: makeCaptionRecord(0),
  rank_history: [],
  total_score_history: [],
});

export const ensureCorpsSeasonStateTable = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (sql`
    CREATE TABLE IF NOT EXISTS corps_season_state_v5 (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      corps_key TEXT NOT NULL,
      season TEXT NOT NULL,
      shows_completed INTEGER NOT NULL,
      last_show_date TEXT,
      residual_ema_json TEXT NOT NULL,
      residual_mean_json TEXT NOT NULL,
      residual_var_json TEXT NOT NULL,
      best_residual_json TEXT NOT NULL,
      worst_residual_json TEXT NOT NULL,
      rank_history_json TEXT NOT NULL,
      total_score_history_json TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(corps_key, season)
    )
  `);
});

export const getCorpsSeasonState = (corps_key: string, season: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<{
        corps_key: string;
        season: string;
        shows_completed: number;
        last_show_date: string | null;
        residual_ema_json: string;
        residual_mean_json: string;
        residual_var_json: string;
        best_residual_json: string;
        worst_residual_json: string;
        rank_history_json: string;
        total_score_history_json: string;
      }>`
        SELECT
          corps_key,
          season,
          shows_completed,
          last_show_date,
          residual_ema_json,
          residual_mean_json,
          residual_var_json,
          best_residual_json,
          worst_residual_json,
          rank_history_json,
          total_score_history_json
        FROM corps_season_state_v5
        WHERE corps_key = ${corps_key} AND season = ${season}
      `
    );

    if (!rows.length) return initializeCorpsSeasonState(corps_key, season);

    const row = rows[0]!;
    return {
      corps_key: row.corps_key,
      season: row.season,
      shows_completed: row.shows_completed,
      last_show_date: row.last_show_date,
      residual_ema: JSON.parse(row.residual_ema_json),
      residual_mean: JSON.parse(row.residual_mean_json),
      residual_var: JSON.parse(row.residual_var_json),
      best_residual: JSON.parse(row.best_residual_json),
      worst_residual: JSON.parse(row.worst_residual_json),
      rank_history: JSON.parse(row.rank_history_json),
      total_score_history: JSON.parse(row.total_score_history_json),
    } satisfies CorpsSeasonState;
  });

export const saveCorpsSeasonState = (state: CorpsSeasonState) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    yield* (sql`
      INSERT OR REPLACE INTO corps_season_state_v5 (
        corps_key,
        season,
        shows_completed,
        last_show_date,
        residual_ema_json,
        residual_mean_json,
        residual_var_json,
        best_residual_json,
        worst_residual_json,
        rank_history_json,
        total_score_history_json
      ) VALUES (
        ${state.corps_key},
        ${state.season},
        ${state.shows_completed},
        ${state.last_show_date},
        ${JSON.stringify(state.residual_ema)},
        ${JSON.stringify(state.residual_mean)},
        ${JSON.stringify(state.residual_var)},
        ${JSON.stringify(state.best_residual)},
        ${JSON.stringify(state.worst_residual)},
        ${JSON.stringify(state.rank_history)},
        ${JSON.stringify(state.total_score_history)}
      )
    `.pipe(Effect.asVoid));
  });

export const updateCorpsSeasonState = (state: CorpsSeasonState, show: ShowResult): CorpsSeasonState => {
  const showsCompleted = state.shows_completed + 1;

  const residual_ema: CaptionRecord = { ...state.residual_ema };
  const residual_mean: CaptionRecord = { ...state.residual_mean };
  const residual_var: CaptionRecord = { ...state.residual_var };
  const best_residual: CaptionRecord = { ...state.best_residual };
  const worst_residual: CaptionRecord = { ...state.worst_residual };

  for (const caption of CAPTIONS) {
    const value = show.residuals[caption] ?? 0;

    const prevMean = state.residual_mean[caption];
    const prevVar = state.residual_var[caption];
    const prevCount = state.shows_completed;
    const prevM2 = prevCount > 1 ? prevVar * (prevCount - 1) : 0;

    const delta = value - prevMean;
    const nextMean = prevMean + delta / showsCompleted;
    const delta2 = value - nextMean;
    const nextM2 = prevM2 + delta * delta2;
    const nextVar = showsCompleted > 1 ? nextM2 / (showsCompleted - 1) : 0;

    residual_mean[caption] = nextMean;
    residual_var[caption] = nextVar;

    const prevEma = state.residual_ema[caption];
    residual_ema[caption] = prevCount === 0 ? value : EMA_ALPHA * value + (1 - EMA_ALPHA) * prevEma;

    best_residual[caption] = prevCount === 0 ? value : Math.max(state.best_residual[caption], value);
    worst_residual[caption] = prevCount === 0 ? value : Math.min(state.worst_residual[caption], value);
  }

  return {
    corps_key: show.corps_key,
    season: show.season,
    shows_completed: showsCompleted,
    last_show_date: show.date,
    residual_ema,
    residual_mean,
    residual_var,
    best_residual,
    worst_residual,
    rank_history: [...state.rank_history, show.rank],
    total_score_history: [...state.total_score_history, show.total_score],
  };
};
