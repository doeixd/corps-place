// Fix incorrectly classified corps divisions in the database
// This fixes corps that were assigned the wrong division due to mixed-division tables
// Usage: npx tsx scripts/fixIncorrectDivisions.ts [--season=2024] [--dryRun]

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const parseStringFlag = (args: string[], flag: string) => {
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const args = process.argv.slice(2);
const season = parseStringFlag(args, "--season") ?? "2024";
const dryRun = args.includes("--dryRun");

interface CorpsDivisionCount {
  corps_name: string;
  division_name: string;
  count: number;
}

interface IncorrectEntry {
  slug: string;
  corps_name: string;
  current_division: string;
  correct_division: string;
  rank: number;
}

const fixDivisions = (sql: SqlClient.SqlClient, targetSeason: string, dryRun: boolean) =>
  Effect.gen(function* () {
    console.log(`\n=== Analyzing ${targetSeason} Corps Divisions ===\n`);

    // Step 1: Build primary division map for each corps
    const divisionCounts = yield* (
      sql<CorpsDivisionCount>`
        SELECT
          corps_name,
          division_name,
          COUNT(*) as count
        FROM corps_scores
        WHERE competition_slug LIKE ${targetSeason + "-%"}
        GROUP BY corps_name, division_name
        ORDER BY corps_name, count DESC
      `
    );

    const primaryDivision = new Map<string, string>();
    const seen = new Set<string>();

    for (const row of divisionCounts) {
      const corpsLower = row.corps_name.toLowerCase().trim();
      if (!seen.has(corpsLower)) {
        primaryDivision.set(corpsLower, row.division_name);
        seen.add(corpsLower);
      }
    }

    console.log(`Built division map: ${primaryDivision.size} corps\n`);

    // Step 2: Find all corps_scores where division doesn't match primary
    const allScores = yield* (
      sql<{
        competition_slug: string;
        corps_name: string;
        division_name: string;
        rank: number;
      }>`
        SELECT competition_slug, corps_name, division_name, rank
        FROM corps_scores
        WHERE competition_slug LIKE ${targetSeason + "-%"}
        ORDER BY competition_slug, rank
      `
    );

    const incorrect: IncorrectEntry[] = [];

    for (const score of allScores) {
      const corpsLower = score.corps_name.toLowerCase().trim();
      const primary = primaryDivision.get(corpsLower);

      if (primary && primary !== score.division_name) {
        incorrect.push({
          slug: score.competition_slug,
          corps_name: score.corps_name,
          current_division: score.division_name,
          correct_division: primary,
          rank: score.rank
        });
      }
    }

    console.log(`Found ${incorrect.length} incorrectly classified entries\n`);

    if (incorrect.length === 0) {
      console.log("✅ No corrections needed!");
      return { updated: 0 };
    }

    // Group by corps for display
    const byCorps = new Map<string, IncorrectEntry[]>();
    for (const entry of incorrect) {
      const existing = byCorps.get(entry.corps_name) || [];
      existing.push(entry);
      byCorps.set(entry.corps_name, existing);
    }

    console.log("=== Incorrect Classifications ===\n");
    for (const [corps, entries] of byCorps) {
      const first = entries[0];
      console.log(`${corps}:`);
      console.log(`  Current: "${first.current_division}"`);
      console.log(`  Should be: "${first.correct_division}"`);
      console.log(`  Appears in ${entries.length} competition(s)`);
      console.log(`  Example: ${entries[0].slug}`);
      console.log();
    }

    if (dryRun) {
      console.log("🔍 DRY RUN - No changes made");
      console.log(`Would update ${incorrect.length} entries`);
      return { updated: 0 };
    }

    // Step 3: Update the database
    console.log("=== Updating Database ===\n");

    let updated = 0;
    for (const entry of incorrect) {
      yield* (
        sql`
          UPDATE corps_scores
          SET division_name = ${entry.correct_division}
          WHERE competition_slug = ${entry.slug}
            AND corps_name = ${entry.corps_name}
        `
      );
      updated++;

      if (updated % 10 === 0) {
        console.log(`Updated ${updated}/${incorrect.length}...`);
      }
    }

    console.log(`\n✅ Updated ${updated} entries`);

    // Step 4: Verify
    console.log("\n=== Verification ===\n");

    const remaining = yield* (
      sql<{ count: number }>`
        SELECT COUNT(*) as count
        FROM corps_scores cs
        WHERE competition_slug LIKE ${targetSeason + "-%"}
          AND division_name != (
            SELECT division_name
            FROM corps_scores cs2
            WHERE cs2.corps_name = cs.corps_name
              AND cs2.competition_slug LIKE ${targetSeason + "-%"}
            GROUP BY division_name
            ORDER BY COUNT(*) DESC
            LIMIT 1
          )
      `
    );

    const remainingCount = remaining[0]?.count ?? 0;

    if (remainingCount === 0) {
      console.log("✅ All divisions corrected!");
    } else {
      console.log(`⚠️  ${remainingCount} entries still incorrect (may need manual review)`);
    }

    return { updated };
  });

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("╔════════════════════════════════════════════════════╗");
  console.log("║  Fix Incorrect Corps Division Classifications     ║");
  console.log("╚════════════════════════════════════════════════════╝");

  if (dryRun) {
    console.log("\n🔍 DRY RUN MODE - No changes will be made\n");
  }

  const result = yield* (fixDivisions(sql, season, dryRun));

  console.log("\n=== Summary ===");
  console.log(`Season: ${season}`);
  console.log(`Entries updated: ${result.updated}`);
  console.log(`Dry run: ${dryRun}`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer)))
  .then(() => {
    console.log("\n✨ Done!");
  })
  .catch((err) => {
    console.error("\n❌ Fix failed:", err);
    process.exitCode = 1;
  });
