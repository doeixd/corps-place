// Test parsing multiple class tables from a recap page
// Usage: npx tsx scripts/testClassParsing.ts

import * as cheerio from "cheerio";
import * as fs from "fs";

const html = fs.readFileSync("test/fixtures/test-recap-2025-march-on.html", "utf-8");
const $ = cheerio.load(html);

console.log("=== Testing Class Table Parsing ===\n");

// Find all recap tables
const recapTables = $(".recap-tbl");
console.log(`Found ${recapTables.length} .recap-tbl elements\n`);

recapTables.each((i, tblDiv) => {
  const $tblDiv = $(tblDiv);

  // Method 1: Check the parent div, then the previous sibling div
  const $parent = $tblDiv.parent();
  const $prevDiv = $parent.prev();
  const $h2InPrevDiv = $prevDiv.find("h2");

  console.log(`Table ${i + 1}:`);
  console.log(`  Parent tag: ${$parent.prop("tagName")}`);
  console.log(`  Prev sibling tag: ${$prevDiv.prop("tagName")}`);
  console.log(`  H2 in prev div: "${$h2InPrevDiv.text().trim()}"`);
  console.log(`  H2 classes: ${$h2InPrevDiv.attr("class") || "(none)"}`);

  // Method 2: Find sibling divs with h2
  const $prevSiblingWithH2 = $tblDiv.parent().prevAll("div").find("h2").first();
  console.log(`  Method 2 h2: "${$prevSiblingWithH2.text().trim()}"`);

  // Count corps in this table
  const dataRows = $tblDiv.find("table > tbody > tr").not(".table-top");
  const corpsNames = dataRows.map((_, row) => {
    return $(row).find(".sticky-td").text().trim();
  }).get().filter(Boolean);

  console.log(`  Corps (${corpsNames.length}): ${corpsNames.join(", ")}`);
  console.log();
});

// Now test the correct selector approach
console.log("=== Testing Corrected Selector ===\n");

// Find all divs that contain h2 with class "h4"
const classSections = $("div > h2.h4").filter((_, el) => {
  const text = $(el).text().trim();
  // Filter to only class headers (not table column headers)
  return text.match(/^(Open Class|All-Age|World Class|International|SoundSport)/i);
});

console.log(`Found ${classSections.length} class section headers\n`);

classSections.each((i, h2El) => {
  const $h2 = $(h2El);
  const className = $h2.text().trim();

  // The h2 is inside a div, and the next sibling div contains the recap-tbl
  const $h2Parent = $h2.parent();
  const $nextDiv = $h2Parent.next();
  const $recapTbl = $nextDiv.hasClass("recap-tbl") ? $nextDiv : $nextDiv.find(".recap-tbl");

  console.log(`Class ${i + 1}: "${className}"`);
  console.log(`  H2 parent: <${$h2Parent.prop("tagName")}>`);
  console.log(`  Next div: <${$nextDiv.prop("tagName")}>`);
  console.log(`  Has recap-tbl: ${$nextDiv.hasClass("recap-tbl")}`);

  if ($recapTbl.length > 0) {
    const dataRows = $recapTbl.find("table > tbody > tr").not(".table-top");
    const corpsNames = dataRows.map((_, row) => {
      return $(row).find(".sticky-td").text().trim();
    }).get().filter(Boolean);

    console.log(`  Corps found: ${corpsNames.length}`);
    corpsNames.forEach((name, idx) => {
      // Get rank
      const $row = $(dataRows[idx]);
      const $finalCell = $row.find("> td").last();
      const $rankSpan = $finalCell.find("span").eq(1);
      const rank = $rankSpan.text().trim();

      console.log(`    ${rank}. ${name}`);
    });
  } else {
    console.log(`  ERROR: No recap table found!`);
  }

  console.log();
});
