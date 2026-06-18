import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { makeDciApiLayer } from "../src/client.js";
import { ingestRelationalData } from "../src/relational.js";

const test2024 = Effect.gen(function* () {
  console.log("Starting ingestion for 2024...");
  const result = yield* (ingestRelationalData({
    seasons: ["2024"],
    warm: false,
    seasonConcurrency: 1,
    competitionConcurrency: 1,
    scoreConcurrency: 1,
  }));
  console.log("Result:", result);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
const ApiLayer = makeDciApiLayer();

const program = test2024.pipe(
  Effect.provide(SqlLayer),
  Effect.provide(ApiLayer)
);

Effect.runPromise(program).catch(console.error);
