// Test the updated websiteRecap parser with multiple class tables
// Usage: npx tsx scripts/testUpdatedParser.ts

import * as fs from "fs";
import { Effect, Exit } from "effect";
import { parseRecapHtml, buildCorpsScoresFromWebsiteRecap, buildCompetitionFromWebsiteRecap } from "../src/websiteRecap.js";
import type { WebsiteRecap } from "../src/domain.js";

async function main() {
  console.log("=== Testing Updated Parser ===\n");

  // Read the test HTML file
  const html = fs.readFileSync("test/fixtures/test-recap-2025-march-on.html", "utf-8");

  // Parse it using the updated function
  const parseEffect = parseRecapHtml(html);
  const result = await Effect.runPromiseExit(parseEffect);

  if (Exit.isFailure(result)) {
    console.error("❌ Parsing failed:");
    console.error(result.cause);
    process.exitCode = 1;
    return;
  }

  const recap: WebsiteRecap = result.value;

  console.log("✅ Parsing succeeded!\n");
  console.log("=== Recap Metadata ===");
  console.log(`Title: ${recap.meta.title}`);
  console.log(`Date: ${recap.meta.date}`);
  console.log(`Location: ${recap.meta.location}`);
  console.log(`Chief Judge: ${recap.meta.chiefJudge}\n`);

  console.log("=== Class Tables ===");
  console.log(`Total classes found: ${recap.classes.length}\n`);

  let totalCorps = 0;
  for (const classTable of recap.classes) {
    console.log(`Class: "${classTable.className}"`);
    console.log(`Corps count: ${classTable.corps.length}`);
    totalCorps += classTable.corps.length;

    // Show top 3 corps in this class
    const top3 = classTable.corps
      .slice()
      .sort((a, b) => a.finalRank - b.finalRank)
      .slice(0, 3);

    console.log("Top corps:");
    for (const corp of top3) {
      console.log(`  ${corp.finalRank}. ${corp.corpsName} - ${corp.finalScore}`);
    }
    console.log();
  }

  console.log(`Total corps across all classes: ${totalCorps}\n`);

  // Test building competition and corps scores
  console.log("=== Testing buildCorpsScoresFromWebsiteRecap ===");
  const entry = {
    id: "2025-march-on",
    title: recap.meta.title,
    date: recap.meta.date,
    location: recap.meta.location,
    url: "https://www.dci.org/scores/recap/2025-march-on"
  };

  const competition = buildCompetitionFromWebsiteRecap("2025-march-on", recap, entry);
  const corpsScores = buildCorpsScoresFromWebsiteRecap(competition, recap);

  console.log(`Total corps scores generated: ${corpsScores.length}`);

  // Group by division
  const byDivision = new Map<string, number>();
  for (const score of corpsScores) {
    const count = byDivision.get(score.divisionName) || 0;
    byDivision.set(score.divisionName, count + 1);
  }

  console.log("\nCorps by division:");
  for (const [division, count] of byDivision.entries()) {
    console.log(`  ${division}: ${count} corps`);
  }

  // Verify rankings are correct per class table (not per division, since division can have multiple sub-classes)
  console.log("\n=== Verifying Rankings Per Class Table ===");
  let allCorrect = true;

  for (const classTable of recap.classes) {
    const ranks = classTable.corps.map(c => c.finalRank).sort((a, b) => a - b);
    const expectedRanks = Array.from({ length: classTable.corps.length }, (_, i) => i + 1);

    const ranksCorrect = ranks.every((r, i) => r === expectedRanks[i]);

    if (ranksCorrect) {
      console.log(`✓ "${classTable.className}": Rankings correct (1-${classTable.corps.length})`);
    } else {
      console.log(`✗ "${classTable.className}": Rankings incorrect!`);
      console.log(`  Expected: ${expectedRanks.join(", ")}`);
      console.log(`  Got: ${ranks.join(", ")}`);
      allCorrect = false;
    }
  }

  if (allCorrect) {
    console.log("\n✅ All class table rankings verified correctly!");
  } else {
    console.log("\n❌ Ranking issues found");
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});
