// Test agnostic show ID logic
// Usage: npx tsx scripts/testAgnosticShowId.ts

import * as fs from "node:fs";

const SHOW_INDEX_MAP: Record<string, number> = JSON.parse(
  fs.readFileSync("./src/training/showIndexMap.json", "utf-8")
);

const getAgnosticShowIdOld = (slug: string) => {
  const baseSlug = slug.replace(/-\d{4}$/, "");
  return SHOW_INDEX_MAP[baseSlug] ?? 0;
};

const getAgnosticShowIdNew = (slug: string) => {
  const baseSlug = slug.replace(/^\d{4}-/, "");
  return SHOW_INDEX_MAP[baseSlug] ?? 0;
};

console.log("Testing agnostic show ID extraction...\n");

const testSlugs = [
  "2022-dci-world-championship-semifinals",
  "2023-dci-world-championship-semifinals",
  "2024-dci-world-championship-semifinals",
  "2022-brass-impact",
  "2023-brass-impact",
  "2019-corps-at-the-crest-san-diego",
  "some-event-2022" // Edge case
];

console.log("OLD REGEX (/-\\d{4}$/):");
for (const slug of testSlugs) {
  const baseSlug = slug.replace(/-\d{4}$/, "");
  const id = getAgnosticShowIdOld(slug);
  console.log(`  ${slug} -> ${baseSlug} -> ID: ${id}`);
}

console.log("\nNEW REGEX (/^\\d{4}-/):");
for (const slug of testSlugs) {
  const baseSlug = slug.replace(/^\d{4}-/, "");
  const id = getAgnosticShowIdNew(slug);
  console.log(`  ${slug} -> ${baseSlug} -> ID: ${id}`);
}

// Test if different years map to same ID
console.log("\n=== VERIFICATION ===");
const id2022 = getAgnosticShowIdNew("2022-dci-world-championship-semifinals");
const id2023 = getAgnosticShowIdNew("2023-dci-world-championship-semifinals");
const id2024 = getAgnosticShowIdNew("2024-dci-world-championship-semifinals");

console.log(`2022 semifinals ID: ${id2022}`);
console.log(`2023 semifinals ID: ${id2023}`);
console.log(`2024 semifinals ID: ${id2024}`);

if (id2022 === id2023 && id2023 === id2024 && id2022 !== 0) {
  console.log("\n✅ All years of same event map to same agnostic ID!");
} else {
  console.log("\n❌ Different years have different IDs - logic is broken!");
}

// Check map keys
console.log(`\n=== SHOW_INDEX_MAP Sample ===`);
const sampleKeys = Object.keys(SHOW_INDEX_MAP).slice(0, 10);
console.log("Sample keys:");
for (const key of sampleKeys) {
  console.log(`  "${key}": ${SHOW_INDEX_MAP[key]}`);
}
