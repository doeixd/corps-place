import { Context, Effect, Layer, Ref } from "effect";

export interface DciRequestSupervisor {
  readonly track: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly inFlight: Effect.Effect<number>;
}

export const DciRequestSupervisor = Context.Service<DciRequestSupervisor>("DciRequestSupervisor");

// v4 removed the `Supervisor` module and `Effect.supervised`. The supervisor here
// only ever exposed an in-flight count, so we track that directly with a Ref:
// `track` increments on start and decrements on completion/interrupt (via
// acquireUseRelease so the decrement always runs).
export const makeDciRequestSupervisor = () =>
  Effect.gen(function* () {
    const counter = yield* Ref.make(0);
    const track = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.acquireUseRelease(
        Ref.update(counter, (n) => n + 1),
        () => effect,
        () => Ref.update(counter, (n) => n - 1)
      );
    const inFlight = Ref.get(counter);
    return {
      track,
      inFlight
    };
  });

export const DciRequestSupervisorLayer = Layer.effect(DciRequestSupervisor, makeDciRequestSupervisor());
