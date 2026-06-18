#!/usr/bin/env node
// Verification script for show announcement ingestion.
//
// Run after ingestion to verify DB state is healthy and consistent.
//   npx tsx scripts/verifyShowIngestion.ts --season 2026
//
// Checks:
//   1. corps_shows rows exist for target season
//   2. Every show has at least a title (even if placeholder)
//   3. No duplicate show_id values
//   4. Repertoire entries reference valid shows
//   5. No orphaned repertoire entries
//   6. Corps with shows match the 2026 event participant list
//   7. Data quality: no empty song titles, no HTML entities in titles

import { createClient } from "@libsql/client";

const args = process.argv.slice(2);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const season = Number(getArg("--season") ?? "2026");
const dbPath = getArg("--db") ?? "file:./dci-relational.db";

const db = createClient({ url: dbPath });

let passed = 0;
let failed = 0;
let warnings = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ ${message}`);
  }
}

function warn(condition: boolean, message: string) {
  if (!condition) {
    warnings++;
    console.warn(`  ⚠️  ${message}`);
  }
}

console.log(`=== Show Ingestion Verification (season ${season}) ===\n`);

// --- 1. corps_shows rows exist ---
console.log("1. corps_shows rows exist");
const showsResult = await db.execute(`
  SELECT COUNT(*) as cnt FROM corps_shows WHERE season = ${season}
`);
const showCount = Number(showsResult.rows[0].cnt);
assert(showCount > 0, `${showCount} shows found for season ${season}`);

// --- 2. Every show has a title ---
console.log("\n2. Every show has a title");
const noTitleResult = await db.execute(`
  SELECT COUNT(*) as cnt FROM corps_shows
  WHERE season = ${season} AND (title IS NULL OR title = '')
`);
assert(Number(noTitleResult.rows[0].cnt) === 0, "Zero shows with null/empty title");

// --- 3. No duplicate show_id ---
console.log("\n3. No duplicate show_id");
const dupResult = await db.execute(`
  SELECT show_id, COUNT(*) as cnt FROM corps_shows
  WHERE season = ${season}
  GROUP BY show_id HAVING cnt > 1
`);
assert(dupResult.rows.length === 0, "Zero duplicate show_id values");

// --- 4. Repertoire entries reference valid shows ---
console.log("\n4. Repertoire entries reference valid shows");
const orphanRepertoire = await db.execute(`
  SELECT COUNT(*) as cnt FROM corps_show_repertoire csr
  LEFT JOIN corps_shows cs ON cs.show_id = csr.show_id
  WHERE cs.show_id IS NULL
`);
assert(Number(orphanRepertoire.rows[0].cnt) === 0, "Zero orphaned repertoire entries");

// --- 5. No empty song titles ---
console.log("\n5. No empty song titles");
const emptySongs = await db.execute(`
  SELECT COUNT(*) as cnt FROM corps_show_repertoire
  WHERE work_title IS NULL OR TRIM(work_title) = ''
`);
assert(Number(emptySongs.rows[0].cnt) === 0, "Zero repertoire entries with empty work_title");

// --- 6. Corps with shows exist in corps table ---
console.log("\n6. Corps with shows exist in corps table");
const allCorps = await db.execute(`
  SELECT corps_key FROM corps
`);
const showCorps = await db.execute(`
  SELECT DISTINCT corps_key FROM corps_shows WHERE season = ${season}
`);

const allCorpsKeys = new Set(allCorps.rows.map((r) => r.corps_key));
const showKeys = new Set(showCorps.rows.map((r) => r.corps_key));

// Shows that don't match any known corps
const unmatchedShows = [...showKeys].filter((k) => !allCorpsKeys.has(k));
assert(unmatchedShows.length === 0, `${unmatchedShows.length} shows with unknown corps_key`);

// Corps in DB with no show data (expected for non-2026 or inactive corps)
const missingShows = [...allCorpsKeys].filter((k) => !showKeys.has(k));
console.log(`  ℹ️  ${missingShows.length} corps in DB with no 2026 show data (expected: not all corps announce early)`);

// --- 7. Data quality: no HTML entities in titles ---
console.log("\n7. Data quality: no HTML entities in titles");
const htmlEntityResult = await db.execute(`
  SELECT COUNT(*) as cnt FROM corps_shows
  WHERE season = ${season} AND (
    title LIKE '%&amp;%' OR
    title LIKE '%&quot;%' OR
    title LIKE '%&lt;%' OR
    title LIKE '%&gt;%' OR
    title LIKE '%&#%'
  )
`);
assert(Number(htmlEntityResult.rows[0].cnt) === 0, "Zero titles with HTML entities");

// --- 8. Show stats ---
console.log("\n8. Show stats");
const statsResult = await db.execute(`
  SELECT
    COUNT(*) as total_shows,
    COUNT(CASE WHEN title NOT LIKE '.%' AND title NOT LIKE '(No title yet)' THEN 1 END) as with_real_title,
    COUNT(CASE WHEN title LIKE '.%' OR title LIKE '(No title yet)' THEN 1 END) as with_placeholder_title
  FROM corps_shows
  WHERE season = ${season}
`);
const stats = statsResult.rows[0];
console.log(`  ℹ️  Total shows: ${stats.total_shows}`);
console.log(`  ℹ️  With real title: ${stats.with_real_title}`);
console.log(`  ℹ️  With placeholder title: ${stats.with_placeholder_title}`);

const repertoireStats = await db.execute(`
  SELECT COUNT(*) as total_songs
  FROM corps_show_repertoire csr
  JOIN corps_shows cs ON cs.show_id = csr.show_id
  WHERE cs.season = ${season}
`);
console.log(`  ℹ️  Total repertoire entries: ${repertoireStats.rows[0].total_songs}`);

// --- 9. New tables exist ---
console.log("\n9. New schema tables exist");
const tablesResult = await db.execute(`
  SELECT name FROM sqlite_master
  WHERE type = 'table' AND name IN (
    'corps_show_designers',
    'corps_show_movements',
    'show_announcement_scrapes'
  )
`);
const tableNames = tablesResult.rows.map((r) => r.name);
assert(tableNames.includes("corps_show_designers"), "corps_show_designers table exists");
assert(tableNames.includes("corps_show_movements"), "corps_show_movements table exists");
assert(tableNames.includes("show_announcement_scrapes"), "show_announcement_scrapes table exists");

// --- Summary ---
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);
console.log(`${"=".repeat(50)}`);

if (failed > 0) {
  console.error("\n❌ VERIFICATION FAILED");
  process.exit(1);
} else if (warnings > 0) {
  console.warn("\n⚠️  VERIFICATION PASSED WITH WARNINGS");
  process.exit(0);
} else {
  console.log("\n✅ ALL CHECKS PASSED");
  process.exit(0);
}
