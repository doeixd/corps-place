// Tests for the DCX asset/publication gallery parser against REAL saved pages
// (jackets memorabilia + DCW publications). Both rooms share the gallery layout.
//
// Run with: npx tsx test/parseAssets.test.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { parseAssetGallery, parseAssetPageChunks } from "../src/dcxScrape/parseAssets.js";

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

console.log("=== DCX asset/publication gallery parser ===\n");

// --- Memorabilia: jackets ---
console.log("1. Memorabilia (jackets)");
const jackets = parseAssetGallery(read("assets-jackets.html"));
assert(jackets.length >= 10, `parsed jacket items (${jackets.length})`);
const ja1 = jackets.find((j) => j.assetCode === "JA0001");
assert(ja1 !== undefined, "found asset JA0001");
assert(ja1?.title === "Specticale City Mariners", `title = "${ja1?.title}"`);
assert(ja1?.imageUrl === "assets/JA0001-.jpg", `image url = "${ja1?.imageUrl}"`);
assert(/thumbnail\/JA0001/.test(ja1?.thumbUrl ?? ""), "thumb url present");
assert(/Bill Ives Collection/.test(ja1?.caption ?? ""), "caption carries provenance text");
assert(ja1?.collection === "Bill Ives", `collection parsed = "${ja1?.collection}"`);
assert(
  ja1?.contributor === "Harry and Pat Shrot",
  `contributor parsed = "${ja1?.contributor}"`,
);
// Dedup: the "--2" alternate view must NOT create a second JA0001 row.
assert(jackets.filter((j) => j.assetCode === "JA0001").length === 1, "duplicate '--2' view deduped");

// --- Publications: DCW ---
console.log("\n2. Publications (DCW)");
const dcw = parseAssetGallery(read("publications-dcw.html"));
assert(dcw.length >= 10, `parsed DCW items (${dcw.length})`);
const xmas = dcw.find((d) => /Christmas Cover/.test(d.title ?? ""));
assert(xmas !== undefined, "found '1974 DCW Christmas Cover'");
assert(xmas?.year === 1974, `year parsed from title = 1974 (got ${xmas?.year})`);
assert(
  dcw.every((d) => d.imageUrl.startsWith("assets/")),
  "every item has an assets/ image url",
);
assert(
  dcw.every((d) => d.assetCode.length > 0),
  "every item has a non-empty asset code",
);

// --- Pagination ---
console.log("\n2b. Pagination (AssetPage chunks + a display page)");
const chunks = parseAssetPageChunks(read("assets-jackets-cfm.html"));
assert(chunks.length === 15, `jackets has 15 gallery pages (got ${chunks.length})`);
assert(/^[0-9,]+$/.test(chunks[0] ?? ""), "chunk is a comma list of ids");
assert((chunks[0]?.split(",").length ?? 0) === 20, "first page lists 20 ids");
const page2 = parseAssetGallery(read("assets-jackets-page2.html"));
assert(page2.length > 0, `display page parses cards (${page2.length})`);
const withCorps = page2.find((p) => p.corpsId !== null);
assert(withCorps !== undefined, "display-page card carries owning corps id");
assert(
  (withCorps?.corpsName?.length ?? 0) > 0,
  `card has corps name (e.g. "${withCorps?.corpsName}")`,
);

// --- Robustness ---
console.log("\n3. Robustness");
assert(parseAssetPageChunks("<html>no AssetPage here</html>").length === 0, "no AssetPage → empty chunks");
assert(parseAssetGallery("<html></html>").length === 0, "no gallery → empty array (no throw)");
assert(parseAssetGallery('<a class="swipebox" href="notassets/x.jpg">').length === 0, "non-asset hrefs ignored");

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
