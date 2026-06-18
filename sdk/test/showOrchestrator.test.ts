// Tests for show orchestrator (pure functions: name normalization, mapping, show building).
//
// Run with: npx tsx test/showOrchestrator.test.ts

import {
  normalizeCorpsName,
  dcxNameToCorpsKey,
  makeShowId,
  buildShowFromDcx,
} from "../src/showOrchestrator.js";

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

console.log("=== Show Orchestrator Tests ===\n");

// --- Test 1: normalizeCorpsName ---
console.log("1. normalizeCorpsName");
assert(normalizeCorpsName("Blue Devils") === "bluedevils", "Blue Devils → bluedevils");
assert(normalizeCorpsName("The Cavaliers") === "cavaliers", "The Cavaliers → cavaliers");
assert(normalizeCorpsName("Cavaliers, The") === "cavaliers", "Cavaliers, The → cavaliers");
assert(normalizeCorpsName('Blue Devils "B"') === "bluedevilsb", 'Blue Devils "B" → bluedevilsb');
assert(normalizeCorpsName("7th Regiment") === "7thregiment", "7th Regiment → 7thregiment");
assert(normalizeCorpsName("Santa Clara Vanguard") === "santaclaravanguard", "Santa Clara Vanguard → santaclaravanguard");
assert(normalizeCorpsName("Boise Gems (*Open Class Affiliate)") === "boisegems", "Boise Gems (parens) → boisegems");
assert(normalizeCorpsName("The Academy") === "academy", "The Academy → academy");
assert(normalizeCorpsName("Academy, The") === "academy", "Academy, The → academy");
assert(normalizeCorpsName("Spirit of Atlanta") === "spiritofatlanta", "Spirit of Atlanta → spiritofatlanta");
assert(normalizeCorpsName("Crossmen") === "crossmen", "Crossmen → crossmen");
assert(normalizeCorpsName("Colt Cadets") === "coltcadets", "Colt Cadets → coltcadets");
assert(normalizeCorpsName("Genesis") === "genesis", "Genesis → genesis");
assert(normalizeCorpsName("Atlanta CV") === "atlantacv", "Atlanta CV → atlantacv");
assert(normalizeCorpsName("Hawthorne Caballeros") === "hawthornecaballeros", "Hawthorne Caballeros → hawthornecaballeros");
assert(normalizeCorpsName("Zephyrus") === "zephyrus", "Zephyrus → zephyrus");
assert(normalizeCorpsName("Seattle Cascades") === "seattlecascades", "Seattle Cascades → seattlecascades");

// --- Test 2: dcxNameToCorpsKey ---
console.log("\n2. dcxNameToCorpsKey");
const lookup = new Map<string, string>([
  ["bluedevils", "001j000000i6i9saav"],
  ["cavaliers", "001j000000iwxafaa1"],
  ["bluestars", "001j000000iwwsqaal"],
  ["academy", "001j000000iwxaeaa1"],
  ["crossmen", "001j000000iwx9aaat"],
  ["bushwackers", "bushwackers-drum-corps"],
]);

assert(dcxNameToCorpsKey("Blue Devils", lookup) === "001j000000i6i9saav", "Blue Devils → known key");
assert(dcxNameToCorpsKey("The Cavaliers", lookup) === "001j000000iwxafaa1", "The Cavaliers → known key");
assert(dcxNameToCorpsKey("Cavaliers, The", lookup) === "001j000000iwxafaa1", "Cavaliers, The → known key");
assert(dcxNameToCorpsKey("Unknown Corps", lookup) === null, "Unknown corps → null");
assert(dcxNameToCorpsKey("", lookup) === null, "Empty name → null");

// --- Test 3: makeShowId ---
console.log("\n3. makeShowId");
assert(makeShowId("001j000000i6i9saav", 2026) === "001j000000i6i9saav_2026", "ShowId format correct");
assert(makeShowId("zephyrus", 2026) === "zephyrus_2026", "ShowId for custom slug");

// --- Test 4: buildShowFromDcx ---
console.log("\n4. buildShowFromDcx");
const entry = {
  dcxCorpsName: "Crossmen",
  showTitle: "A Side/B Side",
  songs: ["Earth Song", "Last Train Home", "Mr. Pinstripe Suit", "Original music"],
  dcxCorpsId: "25",
  divisionSection: "Junior",
};
const show = buildShowFromDcx(entry, "001j000000iwx9aaat", 2026);

assert(show.showId === "001j000000iwx9aaat_2026", "showId is correct");
assert(show.corpsKey === "001j000000iwx9aaat", "corpsKey is correct");
assert(show.corpsName === "Crossmen", "corpsName is correct");
assert(show.season === "2026", "season is string '2026'");
assert(show.title === "A Side/B Side", "title is correct");
assert(show.repertoire.length === 4, `repertoire has 4 entries (got ${show.repertoire.length})`);
assert(show.repertoire[0].workTitle === "Earth Song", "First song = Earth Song");
assert(show.repertoire[0].entryId === "001j000000iwx9aaat_2026_song_0", "First entryId format correct");
assert(show.repertoire[3].workTitle === "Original music", "Last song = Original music");
assert(show.repertoire[3].composer === null, "Composer is null for unknown");
assert(show.designers.length === 0, "No designers yet");
assert(show.movements.length === 0, "No movements yet");
assert(show.media.length === 0, "No media yet");
assert(show.tags.length === 0, "No tags");
assert(show.metadata?.dcxCorpsId === "25", "Metadata has dcxCorpsId");

// No title entry
const noTitleEntry = {
  dcxCorpsName: "Blue Knights",
  showTitle: null,
  songs: [],
  dcxCorpsId: "34",
  divisionSection: "Junior",
};
const noTitleShow = buildShowFromDcx(noTitleEntry, "001j000000iwwsoaal", 2026);
assert(noTitleShow.title === "(No title yet)", "Null title becomes '(No title yet)'");
assert(noTitleShow.repertoire.length === 0, "No songs = empty repertoire");

// --- Summary ---
console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
