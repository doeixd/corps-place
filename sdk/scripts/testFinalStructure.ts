// Final comprehensive test of the parsing logic
// Usage: npx tsx scripts/testFinalStructure.ts

import * as cheerio from "cheerio";
import * as fs from "fs";

const html = fs.readFileSync("test/fixtures/test-recap-2025-march-on.html", "utf-8");
const $ = cheerio.load(html);

console.log("=== Complete Multi-Class Parsing Test ===\n");

// Find all class section headers
const classSections = $("div > h2.h4").filter((_, el) => {
  const text = $(el).text().trim();
  return text.match(/^(Open Class|All-Age|World Class|International|SoundSport)/i);
});

console.log(`Found ${classSections.length} class sections\n`);

interface CorpsScore {
  className: string;
  corpsName: string;
  finalScore: number;
  finalRank: number;
}

const allScores: CorpsScore[] = [];

classSections.each((i, h2El) => {
  const $h2 = $(h2El);
  const className = $h2.text().trim();

  // The recap table is in the next sibling div
  const $recapTbl = $h2.parent().next();

  console.log(`=== ${className} ===`);

  if (!$recapTbl.hasClass("recap-tbl")) {
    console.log("ERROR: No recap table found!\n");
    return;
  }

  // Get all data rows (excluding header row)
  // Must use > to get direct children only, not nested table rows
  const dataRows = $recapTbl.find("> table > tbody > tr").not(".table-top");

  console.log(`Corps count: ${dataRows.length}\n`);

  dataRows.each((_, row) => {
    const $row = $(row);

    // Get corps name
    const corpsName = $row.find(".sticky-td").text().trim();

    // Get final score and rank (last td)
    const $finalCell = $row.find("> td").last();
    const spans = $finalCell.find("span");

    let finalScore = 0;
    let finalRank = 0;

    if (spans.length >= 2) {
      finalScore = parseFloat($(spans[0]).text().trim()) || 0;
      finalRank = parseInt($(spans[1]).text().trim()) || 0;
    } else {
      // Fallback: try to parse from text
      const text = $finalCell.text().trim();
      finalScore = parseFloat(text) || 0;
    }

    console.log(`  ${finalRank}. ${corpsName} - ${finalScore}`);

    allScores.push({
      className,
      corpsName,
      finalScore,
      finalRank
    });
  });

  console.log();
});

// Verify rankings are correct per class
console.log("=== Verification ===\n");

const byClass = new Map<string, CorpsScore[]>();
allScores.forEach(score => {
  if (!byClass.has(score.className)) {
    byClass.set(score.className, []);
  }
  byClass.get(score.className)!.push(score);
});

let allCorrect = true;

byClass.forEach((scores, className) => {
  console.log(`${className}:`);

  // Check that ranks start at 1 and increment
  const ranks = scores.map(s => s.finalRank).sort((a, b) => a - b);
  const expectedRanks = Array.from({ length: scores.length }, (_, i) => i + 1);

  const ranksCorrect = ranks.every((r, i) => r === expectedRanks[i]);

  if (ranksCorrect) {
    console.log(`  ✓ Rankings correct (1-${scores.length})`);
  } else {
    console.log(`  ✗ Rankings incorrect!`);
    console.log(`    Expected: ${expectedRanks.join(", ")}`);
    console.log(`    Got: ${ranks.join(", ")}`);
    allCorrect = false;
  }

  // Check that scores are in descending order by rank
  const sortedByRank = [...scores].sort((a, b) => a.finalRank - b.finalRank);
  const scoresInOrder = sortedByRank.every((score, i) => {
    if (i === 0) return true;
    return score.finalScore <= sortedByRank[i - 1].finalScore;
  });

  if (scoresInOrder) {
    console.log(`  ✓ Scores ordered correctly by rank`);
  } else {
    console.log(`  ✗ Scores not in rank order!`);
    allCorrect = false;
  }

  console.log();
});

if (allCorrect) {
  console.log("✅ All class tables parsed correctly!");
} else {
  console.log("❌ Issues found in parsing");
  process.exitCode = 1;
}

// Summary
console.log("\n=== Summary ===");
console.log(`Total classes: ${byClass.size}`);
console.log(`Total corps: ${allScores.length}`);
byClass.forEach((scores, className) => {
  console.log(`  ${className}: ${scores.length} corps`);
});
