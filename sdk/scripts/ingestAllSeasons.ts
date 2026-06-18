// scripts/ingestAllSeasons.ts
// Ingest all historical DCI seasons into the relational database.
// Usage: npx tsx scripts/ingestAllSeasons.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { makeDciApiLayer } from "../src/client.js";
import { ingestRelationalData } from "../src/relational.js";

const SEASONS = [
  "2013", "2014", "2015", "2016", "2017", "2018", "2019",
  "2020", "2021", "2022", "2023", "2024"
];

const main = Effect.gen(function* () {
  console.log(`Starting ingestion for ${SEASONS.length} seasons: ${SEASONS.join(", ")}`);
  console.log("This may take a while...\n");

  const result = yield* (ingestRelationalData({
    seasons: SEASONS,
    warm: true,
    seasonConcurrency: 1,
    competitionConcurrency: 2,
    scoreConcurrency: 4,
    persistRankings: true,
  }));

  console.log("\n=== Ingestion Complete ===");
  console.log(`Seasons: ${result.seasons}`);
  console.log(`Competitions: ${result.competitions}`);
  console.log(`Recaps: ${result.recaps}`);
  console.log(`Corps Scores: ${result.corpsScores}`);
  console.log(`Judge Scores: ${result.judgeScores}`);
  console.log(`Subcaption Scores: ${result.subcaptionScores}`);
});

// Set up layers
const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });
const ApiLayer = makeDciApiLayer();

const program = main.pipe(
  Effect.provide(SqlLayer),
  Effect.provide(ApiLayer)
);

Effect.runPromise(program)
  .then(() => {
    console.log("\nDone!");
  })
  .catch((err) => {
    console.error("Ingestion failed:", err);
    process.exitCode = 1;
  });
