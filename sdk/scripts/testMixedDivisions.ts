// Test script to examine mixed division pages
// Usage: npx tsx scripts/testMixedDivisions.ts

import * as cheerio from "cheerio";
import * as fs from "fs";

const requestHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

async function fetchAndAnalyze(slug: string) {
  console.log(`\n=== Analyzing ${slug} ===\n`);

  const url = `https://www.dci.org/scores/recap/${slug}`;
  console.log(`Fetching: ${url}`);

  const response = await fetch(url, { headers: requestHeaders });
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }

  const html = await response.text();
  fs.writeFileSync(`test-${slug}.html`, html);
  console.log(`Saved to test-${slug}.html\n`);

  const $ = cheerio.load(html);

  // Check for multiple class sections
  const classSections = $("div > h2.h4").filter((_, el) => {
    const text = $(el).text().trim();
    return text.match(/^(Open Class|All-Age|World Class|International|SoundSport)/i);
  });

  console.log(`Class section headers found: ${classSections.length}`);

  if (classSections.length > 0) {
    console.log("Class sections:");
    classSections.each((i, el) => {
      console.log(`  ${i + 1}. "${$(el).text().trim()}"`);
    });
  }

  // Check for recap tables
  const recapTables = $(".recap-tbl");
  console.log(`\nRecap tables found: ${recapTables.length}`);

  // For each table, show a sample of corps
  recapTables.each((i, tbl) => {
    const $tbl = $(tbl);
    const dataRows = $tbl.find("> table > tbody > tr").not(".table-top");
    const corpsNames = dataRows
      .slice(0, 5)
      .map((_, row) => $(row).find(".sticky-td").text().trim())
      .get();

    console.log(`\nTable ${i + 1}: ${dataRows.length} corps`);
    console.log(`  Sample: ${corpsNames.join(", ")}${dataRows.length > 5 ? "..." : ""}`);
  });

  // Check page title
  const pageTitle = $(".elementor-widget-theme-post-title h1").text().trim();
  console.log(`\nPage title: "${pageTitle}"`);
}

async function main() {
  try {
    // Test the World Championship Prelims page mentioned by user
    await fetchAndAnalyze("2025-dci-world-championship-prelims");

    // Also test a few 2024 pages to understand patterns
    console.log("\n" + "=".repeat(60));
    await fetchAndAnalyze("2024-dci-world-championship-finals");
  } catch (error) {
    console.error("Error:", error);
    process.exitCode = 1;
  }
}

main();
