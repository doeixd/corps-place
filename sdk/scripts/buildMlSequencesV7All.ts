// scripts/buildMlSequencesV7All.ts
// Generate V7 sequences for all historical seasons.
// Usage: npx tsx scripts/buildMlSequencesV7All.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { buildSequencesV7 } from "../src/buildMlSequencesV7.ts";

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(buildSequencesV7().pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done building V7 sequences."))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
