import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CAPTIONS } from "./featureStoreV5.js";

export { CAPTIONS };

const PRIOR_MEAN = 0;
const PRIOR_VARIANCE = 1;
const DEFAULT_OBSERVATION_VARIANCE = 1;

type Caption = (typeof CAPTIONS)[number];

type BayesianRow = {
  corps_key: string;
  season: string;
  caption: Caption;
  mean_error: number;
  error_variance: number;
  sample_count: number;
};

export type BayesianState = {
  corps_key: string;
  season: string;
  caption: Caption;
  mean_error: number;
  error_variance: number;
  sample_count: number;
};

export type BayesianAdjustment = {
  meanAdjustment: number;
  uncertainty: number;
};

export type QuantilePrediction = {
  p10: number;
  p50: number;
  p90: number;
};

export const ensureBayesianStateTable = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (sql`
    CREATE TABLE IF NOT EXISTS corps_bayesian_adjustments_v5 (
      corps_key TEXT NOT NULL,
      season TEXT NOT NULL,
      caption TEXT NOT NULL,
      mean_error REAL NOT NULL,
      error_variance REAL NOT NULL,
      sample_count INTEGER NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (corps_key, season, caption)
    )
  `);
});

const emptyState = (corps_key: string, season: string, caption: Caption): BayesianState => ({
  corps_key,
  season,
  caption,
  mean_error: PRIOR_MEAN,
  error_variance: PRIOR_VARIANCE,
  sample_count: 0,
});

const updateNormal = (mean: number, variance: number, observation: number, obsVariance: number) => {
  const posteriorVariance = 1 / (1 / variance + 1 / obsVariance);
  const posteriorMean = posteriorVariance * (mean / variance + observation / obsVariance);
  return { mean: posteriorMean, variance: posteriorVariance };
};

export const getBayesianStates = (corps_key: string, season: string) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (
      sql<BayesianRow>`
        SELECT corps_key, season, caption, mean_error, error_variance, sample_count
        FROM corps_bayesian_adjustments_v5
        WHERE corps_key = ${corps_key} AND season = ${season}
      `
    );

    const map = new Map<Caption, BayesianState>();
    for (const row of rows) {
      map.set(row.caption, {
        corps_key: row.corps_key,
        season: row.season,
        caption: row.caption,
        mean_error: row.mean_error,
        error_variance: row.error_variance,
        sample_count: row.sample_count,
      });
    }

    for (const caption of CAPTIONS) {
      if (!map.has(caption)) {
        map.set(caption, emptyState(corps_key, season, caption));
      }
    }

    return map;
  });

export const saveBayesianState = (state: BayesianState) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    yield* (sql`
      INSERT OR REPLACE INTO corps_bayesian_adjustments_v5 (
        corps_key,
        season,
        caption,
        mean_error,
        error_variance,
        sample_count
      ) VALUES (
        ${state.corps_key},
        ${state.season},
        ${state.caption},
        ${state.mean_error},
        ${state.error_variance},
        ${state.sample_count}
      )
    `.pipe(Effect.asVoid));
  });

export const updateBayesianState = (
  state: BayesianState,
  error: number,
  observationVariance = DEFAULT_OBSERVATION_VARIANCE
): BayesianState => {
  const { mean, variance } = updateNormal(state.mean_error, state.error_variance, error, observationVariance);
  return {
    ...state,
    mean_error: mean,
    error_variance: variance,
    sample_count: state.sample_count + 1,
  };
};

export const updateBayesianStatesForShow = (
  corps_key: string,
  season: string,
  errors: Record<Caption, number>,
  observationVariance = DEFAULT_OBSERVATION_VARIANCE
) =>
  Effect.gen(function* () {
    const states = yield* (getBayesianStates(corps_key, season));

    for (const caption of CAPTIONS) {
      const current = states.get(caption) ?? emptyState(corps_key, season, caption);
      const error = errors[caption] ?? 0;
      const updated = updateBayesianState(current, error, observationVariance);
      yield* (saveBayesianState(updated));
    }
  });

export const getAdjustment = (state: BayesianState): BayesianAdjustment => ({
  meanAdjustment: state.mean_error,
  uncertainty: Math.sqrt(state.error_variance),
});

export const applyBayesianAdjustment = (prediction: QuantilePrediction, adjustment: BayesianAdjustment): QuantilePrediction => ({
  p10: prediction.p10 + adjustment.meanAdjustment - adjustment.uncertainty,
  p50: prediction.p50 + adjustment.meanAdjustment,
  p90: prediction.p90 + adjustment.meanAdjustment + adjustment.uncertainty,
});
