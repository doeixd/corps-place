import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';

const analyze2025 = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  console.log('=== 2025 DATA OVERVIEW ===\n');

  // Check competitions table for 2025
  const compCount = yield* (sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt FROM competitions WHERE season = '2025'
  `);
  console.log(`Competitions: ${compCount[0]?.cnt ?? 0} rows`);

  // Check corps_scores via join
  const corpsScoresCount = yield* (sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt 
    FROM corps_scores cs
    JOIN competitions c ON cs.competition_slug = c.slug
    WHERE c.season = '2025'
  `);
  console.log(`Corps Scores: ${corpsScoresCount[0]?.cnt ?? 0} rows`);

  // Check caption_scores via join
  const captionCount = yield* (sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt 
    FROM caption_scores cap
    JOIN competitions c ON cap.competition_slug = c.slug
    WHERE c.season = '2025'
  `);
  console.log(`Caption Scores: ${captionCount[0]?.cnt ?? 0} rows`);

  // Check subcaption_scores via join
  const subcaptionCount = yield* (sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt 
    FROM subcaption_scores sub
    JOIN competitions c ON sub.competition_slug = c.slug
    WHERE c.season = '2025'
  `);
  console.log(`Subcaption Scores: ${subcaptionCount[0]?.cnt ?? 0} rows`);

  console.log('\n=== COMPETITIONS IN 2025 ===');
  const comps = yield* (sql<{
    slug: string;
    event_name: string;
    date: string;
    scores_released: number;
    recap_released: number;
  }>`
    SELECT slug, event_name, date, scores_released, recap_released
    FROM competitions 
    WHERE season = '2025' 
    ORDER BY date
  `);
  if (comps.length === 0) {
    console.log('  No competitions found for 2025');
  } else {
    comps.slice(0, 15).forEach(c => console.log(`  ${c.date} | ${c.slug} | scores:${c.scores_released} recap:${c.recap_released}`));
    if (comps.length > 15) {
      console.log(`  ... and ${comps.length - 15} more`);
    }
    console.log(`  Total: ${comps.length} competitions`);
  }

  console.log('\n=== CORPS WITH 2025 SCORES ===');
  const corps = yield* (sql<{
    corps_key: string;
    division_name: string | null;
    shows: number;
    avg_total: number | null;
    min_total: number | null;
    max_total: number | null;
  }>`
    SELECT 
      cs.corps_key,
      cs.division_name,
      COUNT(*) as shows,
      AVG(cs.total_score) as avg_total,
      MIN(cs.total_score) as min_total,
      MAX(cs.total_score) as max_total
    FROM corps_scores cs
    JOIN competitions c ON cs.competition_slug = c.slug
    WHERE c.season = '2025'
    GROUP BY cs.corps_key
    ORDER BY avg_total DESC
    LIMIT 30
  `);
  if (corps.length === 0) {
    console.log('  No corps scores found for 2025');
  } else {
    corps.forEach(c => console.log(`  ${c.corps_key} (${c.division_name ?? '?'}): ${c.shows} shows, ${c.min_total?.toFixed(1) ?? '?'} - ${c.max_total?.toFixed(1) ?? '?'}, avg: ${c.avg_total?.toFixed(1) ?? '?'}`));
  }

  console.log('\n=== SCORE QUALITY CHECK ===');
  const scoreStats = yield* (sql<{
    total_scores: number;
    competitions: number;
    corps_count: number;
    min_total: number | null;
    max_total: number | null;
    avg_total: number | null;
    null_totals: number;
  }>`
    SELECT 
      COUNT(*) as total_scores,
      COUNT(DISTINCT cs.competition_slug) as competitions,
      COUNT(DISTINCT cs.corps_key) as corps_count,
      MIN(cs.total_score) as min_total,
      MAX(cs.total_score) as max_total,
      AVG(cs.total_score) as avg_total,
      SUM(CASE WHEN cs.total_score IS NULL THEN 1 ELSE 0 END) as null_totals
    FROM corps_scores cs
    JOIN competitions c ON cs.competition_slug = c.slug
    WHERE c.season = '2025'
  `);
  const stats = scoreStats[0];
  if (stats && stats.total_scores > 0) {
    console.log(`  Total score rows: ${stats.total_scores}`);
    console.log(`  Competitions with scores: ${stats.competitions}`);
    console.log(`  Corps with scores: ${stats.corps_count}`);
    console.log(`  Score range: ${stats.min_total?.toFixed(2)} - ${stats.max_total?.toFixed(2)}`);
    console.log(`  Average total: ${stats.avg_total?.toFixed(2)}`);
    console.log(`  Null totals: ${stats.null_totals}`);
  } else {
    console.log('  No scores found for 2025');
  }

  console.log('\n=== CAPTION SCORES BREAKDOWN ===');
  const captions = yield* (sql<{
    caption_name: string;
    cnt: number;
    avg_score: number | null;
    min_score: number | null;
    max_score: number | null;
  }>`
    SELECT 
      cap.caption_name, 
      COUNT(*) as cnt, 
      AVG(cap.score) as avg_score,
      MIN(cap.score) as min_score,
      MAX(cap.score) as max_score
    FROM caption_scores cap
    JOIN competitions c ON cap.competition_slug = c.slug
    WHERE c.season = '2025'
    GROUP BY cap.caption_name
    ORDER BY cnt DESC
  `);
  if (captions.length === 0) {
    console.log('  No caption scores found');
  } else {
    captions.forEach(c => console.log(`  ${c.caption_name}: ${c.cnt} rows (${c.min_score?.toFixed(2) ?? '?'} - ${c.max_score?.toFixed(2) ?? '?'}, avg: ${c.avg_score?.toFixed(2) ?? 'N/A'})`));
  }

  console.log('\n=== DIVISION BREAKDOWN ===');
  const divisions = yield* (sql<{
    division_name: string;
    corps_count: number;
    score_rows: number;
    avg_total: number | null;
  }>`
    SELECT 
      cs.division_name, 
      COUNT(DISTINCT cs.corps_key) as corps_count, 
      COUNT(*) as score_rows,
      AVG(cs.total_score) as avg_total
    FROM corps_scores cs
    JOIN competitions c ON cs.competition_slug = c.slug
    WHERE c.season = '2025'
    GROUP BY cs.division_name
  `);
  if (divisions.length === 0) {
    console.log('  No divisions found');
  } else {
    divisions.forEach(d => console.log(`  ${d.division_name ?? 'Unknown'}: ${d.corps_count} corps, ${d.score_rows} scores (avg: ${d.avg_total?.toFixed(1) ?? '?'})`));
  }

  // Check for data completeness - do corps_scores have matching caption data?
  console.log('\n=== DATA COMPLETENESS CHECK ===');
  const orphanScores = yield* (sql<{ cnt: number }>`
    SELECT COUNT(*) as cnt
    FROM corps_scores cs
    JOIN competitions c ON cs.competition_slug = c.slug
    WHERE c.season = '2025'
    AND NOT EXISTS (
      SELECT 1 FROM caption_scores cap 
      WHERE cap.competition_slug = cs.competition_slug 
      AND cap.corps_key = cs.corps_key
    )
  `);
  console.log(`  Corps scores without caption data: ${orphanScores[0]?.cnt ?? 0}`);

  // Check expected 8 captions per score
  const captionCoverage = yield* (sql<{
    captions_per_score: number;
    count: number;
  }>`
    SELECT caption_count as captions_per_score, COUNT(*) as count FROM (
      SELECT cs.competition_slug, cs.corps_key, COUNT(cap.caption_name) as caption_count
      FROM corps_scores cs
      JOIN competitions c ON cs.competition_slug = c.slug
      LEFT JOIN caption_scores cap 
        ON cap.competition_slug = cs.competition_slug 
        AND cap.corps_key = cs.corps_key
      WHERE c.season = '2025'
      GROUP BY cs.competition_slug, cs.corps_key
    )
    GROUP BY caption_count
    ORDER BY caption_count
  `);
  console.log('  Caption coverage per score entry:');
  captionCoverage.forEach(c => console.log(`    ${c.captions_per_score} captions: ${c.count} entries`));

  // Check for judge assignments
  console.log('\n=== JUDGE ASSIGNMENTS ===');
  const judgeAssignments = yield* (sql<{ cnt: number; judges: number }>`
    SELECT COUNT(*) as cnt, COUNT(DISTINCT ja.judge_id) as judges
    FROM judge_assignments ja
    JOIN competitions c ON ja.competition_slug = c.slug
    WHERE c.season = '2025'
  `);
  console.log(`  Judge assignments: ${judgeAssignments[0]?.cnt ?? 0}`);
  console.log(`  Unique judges: ${judgeAssignments[0]?.judges ?? 0}`);

  // Date range check
  console.log('\n=== DATE RANGE ===');
  const dateRange = yield* (sql<{ earliest: string | null; latest: string | null }>`
    SELECT MIN(date) as earliest, MAX(date) as latest
    FROM competitions
    WHERE season = '2025'
  `);
  console.log(`  Earliest: ${dateRange[0]?.earliest ?? 'N/A'}`);
  console.log(`  Latest: ${dateRange[0]?.latest ?? 'N/A'}`);

  // Check if we have finals data
  console.log('\n=== FINALS DATA CHECK ===');
  const finalsComps = yield* (sql<{ slug: string; date: string; event_name: string }>`
    SELECT slug, date, event_name
    FROM competitions
    WHERE season = '2025' 
    AND (LOWER(slug) LIKE '%finals%' OR LOWER(event_name) LIKE '%finals%')
    ORDER BY date
  `);
  if (finalsComps.length === 0) {
    console.log('  No finals competitions found yet');
  } else {
    finalsComps.forEach(f => console.log(`  ${f.date} | ${f.slug} | ${f.event_name}`));
  }

  // Summary recommendation
  console.log('\n=== SUMMARY & RECOMMENDATION ===');
  const hasScores = (corpsScoresCount[0]?.cnt ?? 0) > 0;
  const hasCaptions = (captionCount[0]?.cnt ?? 0) > 0;
  const hasComps = (compCount[0]?.cnt ?? 0) > 0;
  const hasFinals = finalsComps.length > 0;

  if (!hasScores && !hasComps) {
    console.log('  ❌ NO 2025 DATA FOUND - Cannot use for testing');
    console.log('  → Need to run data ingestion/scraping for 2025 season');
  } else if (!hasCaptions) {
    console.log('  ⚠️  2025 has basic scores but NO CAPTION DATA - Limited usefulness');
    console.log('  → Caption data needed for full model evaluation');
  } else if (!hasFinals) {
    console.log('  ⚠️  2025 data exists but NO FINALS YET - Can use for early-season validation');
    console.log('  → Use 2024 Finals for holdout test, 2025 for additional validation');
    console.log(`  → Current coverage: ${stats?.total_scores ?? 0} scores, ${stats?.competitions ?? 0} shows, ${stats?.corps_count ?? 0} corps`);
  } else {
    const captionRatio = (captionCount[0]?.cnt ?? 0) / Math.max(1, (corpsScoresCount[0]?.cnt ?? 1));
    if (captionRatio < 6) {
      console.log('  ⚠️  2025 data appears INCOMPLETE - Caption/score ratio is low');
    } else {
      console.log('  ✓ 2025 data appears COMPLETE and usable for testing');
      console.log(`  → ${stats?.total_scores ?? 0} score entries across ${stats?.competitions ?? 0} competitions`);
      console.log(`  → ${stats?.corps_count ?? 0} corps with data`);
    }
  }
});

const SqlLayer = LibsqlClient.layer({ url: 'file:./dci-relational.db' });

Effect.runPromise(analyze2025.pipe(Effect.provide(SqlLayer)))
  .then(() => console.log('\n✓ Analysis complete.'))
  .catch(console.error);
