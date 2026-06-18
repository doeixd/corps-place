// test/debugDecode.ts
import { Effect, Schema, Console } from "effect";
import { makeDciApiLayer } from "../src/client.js";
import * as Domain from "../src/domain.js";
import { DciApi } from "../src/service.js";

const debugFetch = (path: string) =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    yield* (Console.log(`\nTesting fetch/decode for: ${path}`));

    const result = yield* (
      (path === "/corps" ? api.getCorps() : api.getCompetitions("2024")).pipe(
        Effect.map(() => `✓ Success: ${path}`),
        Effect.catch((err: any) => {
          if (err._tag === "DciDecodeError") {
            console.error(`✗ Decode Failure for ${path}:`);
            // Detailed print of the error
            console.dir(err, { depth: null });
          } else {
            console.error(`✗ Error for ${path}:`, err);
          }
          return Effect.succeed(`Failed: ${path}`);
        })
      )
    );
    yield* (Console.log(result));
  });

const program = Effect.gen(function* () {
  yield* (debugFetch("/corps"));
  yield* (debugFetch("/competitions"));
});

const ApiLayer = makeDciApiLayer();
Effect.runPromise(program.pipe(Effect.provide(ApiLayer))).catch(console.error);
