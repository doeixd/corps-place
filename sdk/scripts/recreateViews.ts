// Recreate database views
// Usage: npx tsx scripts/recreateViews.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { ensureSchema } from "../src/relational.js";

const main = Effect.gen(function* () {
  console.log("Recreating database views...");
  yield* (ensureSchema);
  console.log("Views recreated successfully.");
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Failed to recreate views:", error);
  process.exitCode = 1;
});
