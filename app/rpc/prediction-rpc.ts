import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { Effect, Schema } from 'effect';
import { EventPredictionService, type EventPredictionRequest } from '@/lib/event-prediction-api';

const GetPredictionInput = Schema.Struct({
  slug: Schema.String.check(Schema.isMinLength(1)),
  force: Schema.optional(Schema.Boolean),
  refresh: Schema.optional(Schema.Boolean),
  modelDir: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  division: Schema.optional(Schema.String),
  percentThrough: Schema.optional(Schema.String),
});

export const PredictionRpc = RpcGroup.make(
  Rpc.make('getOrCreatePrediction', {
    payload: GetPredictionInput,
    success: Schema.Any, // complex payload shape from service
    error: Schema.Struct({
      _tag: Schema.String,
      message: Schema.String,
      status: Schema.optional(Schema.Number),
    }),
  })
);

export const PredictionRpcLive = PredictionRpc.toLayer({
  getOrCreatePrediction: Effect.fn('PredictionRpc.getOrCreatePrediction')(function* (input) {
    const svc = yield* EventPredictionService;
    const result = yield* svc.getOrCreate2026EventPrediction(input as EventPredictionRequest);
    return result;
  }),
});

export type PredictionRpc = typeof PredictionRpc;
