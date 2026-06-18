import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { makeDciApiLayer } from "../src/client.js";
import { ingestRelationalData } from "../src/relational.js";

const test2223 = Effect.gen(function* () {
  console.log("Starting ingestion for 2022, 2023...");
  const result = yield* (ingestRelationalData({
    seasons: ["2022", "2023"],
    warm: false,
    seasonConcurrency: 1,
    competitionConcurrency: 1,
    scoreConcurrency: 1,
  }));
  console.log("Result:", result);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
const ApiLayer = makeDciApiLayer();

const program = test2223.pipe(
  Effect.provide(SqlLayer),
  Effect.provide(ApiLayer)
);

Effect.runPromise(program).catch(console.error);
