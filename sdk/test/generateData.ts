// test/generateData.ts
// Script to generate training data from the DCI API using the SDK.
//
// This script:
// 1. Fetches competitions and recaps from the DCI API
// 2. Ingests them into the relational database
// 3. Builds ML training rows
//
// Run with: npx tsx test/generateData.ts
//
// Options:
//   --seasons 2023,2024  - Comma-separated list of seasons to process
//   --division "World Class" - Division to filter
//   --db ./dci-relational.db - Database file path

import { Effect, Console, Layer } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { makeDciApiLayer } from "../src/client.js";
import { ensureRelationalSchema, ingestRelationalData } from "../src/relational.js";
import { buildMlRows, ensureMlTables } from "../src/buildMlRows.js";

// ----- Config -----

interface Config {
  seasons: string[];
  divisionName: string;
  dbUrl: string;
}

function parseArgs(): Config {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };

  const seasonsArg = get("--seasons", "2024");
  const seasons = seasonsArg!.split(",").map((s) => s.trim());

  return {
    seasons,
    divisionName: get("--division", "World Class")!,
    dbUrl: `file:${get("--db", "./dci-relational.db")}`,
  };
}

// ----- Main Program -----

const generateData = (config: Config) =>
  Effect.gen(function* () {
    yield* (Console.log(`Starting data generation for seasons: ${config.seasons.join(", ")}`));

    // Ensure schemas exist
    yield* (Console.log("Ensuring relational schema..."));
    yield* (ensureRelationalSchema);

    yield* (Console.log("Ensuring ML tables..."));
    yield* (ensureMlTables);

    // Ingest relational data for the specified seasons
    yield* (Console.log(`\nIngesting data for seasons: ${config.seasons.join(", ")}...`));
    const ingestResult = yield* (ingestRelationalData({
      seasons: config.seasons,
      persistRankings: true,
    }));
    yield* (Console.log(`Ingested: ${ingestResult.competitions} competitions, ${ingestResult.recaps} recaps, ${ingestResult.corpsScores} corps scores`));

    // Build ML training rows
    yield* (Console.log("\nBuilding ML training rows..."));
    const mlResult = yield* (
      buildMlRows({
        seasons: config.seasons,
        divisionName: config.divisionName,
        featureVersion: "v1.1",
      })
    );

    yield* (Console.log(`\nCompleted: ${mlResult.totalRows} training rows from ${mlResult.competitions} competitions`));

    return { ingestResult, mlResult };
  });

// ----- Entry Point -----

async function main() {
  const config = parseArgs();
  console.log("Config:", config);

  // Build the runtime layers
  const SqlLayer = LibsqlClient.layer({ url: config.dbUrl });
  const ApiLayer = makeDciApiLayer();

  const program = generateData(config).pipe(
    Effect.provide(SqlLayer),
    Effect.provide(ApiLayer)
  );

  try {
    const result = await Effect.runPromise(program);
    console.log("\n✓ Data generation complete:", result);
  } catch (err) {
    console.error("\n✗ Data generation failed:", err);
    process.exitCode = 1;
  }
}

main();
