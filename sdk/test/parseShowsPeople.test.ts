// Tests for the shows-by-year and people parsers against REAL saved pages.
//
// Run with: npx tsx test/parseShowsPeople.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { parseShowsByYear } from "../src/dcxScrape/parseShows.js";
import { parseBiographies, parseHallOfFameIndex } from "../src/dcxScrape/parsePeople.js";

let passed = 0;
let failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
};
const read = (f: string) =>
  fs.readFileSync(path.join(process.cwd(), "test", "fixtures", "dcx", f), "utf8");

console.log("=== Shows + People parsers ===\n");

// --- Shows by year ---
console.log("1. Shows by year");
const shows = parseShowsByYear(read("shows-byyear.html"));
assert(shows.length === 74, `parsed 74 shows (got ${shows.length})`);
const barnum = shows.find((s) => /Barnum Festival/.test(s.eventName ?? ""));
assert(barnum !== undefined, "found Barnum Festival show");
assert(barnum?.showId === "2026002", `showId = 2026002 (got ${barnum?.showId})`);
assert(barnum?.date === "June 27, 2026", `date = "June 27, 2026" (got "${barnum?.date}")`);
assert(barnum?.year === 2026, `year = 2026 (got ${barnum?.year})`);
assert(/Shelton/.test(barnum?.location ?? ""), `location has Shelton (got "${barnum?.location}")`);
const seventh = barnum?.corps.find((c) => c.corpsName === "7th Regiment");
assert(seventh?.corpsId === "1403", `7th Regiment corpsId = 1403 (got ${seventh?.corpsId})`);
const totalCorps = shows.reduce((n, s) => n + s.corps.length, 0);
// 668 lineup entries live inside the 74 show lists; a 669th showChangeYear ref
// exists in a JS template outside any list and is correctly excluded.
assert(totalCorps === 668, `total corps lineup entries = 668 (got ${totalCorps})`);
assert(
  shows.every((s) => s.corps.every((c) => c.corpsName.length > 0)),
  "every lineup entry has a corps name",
);

// --- Biographies ---
console.log("\n2. Biographies (people)");
const bios = parseBiographies(read("people-biographies.html"));
assert(bios.length > 0, `parsed biographies (${bios.length})`);
const flowers = bios.find((b) => /John and Barbara Flowers/.test(b.title ?? ""));
assert(flowers !== undefined, "found 'John and Barbara Flowers' bio");
assert(/\.pdf$/i.test(flowers?.docUrl ?? ""), `doc url is a pdf (${flowers?.docUrl})`);
assert(
  flowers?.contributor === "John and Barbara Flowers",
  `contributor parsed (got "${flowers?.contributor}")`,
);
assert(
  bios.every((b) => b.docUrl.startsWith("assets/")),
  "every bio doc url under assets/",
);

// --- Hall of Fame index ---
console.log("\n3. Hall of Fame index");
const hof = parseHallOfFameIndex(read("people-halloffame.html"));
assert(hof.length >= 2, `parsed HOF index links (${hof.length})`);
assert(hof.some((h) => h.view === "dcihof"), "includes dcihof");
assert(hof.some((h) => h.view === "wdchof"), "includes wdchof");

// --- Robustness ---
console.log("\n4. Robustness");
assert(parseShowsByYear("<html></html>").length === 0, "no shows → empty (no throw)");
assert(parseBiographies("<html></html>").length === 0, "no bios → empty (no throw)");

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
