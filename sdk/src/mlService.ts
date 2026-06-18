// mlService.ts
// Effect-style ML service for DCI score prediction.
// Provides a unified API for training data generation, model loading, and prediction.

import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as MlErrors from "./mlErrors.js";
import * as MlQueries from "./mlQueries.js";
import { buildMlRows, ensureMlTables, type BuildMlRowsOptions } from "./buildMlRows.js";
import { applyBayesianAdjustment, getBayesianStates } from "./bayesianAdjustmentV5.js";
import {
  loadDciModel,
  type LoadedModel,
  type LoadDciModelOptions,
  type PredictInput,
  type PredictOutput,
} from "./training/loadModel.js";


// ----- Types -----

export interface BuildTrainingDataOptions extends BuildMlRowsOptions { }

export interface BuildTrainingDataResult {
  totalRows: number;
  competitions: number;
}

export interface TrainOptions {
  db: string;
  out: string;
  featureSpec: string;
  useJudges?: boolean;
  maxJudges?: number;
  epochs?: number;
  batchSize?: number;
  patience?: number;
}

export interface TrainResult {
  modelDir: string;
  metrics: {
    valMae: { maeP10: number; maeP50: number; maeP90: number };
    testMae: { maeP10: number; maeP50: number; maeP90: number };
  };
}

export interface EvaluateOptions {
  db: string;
  modelDir: string;
  split: "train" | "val" | "test";
}

export interface EvaluateResult {
  mae: number;
  bucketMae: Array<{ bucket: string; count: number; mae: number }>;
  top3ExactOrderAccuracy: number;
  top3SetOverlap: number;
}

export interface PredictEventOptions {
  entries: PredictInput[];
  applyBayesian?: boolean;
  bayesianSeason?: string;
}


export interface RankedPrediction extends PredictInput, PredictOutput {
  rank: number;
}

export interface PredictEventResult {
  predictions: RankedPrediction[];
}

// ----- Service Interface -----

export interface MlApi {
  /**
   * Build training rows from the relational database.
   * Processes competitions and computes features with as-of semantics.
   * Requires SqlClient in the Effect context.
   */
  readonly buildTrainingData: (
    opts: BuildTrainingDataOptions
  ) => Effect.Effect<BuildTrainingDataResult, MlErrors.TrainingDataError, SqlClient.SqlClient>;

  /**
   * Ensure ML-specific database tables exist.
   * Requires SqlClient in the Effect context.
   */
  readonly ensureMlSchema: Effect.Effect<void, MlErrors.TrainingDataError, SqlClient.SqlClient>;

  /**
   * Load a trained model from disk.
   */
  readonly loadModel: (
    modelDir: string,
    opts?: LoadDciModelOptions
  ) => Effect.Effect<LoadedModel, MlErrors.ModelLoadError>;

  /**
   * Make predictions for a set of entries.
   */
  readonly predict: (
    model: LoadedModel,
    entries: PredictInput[]
  ) => Effect.Effect<PredictOutput[], MlErrors.PredictionError>;

  /**
   * Predict and rank entries for an event.
   */
  readonly predictEvent: (
    model: LoadedModel,
    opts: PredictEventOptions
  ) => Effect.Effect<PredictEventResult, MlErrors.PredictionError, SqlClient.SqlClient>;


  /**
   * Build features for a single corps at a specific competition.
   * Useful for inference on upcoming shows.
   * Requires SqlClient in the Effect context.
   */
  readonly buildFeaturesForCorps: (
    season: string,
    competitionSlug: string,
    competitionDate: string,
    divisionName: string,
    corpsKey: string
  ) => Effect.Effect<
    Record<string, number | null>,
    MlErrors.FeatureComputationError,
    SqlClient.SqlClient
  >;
}

export const MlApi = Context.Service<MlApi>("MlApi");

// ----- Helpers -----

function clampQuantiles(o: PredictOutput): PredictOutput {
  // Enforce p10 <= p50 <= p90
  let { p10, p50, p90 } = o;
  if (p10 > p50) [p10, p50] = [p50, p10];
  if (p50 > p90) [p50, p90] = [p90, p50];
  if (p10 > p50) [p10, p50] = [p50, p10];
  return { p10, p50, p90 };
}

// ----- Service Implementation -----

export const makeMlApi = Effect.sync((): MlApi => ({
  buildTrainingData: (opts) =>
    buildMlRows(opts).pipe(
      Effect.mapError(
        (cause) =>
          new MlErrors.TrainingDataError({
            reason: "Failed to build training data",
            cause,
          })
      )
    ),

  ensureMlSchema: ensureMlTables.pipe(
    Effect.mapError(
      (cause) =>
        new MlErrors.TrainingDataError({
          reason: "Failed to ensure ML schema",
          cause,
        })
    )
  ),

  loadModel: (modelDir, opts) =>
    Effect.tryPromise({
      try: () => loadDciModel(modelDir, opts),
      catch: (cause) =>
        new MlErrors.ModelLoadError({
          modelDir,
          reason: "Failed to load model",
          cause,
        }),
    }),

  predict: (model, entries) =>
    Effect.tryPromise({
      try: () => model.predictBatch(entries),
      catch: (cause) =>
        new MlErrors.PredictionError({
          reason: "Prediction failed",
          cause,
        }),
    }),

  predictEvent: (model, opts) =>
    Effect.gen(function* () {
      const predictions = yield* (
        Effect.tryPromise({
          try: () => model.predictBatch(opts.entries),
          catch: (cause) =>
            new MlErrors.PredictionError({
              reason: "Prediction failed",
              cause,
            }),
        })
      );

      const adjusted = [] as Array<PredictOutput>;
      if (opts.applyBayesian && opts.bayesianSeason) {
        for (let i = 0; i < opts.entries.length; i++) {
          const entry = opts.entries[i]!;
          const corpsKey = entry.numeric?.corpsKey as string | undefined;
          if (!corpsKey) {
            adjusted.push(clampQuantiles(predictions[i]!));
            continue;
          }

          const states = yield* (
            getBayesianStates(corpsKey, opts.bayesianSeason).pipe(
              Effect.mapError(
                (cause) =>
                  new MlErrors.PredictionError({
                    reason: "Bayesian adjustment lookup failed",
                    cause,
                  })
              )
            )
          );
          const meanAdjustment = Array.from(states.values()).reduce((sum, state) => sum + state.mean_error, 0) / states.size;
          const varianceMean = Array.from(states.values()).reduce((sum, state) => sum + state.error_variance, 0) / states.size;
          const adjustment = { meanAdjustment, uncertainty: Math.sqrt(varianceMean) };
          adjusted.push(clampQuantiles(applyBayesianAdjustment(predictions[i]!, adjustment)));
        }
      } else {
        adjusted.push(...predictions.map((pred) => clampQuantiles(pred)));
      }

      // Combine entries with predictions and sort by p50
      const ranked = opts.entries
        .map((entry, i) => ({
          ...entry,
          ...adjusted[i]!,
          rank: 0,
        }))
        .sort((a, b) => b.p50 - a.p50)
        .map((item, idx) => ({ ...item, rank: idx + 1 }));

      return { predictions: ranked };
    }),


  buildFeaturesForCorps: (
    season,
    competitionSlug,
    competitionDate,
    divisionName,
    corpsKey
  ) =>
    Effect.gen(function* () {
      // Get prior shows
      const priorShows = yield* (
        MlQueries.queryPriorShows(season, divisionName, corpsKey, competitionDate, 3)
      );

      // Compute rolling features (copy to mutable array)
      const rolling = MlQueries.computeRollingFeatures([...priorShows]);

      // Get best-so-far for rankings
      const bestSoFar = yield* (
        MlQueries.queryBestSoFar(season, divisionName, competitionDate)
      );
      const rankings = MlQueries.computeRankingsAsOf(corpsKey, [...bestSoFar]);

      // Get corps count
      const corpsCountInClass = yield* (
        MlQueries.queryCorpsCountInClass(competitionSlug, divisionName)
      );

      // Get show count so far
      const showOfSeason =
        (yield* (MlQueries.queryShowCountSoFar(season, corpsKey, competitionDate))) + 1;

      // Compute days since last show
      let daysSinceLastShow: number | null = null;
      if (priorShows.length > 0) {
        daysSinceLastShow = MlQueries.daysBetween(
          priorShows[0]!.competition_date,
          competitionDate
        );
      }

      // Get judge panel info
      const panel = yield* (MlQueries.queryJudgePanel(competitionSlug, divisionName));
      const hasJudgeInfo = panel.length > 0;

      return {
        showOfSeason,
        corpsCountInClass,
        daysSinceLastShow,
        lastScoreTotal: rolling.lastScoreTotal,
        avgLast3Total: rolling.avgLast3Total,
        slopeLast3Total: rolling.slopeLast3Total,
        overallRankAsOf: rankings.overallRankAsOf,
        gapToLeaderOverall: rankings.overallGapToLeader,

        hasLastShow: rolling.hasLastShow ? 1 : 0,
        hasLast3: rolling.hasLast3 ? 1 : 0,
        hasOverallRank: rankings.hasOverallRank ? 1 : 0,
        hasJudgeInfo: hasJudgeInfo ? 1 : 0,
        // Weather and distance not computed - would need external data
        distanceKmFromLastShow: null,
        temperatureF: null,
        humidityPct: null,
        windSpeedMps: null,
        precipitationMm: null,
        hasWeather: 0,
      } as Record<string, number | null>;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new MlErrors.FeatureComputationError({
            competitionSlug,
            corpsKey,
            reason: "Failed to compute features",
            cause,
          })
      )
    ),
}));

// ----- Layer -----

export const MlApiLive = Layer.effect(MlApi, makeMlApi);
