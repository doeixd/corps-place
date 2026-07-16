import assert from "node:assert/strict";
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import { querySeasonCaptionsV10Clean } from "../src/mlQueries.js";

const valueAfter = (flag: string, fallback: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};

const dbPath = valueAfter("--db", "./dci-relational.db");
const season = valueAfter("--season", "2025");
const division = valueAfter("--division", "World Class");
const layer = LibsqlClient.layer({ url: `file:${dbPath}` });

const rows = await Effect.runPromise(
  querySeasonCaptionsV10Clean(season, division).pipe(Effect.provide(layer)),
);
assert(rows.length > 0, `No clean V10 rows for ${season} ${division}`);

const performances = new Map<string, typeof rows>();
for (const row of rows) {
  const key = `${row.slug}::${row.corps_key}`;
  const group = performances.get(key) ?? [];
  performances.set(key, [...group, row]);
  assert(row.rank >= 1 && row.rank <= 25, `${key}: invalid recomputed rank ${row.rank}`);
  assert(row.caption_rank >= 1, `${key}: invalid caption rank ${row.caption_rank}`);
}

const expectedCaptions = new Set([
  "General Effect 1", "General Effect 2", "Visual Proficiency", "Visual Analysis",
  "Color Guard", "Music - Brass", "Music - Analysis", "Music - Percussion",
]);
for (const [key, group] of performances) {
  assert.equal(group.length, 8, `${key}: expected 8 captions, got ${group.length}`);
  assert.deepEqual(new Set(group.map((row) => row.caption_name)), expectedCaptions, `${key}: caption set`);
}

process.stdout.write(
  `V10 clean-data contract verified: ${performances.size} performances, ${rows.length} caption rows (${season} ${division})\n`,
);
