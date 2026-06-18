// scripts/ensureV7Schema.ts
// Utility to ensure V7 relational database schema is created.
// Usage: npx tsx scripts/ensureV7Schema.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { ensureRelationalSchema } from "../src/relational.js";

const main = Effect.gen(function* () {
  console.log("Ensuring V7 relational schema...");
  yield* (ensureRelationalSchema);
  console.log("V7 Schema ensured successfully.");
});

// Set up layer
const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

const program = main.pipe(
  Effect.provide(SqlLayer)
);

Effect.runPromise(program)
  .then(() => {
    console.log("Done!");
  })
  .catch((err) => {
    console.error("Failed to ensure V7 schema:", err);
    process.exitCode = 1;
  });
