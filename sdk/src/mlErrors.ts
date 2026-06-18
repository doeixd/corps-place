// mlErrors.ts
// Typed errors for ML operations using Effect's Tagged pattern.

import { Data } from "effect";

export class ModelLoadError extends Data.TaggedError("ModelLoadError")<{
  readonly modelDir: string;
  readonly reason: string;
  readonly cause?: unknown;
}> { }

export class ModelNotFoundError extends Data.TaggedError("ModelNotFoundError")<{
  readonly modelDir: string;
  readonly expectedFiles: string[];
}> { }

export class PredictionError extends Data.TaggedError("PredictionError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> { }

export class FeatureComputationError extends Data.TaggedError("FeatureComputationError")<{
  readonly competitionSlug: string;
  readonly corpsKey: string;
  readonly reason: string;
  readonly cause?: unknown;
}> { }

export class TrainingDataError extends Data.TaggedError("TrainingDataError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> { }

export class VocabMappingError extends Data.TaggedError("VocabMappingError")<{
  readonly entityType: "corps" | "judge" | "season" | "division";
  readonly entityKey: string;
  readonly reason: string;
}> { }

export class TrainError extends Data.TaggedError("TrainError")<{
  readonly reason: string;
  readonly exitCode?: number;
  readonly cause?: unknown;
}> { }

export class EvalError extends Data.TaggedError("EvalError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> { }

export type MlError =
  | ModelLoadError
  | ModelNotFoundError
  | PredictionError
  | FeatureComputationError
  | TrainingDataError
  | VocabMappingError
  | TrainError
  | EvalError;
