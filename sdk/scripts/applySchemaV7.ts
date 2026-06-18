// scripts/applySchemaV7.ts
// Apply V7 schema extensions to the database
// Usage: npx tsx scripts/applySchemaV7.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { ensureRelationalSchema } from "../src/relational.js";

const main = Effect.gen(function* () {
  console.log("🔧 Applying V7 schema extensions to database...\n");

  yield* (ensureRelationalSchema);

  console.log("\n✅ Schema applied successfully!");
  console.log("New tables:");
  console.log("  - judge_elo_ratings");
  console.log("  - judge_elo_history");
  console.log("  - corps_elo_ratings");
  console.log("  - corps_elo_history");
  console.log("  - ml_sequence_rows_v7");
  console.log("  - show_aggregates_v7");
});

// Set up SQL layer
const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(
  Effect.provide(SqlLayer)
);

Effect.runPromise(program)
  .then(() => {
    console.log("\nDone!");
  })
  .catch((err) => {
    console.error("Schema application failed:", err);
    process.exitCode = 1;
  });
