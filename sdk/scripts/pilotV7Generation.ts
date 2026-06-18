// scripts/pilotV7Generation.ts
// Run V7 sequence generation for 2024 season only.
// Usage: npx tsx scripts/pilotV7Generation.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { buildSequencesV7 } from "../src/buildMlSequencesV7.ts";
import * as fs from "fs";

// Patch SEASONS to only process 2024
const originalSequencesV7 = buildSequencesV7;

const main = Effect.gen(function* () {
  console.log("Starting V7 Pilot Generation (2024 only)...");

  // We don't easily have a way to inject SEASONS into buildMlSequencesV7 without modifying it
  // But for a pilot, we can just run it. If it's too slow to run all, we can modify the file temporarily.
  yield* (buildSequencesV7(["2024"]));

  console.log("Pilot generation complete.");
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log("Done!"))
  .catch(err => {
    console.error("Pilot failed:", err);
    process.exitCode = 1;
  });
