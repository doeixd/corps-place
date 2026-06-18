// Test temporal feature calculations in ML sequences
// Usage: npx tsx scripts/testTemporalFeatures.ts

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const main = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log("Testing temporal feature calculations...\n");

  // Get a sample corps with multiple shows in a season
  const shows = yield* (sql<{
    corps_key: string;
    corps_name: string;
    competition_slug: string;
    date: string;
    percent_through: number;
    rank: number;
    total_score: number;
  }>`
    SELECT
      cs.corps_key,
      cs.corps_name,
      cs.competition_slug,
      c.date,
      c.percent_through,
      cs.rank,
      cs.total_score
    FROM corps_scores cs
    JOIN competitions c ON c.slug = cs.competition_slug
    WHERE c.season = '2024'
      AND cs.division_name = 'World Class'
      AND cs.corps_key = '001j000000iwwsraal'
    ORDER BY c.date ASC
  `);

  console.log(`Found ${shows.length} shows for Bluecoats 2024\n`);

  // Get season boundaries
  const seasonMeta = yield* (sql<{
    first_date: string;
    last_date: string;
    season_length: number;
  }>`
    SELECT
      MIN(date) as first_date,
      MAX(date) as last_date,
      JULIANDAY(MAX(date)) - JULIANDAY(MIN(date)) as season_length
    FROM competitions
    WHERE season = '2024'
  `);

  const firstDate = new Date(seasonMeta[0].first_date);
  const lastDate = new Date(seasonMeta[0].last_date);
  const seasonLength = seasonMeta[0].season_length;

  console.log("Season boundaries:");
  console.log(`  First show: ${seasonMeta[0].first_date}`);
  console.log(`  Last show (finals): ${seasonMeta[0].last_date}`);
  console.log(`  Season length: ${seasonLength} days\n`);

  console.log("Verifying temporal features for each show:\n");
  console.log("Show# | Date       | %Season | Days  | Calc% | Match");
  console.log("------|------------|---------|-------|-------|------");

  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    const showDate = new Date(show.date);

    // Calculate what percent_through SHOULD be
    const daysSinceStart = (showDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24);
    const calculatedPercent = (daysSinceStart / seasonLength) * 100;

    // Compare with DB value
    const match = Math.abs(calculatedPercent - show.percent_through) < 0.1 ? "✓" : "✗";

    const showNum = (i + 1).toString().padStart(5, " ");
    const dateStr = show.date.padEnd(10, " ");
    const dbPercent = show.percent_through.toFixed(1).padStart(7, " ");
    const days = daysSinceStart.toFixed(0).padStart(5, " ");
    const calcPercent = calculatedPercent.toFixed(1).padStart(5, " ");

    console.log(`${showNum} | ${dateStr} | ${dbPercent}% | ${days} | ${calcPercent}% | ${match}`);
  }

  // Now simulate the sequence building logic
  console.log("\n\nSimulating sequence builder logic for show #13:");
  console.log("(Predicting show 13 using shows 1-12 as history)\n");

  const targetIdx = 12; // 13th show (0-based index 12)
  const pastShows = shows.slice(0, targetIdx);
  const targetShow = shows[targetIdx];

  console.log(`Target show: ${targetShow.competition_slug}`);
  console.log(`Target date: ${targetShow.date}`);
  console.log(`Past shows count: ${pastShows.length}\n`);

  const seasonStartDate = pastShows[0]?.date ?? targetShow.date;
  const pastCount = pastShows.length || 1;

  console.log("Feature calculations for each timestep:");
  console.log("Step | Show Date  | %Season | DaysSince | ShowIdx/Count | Remaining | ShowsLeft");
  console.log("-----|------------|---------|-----------|---------------|-----------|----------");

  const SEQ_LEN = 12;
  for (let j = 0; j < Math.min(SEQ_LEN, pastCount); j++) {
    const showIdx = pastShows.length - (SEQ_LEN - j);
    if (showIdx < 0) continue;

    const show = pastShows[showIdx];
    const prevShow = showIdx > 0 ? pastShows[showIdx - 1] : null;

    // Features from the code
    const percentThroughFeature = show.percent_through / 100;

    const showDate = new Date(show.date);
    const corpsStartDate = new Date(seasonStartDate);
    const daysSinceCorpsStart = (showDate.getTime() - corpsStartDate.getTime()) / (1000 * 60 * 60 * 24);

    const showIdxNorm = (showIdx + 1) / pastCount;
    const remainingNorm = (pastCount - (showIdx + 1)) / pastCount;

    // Calculate actual shows left in season
    const daysTillFinals = (lastDate.getTime() - showDate.getTime()) / (1000 * 60 * 60 * 24);

    const stepNum = (j + 1).toString().padStart(4, " ");
    const dateStr = show.date.padEnd(10, " ");
    const pctSeason = percentThroughFeature.toFixed(2).padStart(7, " ");
    const daysSince = daysSinceCorpsStart.toFixed(0).padStart(9, " ");
    const idxNorm = showIdxNorm.toFixed(2).padStart(13, " ");
    const remNorm = remainingNorm.toFixed(2).padStart(9, " ");
    const daysLeft = daysTillFinals.toFixed(0).padStart(9, " ");

    console.log(`${stepNum} | ${dateStr} | ${pctSeason} | ${daysSince} | ${idxNorm} | ${remNorm} | ${daysLeft}`);
  }

  console.log("\n\n=== ANALYSIS ===");
  console.log("1. percent_through: Uses DB field, represents % through SEASON (correct)");
  console.log("2. daysSince: Days since THIS CORPS' first show (not season start)");
  console.log("3. showIdx/pastCount: Position in sequence / total shows SO FAR");
  console.log("4. remaining: (pastCount - showIdx) / pastCount");
  console.log("   → This is NOT 'shows left in season'");
  console.log("   → It's 'how far back in the sequence are we'");
  console.log("   → At most recent timestep, this is 0 (0 shows between then and now)");
  console.log("\n5. POTENTIAL ISSUE: 'remaining' doesn't capture future shows");
  console.log("   → Should we use days_till_finals or %season instead?");

  console.log("\n=== VERIFICATION NEEDED ===");
  console.log("Check if 'remaining' feature semantic matches intended use:");
  console.log("  - Current: How many MORE past shows are in the sequence");
  console.log("  - Expected: How many shows left until finals?");
  console.log("  - Or: How complete is this corps' season trajectory?");
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("Test failed:", error);
  process.exitCode = 1;
});
