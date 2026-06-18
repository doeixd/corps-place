// test/checkSeasons.ts
// Check available seasons from DCI API

import { Effect } from "effect";
import { NodeContext } from "@effect/platform-node";
import { DciApi, makeDciApiLayer } from "../src/index.js";

const program = Effect.gen(function* () {
  const api = yield* (DciApi);

  console.log("Fetching available seasons from DCI API...\n");
  const seasons = yield* (api.getSeasons());

  console.log("Available seasons:");
  console.table(seasons);

  // Check 2025 specifically
  if (seasons.includes("2025")) {
    console.log("\n✓ 2025 season is available!");

    // Try to fetch competitions for 2025
    console.log("\nFetching 2025 competitions...");
    const competitions = yield* (api.getCompetitions("2025"));
    console.log(`Found ${competitions.length} competitions in 2025:`);

    if (competitions.length > 0) {
      console.table(competitions.slice(0, 10).map(c => ({
        slug: c.slug,
        eventName: c.eventName,
        date: c.date?.toISOString?.()?.split('T')[0] || 'Unknown',
        location: c.location,
        recapReleased: c.recapReleased
      })));
    }
  } else {
    console.log("\n✗ 2025 season is not yet available in the DCI API");
    console.log("The most recent season is:", seasons[seasons.length - 1]);
  }
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeDciApiLayer()),
    Effect.provide(NodeContext.layer),
  ),
).catch((error) => {
  console.error("Error:", error);
  process.exitCode = 1;
});
