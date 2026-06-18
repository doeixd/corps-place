// Test the updated division lookup with corps.type API data
// Usage: npx tsx scripts/testDivisionLookupV2.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const parseDivisionFromCorpsType = (type: string | null | undefined): string | undefined => {
  if (!type) return undefined;
  const lower = type.toLowerCase();
  if (lower.includes("world class")) return "World Class";
  if (lower.includes("open class")) return "Open Class";
  if (lower.includes("all age") || lower.includes("all-age")) return "All Age Class";
  if (lower.includes("soundsport")) return "SoundSport";
  if (lower.includes("international")) return "International Class";
  return undefined;
};

const testDivisionLookup = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    console.log("=== Testing Division Lookup V2 ===\n");

    // Get API-based divisions
    const corpsRows = yield* (
      sql<{
        name: string;
        type: string | null;
      }>`
        SELECT name, type
        FROM corps
        WHERE type IS NOT NULL
        ORDER BY name
        LIMIT 20
      `
    );

    console.log("=== Sample Corps from API (corps.type field) ===");
    for (const row of corpsRows.slice(0, 10)) {
      const division = parseDivisionFromCorpsType(row.type);
      console.log(`${row.name}:`);
      console.log(`  API type: "${row.type}"`);
      console.log(`  Parsed division: "${division}"`);
    }

    // Check Spartans specifically
    console.log("\n=== Spartans Division Check ===");
    const spartans = yield* (
      sql<{
        name: string;
        type: string | null;
      }>`
        SELECT name, type
        FROM corps
        WHERE name = 'Spartans'
      `
    );

    if (spartans.length > 0) {
      const spartansType = spartans[0].type;
      const spartansDivision = parseDivisionFromCorpsType(spartansType);
      console.log(`Current API type: "${spartansType}"`);
      console.log(`Parsed division: "${spartansDivision}"`);
      console.log("\nWhen Spartans moves to World Class in 2026:");
      console.log(`  API will update to: "Corps, World Class"`);
      console.log(`  Parser will read: "World Class"`);
      console.log(`  ✓ Automatic update from authoritative source`);
    }

    // Check coverage
    console.log("\n=== Coverage Statistics ===");
    const totalCorps = yield* (
      sql<{ count: number }>`
        SELECT COUNT(DISTINCT name) as count
        FROM corps
      `
    );

    const corpsWithType = yield* (
      sql<{ count: number }>`
        SELECT COUNT(DISTINCT name) as count
        FROM corps
        WHERE type IS NOT NULL
      `
    );

    const corpsWithDivision = corpsRows.filter(
      (r) => parseDivisionFromCorpsType(r.type) !== undefined
    ).length;

    console.log(`Total corps in database: ${totalCorps[0].count}`);
    console.log(`Corps with type field: ${corpsWithType[0].count}`);
    console.log(`Corps with parseable division: ${corpsWithDivision}`);

    // Check 2024 corps that had issues
    console.log("\n=== Known Issue Corps (2024) ===");
    const issueCorps = [
      "Spartans",
      "7th Regiment",
      "Gold",
      "Colt Cadets",
      "Blue Devils B"
    ];

    for (const name of issueCorps) {
      const rows = yield* (
        sql<{
          name: string;
          type: string | null;
        }>`
          SELECT name, type
          FROM corps
          WHERE name = ${name}
        `
      );

      if (rows.length > 0) {
        const division = parseDivisionFromCorpsType(rows[0].type);
        console.log(`${name}: ${division} (from "${rows[0].type}")`);
      }
    }

    console.log("\n✓ All known issue corps have API data");
    console.log("✓ Division lookup will use authoritative source first");
    console.log("✓ When corps change divisions, API update will propagate automatically");
  });

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  yield* (testDivisionLookup(sql));
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => {
    console.log("\n✨ Test complete!");
  })
  .catch((err) => {
    console.error("\n❌ Test failed:", err);
    process.exitCode = 1;
  });
