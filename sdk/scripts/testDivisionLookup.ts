// Test corps division lookup for mixed-division tables
// Usage: npx tsx scripts/testDivisionLookup.ts

import * as fs from "fs";
import { Effect, Exit } from "effect";
import {
  parseRecapHtml,
  buildCorpsScoresFromWebsiteRecap,
  buildCompetitionFromWebsiteRecap,
  type CorpsDivisionMap
} from "../src/websiteRecap.js";

async function main() {
  console.log("=== Testing Division Lookup for Mixed Tables ===\n");

  const html = fs.readFileSync("test-2024-prelims-mixed.html", "utf-8");

  const parseEffect = parseRecapHtml(html);
  const result = await Effect.runPromiseExit(parseEffect);

  if (Exit.isFailure(result)) {
    console.error("❌ Parsing failed:", result.cause);
    process.exitCode = 1;
    return;
  }

  const recap = result.value;

  console.log(`Parsed: ${recap.meta.title}`);
  console.log(`Classes found: ${recap.classes.length}`);
  console.log(`Class names: ${recap.classes.map(c => c.className).join(", ")}\n`);

  const entry = {
    id: "2024-dci-world-championship-prelims",
    title: recap.meta.title,
    date: recap.meta.date,
    location: recap.meta.location,
    url: "https://www.dci.org/scores/recap/2024-dci-world-championship-prelims"
  };

  const competition = buildCompetitionFromWebsiteRecap(entry.id, recap, entry);

  // Build a mock division map based on the data we queried earlier
  const corpsDivisionMap: CorpsDivisionMap = {
    "7th regiment": "Open Class",
    "colt cadets": "Open Class",
    "gold": "Open Class",
    "les stentors": "Open Class",
    "raiders": "Open Class",
    "blue devils b": "Open Class",
    "columbians": "Open Class",
    // World Class corps
    "bluecoats": "World Class",
    "blue devils": "World Class",
    "boston crusaders": "World Class",
    "carolina crown": "World Class",
    "phantom regiment": "World Class",
    "santa clara vanguard": "World Class",
    "mandarins": "World Class",
    "blue stars": "World Class",
    "colts": "World Class",
    "the cavaliers": "World Class",
    "troopers": "World Class",
    "madison scouts": "World Class",
    "pacific crest": "World Class",
    "blue knights": "World Class",
    "crossmen": "World Class",
    "spirit of atlanta": "World Class",
    "the academy": "World Class",
    "music city": "World Class",
    "spartans": "Open Class",
    "genesis": "World Class",
    "seattle cascades": "World Class",
    "jersey surf": "World Class",
    "the battalion": "Open Class",
    "river city rhythm": "Open Class"
  };

  console.log("=== Test 1: WITHOUT division lookup (old behavior) ===");
  const scoresWithoutLookup = buildCorpsScoresFromWebsiteRecap(competition, recap);

  const incorrectDivisions = scoresWithoutLookup.filter((score) => {
    const lcName = score.groupName.toLowerCase();
    return corpsDivisionMap[lcName] && score.divisionName !== corpsDivisionMap[lcName];
  });

  console.log(`Total corps: ${scoresWithoutLookup.length}`);
  console.log(`Incorrectly classified: ${incorrectDivisions.length}`);
  if (incorrectDivisions.length > 0) {
    console.log("\nIncorrect classifications:");
    incorrectDivisions.forEach((score) => {
      const lcName = score.groupName.toLowerCase();
      console.log(
        `  ❌ ${score.groupName}: assigned "${score.divisionName}", should be "${corpsDivisionMap[lcName]}"`
      );
    });
  }

  console.log("\n=== Test 2: WITH division lookup (new behavior) ===");
  const scoresWithLookup = buildCorpsScoresFromWebsiteRecap(
    competition,
    recap,
    corpsDivisionMap
  );

  const stillIncorrect = scoresWithLookup.filter((score) => {
    const lcName = score.groupName.toLowerCase();
    return corpsDivisionMap[lcName] && score.divisionName !== corpsDivisionMap[lcName];
  });

  console.log(`Total corps: ${scoresWithLookup.length}`);
  console.log(`Incorrectly classified: ${stillIncorrect.length}`);

  if (stillIncorrect.length === 0) {
    console.log("\n✅ All corps correctly classified with division lookup!");

    // Show some examples
    const openClassCorps = scoresWithLookup.filter((s) => s.divisionName === "Open Class");
    const worldClassCorps = scoresWithLookup.filter((s) => s.divisionName === "World Class");

    console.log(`\nOpen Class corps (${openClassCorps.length}):`);
    openClassCorps.slice(0, 5).forEach((s) => {
      console.log(`  ✓ ${s.groupName} - ${s.divisionName}`);
    });

    console.log(`\nWorld Class corps (${worldClassCorps.length}):`);
    worldClassCorps.slice(0, 5).forEach((s) => {
      console.log(`  ✓ ${s.groupName} - ${s.divisionName}`);
    });
  } else {
    console.log("\n❌ Still have incorrect classifications:");
    stillIncorrect.forEach((score) => {
      const lcName = score.groupName.toLowerCase();
      console.log(
        `  ${score.groupName}: got "${score.divisionName}", expected "${corpsDivisionMap[lcName]}"`
      );
    });
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});
