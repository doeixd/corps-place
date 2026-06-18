import { Effect, pipe } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as MlQueries from "../../src/mlQueries.js";

const testFix = Effect.gen(function* () {
  console.log("Testing VA Caption Fix...");

  const rows = yield* (MlQueries.querySeasonCaptionsV6("2024", "World Class"));

  const vaVariants = ["Visual Analysis", "Visual - Analysis", "4 Visual Ensemble"];
  const vaRows = rows.filter(row => vaVariants.includes(row.caption_name));

  console.log(`Total rows returned: ${rows.length}`);
  console.log(`VA variant rows found: ${vaRows.length}`);

  const counts: Record<string, number> = {};
  vaRows.forEach(row => {
    counts[row.caption_name] = (counts[row.caption_name] || 0) + 1;
  });

  console.log("Breakdown of VA variants found:");
  console.log(JSON.stringify(counts, null, 2));

  if (counts["Visual - Analysis"] > 0) {
    console.log("\nSUCCESS: 'Visual - Analysis' rows are now being correctly returned!");
  } else {
    console.log("\nFAILURE: 'Visual - Analysis' rows are still missing.");
  }
});

const main = () => {
  const client = LibsqlClient.make({
    url: "file:dci-relational.db",
  });

  pipe(
    testFix,
    Effect.provide(client),
    Effect.runPromise
  ).catch(console.error);
};

main();
