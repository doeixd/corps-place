import { createServerFn } from '@tanstack/react-start/client';
import { Effect, Schema, SchemaParser } from 'effect';
import {
  EventPredictionService,
  EventPredictionServiceLive,
  errorStatus,
  type EventPredictionRequest,
} from '../event-prediction-api';

const GetPredictionInput = Schema.Struct({
  slug: Schema.String.check(Schema.isMinLength(1)),
  force: Schema.optional(Schema.Boolean),
  refresh: Schema.optional(Schema.Boolean),
  modelDir: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  division: Schema.optional(Schema.String),
  percentThrough: Schema.optional(Schema.String),
});

export const getEventPrediction = createServerFn({ method: 'GET' })
  .validator(SchemaParser.decodeUnknownSync(GetPredictionInput))
  .handler(async ({ data }) => {
    const request: EventPredictionRequest = {
      slug: data.slug,
      force: data.force,
      refresh: data.refresh,
      modelDir: data.modelDir,
      mode: data.mode,
      division: data.division,
      percentThrough: data.percentThrough,
    };

    const program = Effect.flatMap(EventPredictionService, (s) =>
      s.getOrCreate2026EventPrediction(request)
    ).pipe(Effect.provide(EventPredictionServiceLive));

    try {
      return await Effect.runPromise(program);
    } catch (error: any) {
      const status = errorStatus(error);
      throw new Error(error.message, { cause: { status, details: error.details } });
    }
  });
