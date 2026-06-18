// scripts/buildMlSequencesV9All.ts
// Generate V9 sequences for all historical seasons.
// Usage: npx tsx scripts/buildMlSequencesV9All.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { buildSequencesV9 } from "../src/buildMlSequencesV9.ts";

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(buildSequencesV9().pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done building V9 sequences."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
