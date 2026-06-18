// scripts/reingest2024.ts
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { makeDciApiLayer } from "../src/client.js";
import { ingestRelationalData } from "../src/relational.js";

const SEASONS = ["2024"];

const main = Effect.gen(function* () {
  console.log(`Re-ingesting 2024...`);
  const result = yield* (ingestRelationalData({
    seasons: SEASONS,
    warm: false,
    seasonConcurrency: 1,
    competitionConcurrency: 2,
    scoreConcurrency: 4,
    persistRankings: false,
  }));

  console.log("\nComplete");
  console.log(`Judge Scores: ${result.judgeScores}`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
const ApiLayer = makeDciApiLayer();

const program = main.pipe(
  Effect.provide(SqlLayer),
  Effect.provide(ApiLayer)
);

Effect.runPromise(program).catch(console.error);
