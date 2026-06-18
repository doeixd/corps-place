// Tests for the photo-room parser against a REAL saved page (historical photos).
//
// Run with: npx tsx test/parsePhotos.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { parsePhotoRoom } from "../src/dcxScrape/parsePhotos.js";

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

const html = fs.readFileSync(
  path.join(process.cwd(), "test", "fixtures", "dcx", "photos-historical.html"),
  "utf8",
);
const groups = parsePhotoRoom(html);

console.log("=== Photo-room parser (historical) ===\n");
assert(groups.length > 5, `parsed photo groups (${groups.length})`);

const y1894 = groups.find((g) => g.year === 1894);
assert(y1894 !== undefined, "found 1894 group");
assert(y1894?.photoCount === 1, `1894 count = 1 (got ${y1894?.photoCount})`);
assert(/pictures\/thumb\//.test(y1894?.thumbUrl ?? ""), "1894 thumb url present");

const big = groups.find((g) => g.year === 0);
assert(big !== undefined, "found year=0 (unspecified) group");
assert((big?.photoCount ?? 0) > 100, `year-0 has a large count (got ${big?.photoCount})`);

assert(
  groups.every((g) => g.photoCount !== null || g.thumbUrl !== null),
  "every group has a count or a thumb",
);

// Robustness
assert(parsePhotoRoom("<html></html>").length === 0, "no photos → empty (no throw)");

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
