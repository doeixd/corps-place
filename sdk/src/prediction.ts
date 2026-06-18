// prediction.ts
// Effect-style prediction service using the loaded ML model.

import { Context, Effect, Layer } from "effect";
import { loadDciModel, type LoadedModel, type PredictInput, type PredictOutput } from "./training/loadModel.js";

export interface PredictEventResult {
  ranked: Array<PredictInput & PredictOutput>;
}

export class PredictService extends Context.Service<
  PredictService,
  {
    predictEvent: (entries: PredictInput[]) => Effect.Effect<PredictEventResult, Error>;
  }
>()("PredictService") { }

function clampQuantiles(o: PredictOutput): PredictOutput {
  // Enforce p10 <= p50 <= p90
  let { p10, p50, p90 } = o;
  if (p10 > p50) [p10, p50] = [p50, p10];
  if (p50 > p90) [p50, p90] = [p90, p50];
  if (p10 > p50) [p10, p50] = [p50, p10];
  return { p10, p50, p90 };
}

export const PredictServiceLayer = (modelDir: string) =>
  Layer.effect(
    PredictService,
    Effect.gen(function* () {
      const loaded: LoadedModel = yield* (Effect.promise(() => loadDciModel(modelDir, { useJudges: true, maxJudges: 16 })));

      return PredictService.of({
        predictEvent: (entries) =>
          Effect.gen(function* () {
            const preds = yield* (Effect.promise(() => loaded.predictBatch(entries)));
            const ranked = entries
              .map((e, i) => ({ ...e, ...clampQuantiles(preds[i]!) }))
              .sort((a, b) => b.p50 - a.p50);
            return { ranked };
          }),
      });
    })
  );
