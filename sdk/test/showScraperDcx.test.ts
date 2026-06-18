// Tests for DCX Museum scraper (pure parsing + name matching).
//
// Run with: npx tsx test/showScraperDcx.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { parseDcxRepertoireHtml } from "../src/showScraperDcx.js";

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

const fixturePath = path.join(process.cwd(), "__fixtures__", "dcx-repertoires-2026.html");
const fixtureHtml = fs.readFileSync(fixturePath, "utf8");

console.log("=== DCX Scraper Tests ===\n");

// --- Test 1: Parse fixture HTML ---
console.log("1. Parsing fixture HTML");
const entries = parseDcxRepertoireHtml(fixtureHtml);
assert(entries.length > 0, `Parsed ${entries.length} entries from fixture`);
assert(entries.length === 9, `Expected 9 entries, got ${entries.length}`);

// --- Test 2: Corps name extraction ---
console.log("\n2. Corps name extraction");
const seventhRegiment = entries.find((e) => e.dcxCorpsName === "7th Regiment");
assert(seventhRegiment !== undefined, "Found '7th Regiment'");
assert(seventhRegiment?.dcxCorpsId === "1403", "7th Regiment corpsId = 1403");

const academy = entries.find((e) => e.dcxCorpsName === "Academy, The");
assert(academy !== undefined, "Found 'Academy, The'");
assert(academy?.dcxCorpsId === "1455", "Academy corpsId = 1455");

const crossmen = entries.find((e) => e.dcxCorpsName === "Crossmen");
assert(crossmen !== undefined, "Found 'Crossmen'");

// --- Test 3: Show title extraction ---
console.log("\n3. Show title extraction");
assert(seventhRegiment?.showTitle === "In Spring", `7th Regiment title = "In Spring" (got "${seventhRegiment?.showTitle}")`);
assert(academy?.showTitle === "In the Center of the Ring", `Academy title = "In the Center of the Ring" (got "${academy?.showTitle}")`);
assert(crossmen?.showTitle === "A Side/B Side", `Crossmen title = "A Side/B Side" (got "${crossmen?.showTitle}")`);

// Corps with "No title yet" marker
const blueDevils = entries.find((e) => e.dcxCorpsName === "Blue Devils");
assert(blueDevils !== undefined, "Found 'Blue Devils'");
assert(blueDevils?.showTitle === ".No title yet", `Blue Devils title = ".No title yet" (got "${blueDevils?.showTitle}")`);

// Corps with "." placeholder (no data)
const blueKnights = entries.find((e) => e.dcxCorpsName === "Blue Knights");
assert(blueKnights !== undefined, "Found 'Blue Knights'");
assert(blueKnights?.showTitle === null, `Blue Knights title = null (got "${blueKnights?.showTitle}")`);

// --- Test 4: Repertoire (songs) extraction ---
console.log("\n4. Repertoire (songs) extraction");
assert(seventhRegiment?.songs.length === 4, `7th Regiment has 4 songs (got ${seventhRegiment?.songs.length})`);
assert(seventhRegiment?.songs[0] === "Appalachian Spring", `Song 0 = "Appalachian Spring"`);
assert(seventhRegiment?.songs[1] === "Symphony #6", `Song 1 = "Symphony #6" (trimmed)`);
assert(seventhRegiment?.songs[3] === "Sleeping Beauty Waltz", `Song 3 = "Sleeping Beauty Waltz"`);

assert(academy?.songs.length === 6, `Academy has 6 songs (got ${academy?.songs.length})`);
assert(academy?.songs[2] === "Original music", `Academy song 2 = "Original music"`);

assert(crossmen?.songs.length === 8, `Crossmen has 8 songs (got ${crossmen?.songs.length})`);
assert(crossmen?.songs[7] === "Original music", `Crossmen last song = "Original music"`);

assert(blueDevils?.songs.length === 3, `Blue Devils has 3 songs (got ${blueDevils?.songs.length})`);
assert(blueDevils?.songs[0] === "Mishima /Opening", `Blue Devils song 0 = "Mishima /Opening"`);

// No songs for placeholder entries
assert(blueKnights?.songs.length === 0, `Blue Knights has 0 songs (got ${blueKnights?.songs.length})`);

// --- Test 5: Division section tracking ---
console.log("\n5. Division section tracking");
assert(seventhRegiment?.divisionSection === "", "7th Regiment divisionSection tracked (fixture header row format)");
const bushwackers = entries.find((e) => e.dcxCorpsName === "Bushwackers");
assert(bushwackers !== undefined, "Found 'Bushwackers'");
assert(bushwackers?.divisionSection === "", "Bushwackers divisionSection tracked (fixture header row format)");

// --- Test 6: Empty / malformed HTML ---
console.log("\n6. Edge cases");
const emptyResult = parseDcxRepertoireHtml("<html><body><table></table></body></html>");
assert(emptyResult.length === 0, "Empty table yields 0 entries");

const noTableResult = parseDcxRepertoireHtml("<html><body>No table here</body></html>");
assert(noTableResult.length === 0, "No table yields 0 entries");

// --- Summary ---
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
