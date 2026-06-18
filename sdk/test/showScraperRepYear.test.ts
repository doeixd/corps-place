// Tests for DCX Museum historical RepYear parser (pure, no network).
//
// Run with: npx tsx test/showScraperRepYear.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { parseRepYearHtml } from "../src/showScraperDcx.js";

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

const fx = (name: string) =>
  fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "dcx", name), "utf8");

console.log("=== DCX RepYear Parser Tests ===\n");

// --- Test 1: Competing year with composers (Blue Devils 2024) ---
console.log("1. Competing year with composers (BD 2024)");
const bd2024 = parseRepYearHtml(fx("repyear-bd-2024.html"));
assert(bd2024.available === true, "available = true");
assert(bd2024.title === "Magnum Opus", `title = "Magnum Opus" (got "${bd2024.title}")`);
assert(bd2024.repertoire.length === 4, `4 songs (got ${bd2024.repertoire.length})`);
assert(
  bd2024.repertoire[0].workTitle === "Little Fugue in G minor",
  `song 0 title (got "${bd2024.repertoire[0]?.workTitle}")`
);
assert(
  bd2024.repertoire[0].composer === "Johan Sebastian Bach",
  `song 0 composer (got "${bd2024.repertoire[0]?.composer}")`
);
assert(
  bd2024.repertoire[3].composer === "Jacob Dodge Lawson (aka JKVE)",
  `song 3 composer normalized (got "${bd2024.repertoire[3]?.composer}")`
);
assert(bd2024.score === null, `score null (0.000 placeholder) (got ${bd2024.score})`);

// --- Test 2: Competing year, fewer songs (BD 2019) ---
console.log("\n2. Competing year (BD 2019)");
const bd2019 = parseRepYearHtml(fx("repyear-bd-2019.html"));
assert(bd2019.available === true, "available = true");
assert(bd2019.title === "Psychotic Circus", `title = "Psychotic Circus" (got "${bd2019.title}")`);
assert(bd2019.repertoire.length === 2, `2 songs (got ${bd2019.repertoire.length})`);
assert(
  bd2019.repertoire[1].composer === "Key Poulan",
  `song 1 composer = "Key Poulan" (got "${bd2019.repertoire[1]?.composer}")`
);

// --- Test 3: Real placement + score (cid 17, 2017) ---
console.log("\n3. Real placement + score (cid17 2017)");
const placed = parseRepYearHtml(fx("repyear-cid17-2017-placed.html"));
assert(placed.available === true, "available = true");
assert(placed.title === "Metamorph", `title = "Metamorph" (got "${placed.title}")`);
assert(placed.position === 1, `position = 1 (got ${placed.position})`);
assert(placed.score === 98.538, `score = 98.538 (got ${placed.score})`);

// --- Test 4: Unavailable year (BD 2013) ---
console.log("\n4. Unavailable year (BD 2013)");
const bd2013 = parseRepYearHtml(fx("repyear-bd-2013.html"));
assert(bd2013.available === false, "available = false");
assert(bd2013.title === null, `title null (got "${bd2013.title}")`);
assert(bd2013.repertoire.length === 0, `0 songs (got ${bd2013.repertoire.length})`);
assert(bd2013.position === null, "position null");

// --- Test 5: Empty / malformed ---
console.log("\n5. Edge cases");
const empty = parseRepYearHtml("<html><body>Repertoire unavailable</body></html>");
assert(empty.available === false, "bare unavailable body → available false");

// --- Summary ---
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
