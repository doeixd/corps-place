// test/debugDecodeRecap.ts
import { Effect, Schema, Console } from "effect";
import { makeDciApiLayer } from "../src/client.js";
import * as Domain from "../src/domain.js";
import { DciApi } from "../src/service.js";

const debugFetch = (slug: string) =>
  Effect.gen(function* () {
    const api = yield* (DciApi);
    yield* (Console.log(`\nTesting fetch/decode for recap: ${slug}`));

    const result = yield* (
      api.getCompetitionRecap(slug).pipe(
        Effect.map(() => `✓ Success: ${slug}`),
        Effect.catch((err: any) => {
          if (err._tag === "DciDecodeError") {
            console.error(`✗ Decode Failure for ${slug}:`);
            console.dir(err, { depth: null });
          } else {
            console.error(`✗ Error for ${slug}:`, err);
          }
          return Effect.succeed(`Failed: ${slug}`);
        })
      )
    );
    yield* (Console.log(result));
  });

const program = Effect.gen(function* () {
  yield* (debugFetch("2024-dci-world-championship-finals"));
});

const ApiLayer = makeDciApiLayer();
Effect.runPromise(program.pipe(Effect.provide(ApiLayer))).catch(console.error);
