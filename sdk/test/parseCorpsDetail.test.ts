// Tests for the DCX corps-detail parser against a REAL saved page
// (Blue Devils, corpsid=17). Verifies robust, correct extraction of every tab.
//
// Run with: npx tsx test/parseCorpsDetail.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { parseCorpsDetail } from "../src/dcxScrape/parseCorps.js";

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

const fixture = path.join(process.cwd(), "test", "fixtures", "dcx", "corps-detail-17.html");
const html = fs.readFileSync(fixture, "utf8");
const d = parseCorpsDetail(html, "17");

console.log("=== Corps-detail parser (Blue Devils, id=17) ===\n");

// --- Header ---
console.log("1. Header / identity");
assert(d.dcxCorpsId === "17", "corpsId preserved");
assert(d.name === "Blue Devils", `name = "${d.name}"`);
assert(d.city === "Concord", `city = "${d.city}"`);
assert(d.state === "CA", `state = "${d.state}"`);
assert(d.country === "United States", `country = "${d.country}"`);
assert(d.founded === "1957", `founded = "${d.founded}"`);
assert(d.disbanded === null, "disbanded = null (active corps)");
assert(d.status === "Active", `status = "${d.status}"`);
assert(d.division === "Junior", `division = "${d.division}"`);
assert(d.corpsClass === "World Class", `class = "${d.corpsClass}"`);
assert(/corpslogos\//.test(d.logoUrl ?? ""), `logo url = "${d.logoUrl}"`);

console.log("\n1b. Links (tab-7) + corps assets (tab-6)");
assert(d.links.length >= 2, `parsed external links (${d.links.length})`);
assert(d.links.some((l) => l.url === "http://www.bluedevils.org"), "links include official site");
assert(d.links.some((l) => /wikipedia\.org/.test(l.url)), "links include wikipedia");
assert(d.assets.length > 0, `parsed corps-owned assets from tab-6 (${d.assets.length})`);
assert(d.assets.every((a) => a.imageUrl.startsWith("assets/")), "corps assets have image urls");

// --- History ---
console.log("\n2. History narrative");
assert((d.historyText?.length ?? 0) > 200, `history text present (${d.historyText?.length} chars)`);
assert(/Blue Devils/.test(d.historyText ?? ""), "history mentions the corps");
assert(/Concord, California/.test(d.historyText ?? ""), "history mentions home city");

// --- Repertoire ---
console.log("\n3. Repertoire (tab-1)");
assert(d.repertoire.length > 30, `parsed many rep years (${d.repertoire.length})`);
const rep1971 = d.repertoire.find((r) => r.year === 1971);
assert(rep1971 !== undefined, "found 1971 repertoire row");
assert(
  rep1971?.songs.includes("Theme from Lawrence of Arabia") ?? false,
  "1971 includes 'Theme from Lawrence of Arabia'",
);
assert((rep1971?.songs.length ?? 0) === 6, `1971 has 6 songs (got ${rep1971?.songs.length})`);
assert(
  d.repertoire.every((r) => r.year === null || (r.year >= 1957 && r.year <= 2026)),
  "all rep years within plausible range",
);

// --- Scores ---
console.log("\n4. Scores (tab-4)");
assert(d.scores.length > 10, `parsed score-year summaries (${d.scores.length})`);
const s1970 = d.scores.find((s) => s.year === 1970);
assert(s1970 !== undefined, "found 1970 score summary");
assert(s1970?.finalPlacement === 5, `1970 final placement = 5 (got ${s1970?.finalPlacement})`);
assert(s1970?.finalScore === 48.75, `1970 final score = 48.750 (got ${s1970?.finalScore})`);
assert(s1970?.highScore === 48.75, `1970 high score = 48.750 (got ${s1970?.highScore})`);
const s1972 = d.scores.find((s) => s.year === 1972);
assert(s1972?.scoreCount === 5, `1972 score count = 5 (got ${s1972?.scoreCount})`);
assert(s1972?.highScore === 71.8, `1972 high score = 71.800 (got ${s1972?.highScore})`);

// --- Members ---
console.log("\n5. Members (tab-5)");
assert(d.members.length > 50, `parsed members (${d.members.length})`);
const ann = d.members.find((m) => m.name === "Armstrong, Ann");
assert(ann !== undefined, "found member 'Armstrong, Ann'");
assert(ann?.memberId === "9526", `member id = 9526 (got ${ann?.memberId})`);
assert(ann?.role === "Mellophone", `role = Mellophone (got ${ann?.role})`);
assert(ann?.years === "1997; 2000", `years = '1997; 2000' (got ${ann?.years})`);
assert(
  d.members.every((m) => m.name.length > 0),
  "every member row has a non-empty name (no blank/icon rows)",
);

// --- Photos ---
console.log("\n6. Photo groups (tab-2)");
assert(d.photoGroups.length > 0, `parsed photo groups (${d.photoGroups.length})`);
const pg1970 = d.photoGroups.find((p) => p.year === 1970);
assert(pg1970 !== undefined, "found 1970 photo group");
assert(pg1970?.photoCount === 1, `1970 photo count = 1 (got ${pg1970?.photoCount})`);
assert(/pictures\/thumb\//.test(pg1970?.thumbUrl ?? ""), "1970 thumb url looks right");

// --- Robustness: degenerate inputs ---
console.log("\n7. Robustness (degenerate inputs)");
const empty = parseCorpsDetail("<html><body></body></html>", "999");
assert(empty.name === null, "empty page → name null (no throw)");
assert(empty.repertoire.length === 0, "empty page → no repertoire");
assert(empty.members.length === 0, "empty page → no members");
const garbage = parseCorpsDetail("<table><tr><td>oops", "x");
assert(Array.isArray(garbage.repertoire), "malformed html → still returns arrays");

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
