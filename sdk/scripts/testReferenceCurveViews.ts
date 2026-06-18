import { createClient } from '@libsql/client';

const DB_PATH = './dci-relational.db';
const METRICS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP', 'TOTAL'];

type Check = {
  name: string;
  value: number | string;
  ok: boolean;
};

const client = createClient({ url: `file:${DB_PATH}` });

const scalar = async (sql: string) => {
  const result = await client.execute(sql);
  return Number(Object.values(result.rows[0] ?? { count: 0 })[0] ?? 0);
};

const main = async () => {
  const checks: Check[] = [];

  const viewCount = await scalar(`
    SELECT COUNT(*)
    FROM sqlite_master
    WHERE type = 'view'
      AND name IN (
        'clean_reference_curve_entries',
        'clean_reference_curve_metric_scores',
        'reference_curve_metric_stats'
      )
  `);
  checks.push({ name: 'views_exist', value: viewCount, ok: viewCount === 3 });

  const entryCount = await scalar('SELECT COUNT(*) FROM clean_reference_curve_entries');
  checks.push({ name: 'clean_entry_count', value: entryCount, ok: entryCount > 0 });

  const metricCount = await scalar('SELECT COUNT(*) FROM clean_reference_curve_metric_scores');
  checks.push({
    name: 'metric_row_count',
    value: metricCount,
    ok: metricCount === entryCount * METRICS.length,
  });

  checks.push({
    name: 'invalid_entry_dimensions',
    value: await scalar(`
      SELECT COUNT(*)
      FROM clean_reference_curve_entries
      WHERE division_name NOT IN ('World Class', 'Open Class')
         OR rank_bucket < 1
         OR rank_bucket > 25
         OR percent_bucket < 0
         OR percent_bucket > 100
         OR percent_bucket % 5 != 0
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'bad_caption_totals',
    value: await scalar(`
      SELECT COUNT(*)
      FROM clean_reference_curve_entries
      WHERE ABS(caption_total - total_score) > 0.05
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'duplicate_entries',
    value: await scalar(`
      SELECT COUNT(*)
      FROM (
        SELECT competition_slug, division_name, corps_key
        FROM clean_reference_curve_entries
        GROUP BY competition_slug, division_name, corps_key
        HAVING COUNT(*) > 1
      )
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'rank_total_inversions',
    value: await scalar(`
      SELECT COUNT(*)
      FROM clean_reference_curve_entries better
      JOIN clean_reference_curve_entries worse
        ON worse.competition_slug = better.competition_slug
       AND worse.division_name = better.division_name
       AND worse.computed_rank > better.computed_rank
      WHERE worse.total_score > better.total_score
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'invalid_metric_rows',
    value: await scalar(`
      SELECT COUNT(*)
      FROM clean_reference_curve_metric_scores
      WHERE metric_name NOT IN ('GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP', 'TOTAL')
         OR score <= 0
         OR (metric_name != 'TOTAL' AND score > 20)
         OR (metric_name = 'TOTAL' AND score > 100)
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'invalid_stat_ranges',
    value: await scalar(`
      SELECT COUNT(*)
      FROM reference_curve_metric_stats
      WHERE sample_count <= 0
         OR min_score > avg_score
         OR avg_score > max_score
         OR metric_name NOT IN ('GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP', 'TOTAL')
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'stats_aggregate_mismatches',
    value: await scalar(`
      WITH expected AS (
        SELECT
          division_name,
          rank_bucket,
          percent_bucket,
          metric_name,
          AVG(score) AS avg_score,
          MIN(score) AS min_score,
          MAX(score) AS max_score,
          COUNT(*) AS sample_count
        FROM clean_reference_curve_metric_scores
        GROUP BY division_name, rank_bucket, percent_bucket, metric_name
      )
      SELECT COUNT(*)
      FROM expected e
      JOIN reference_curve_metric_stats s
        ON s.division_name = e.division_name
       AND s.rank_bucket = e.rank_bucket
       AND s.percent_bucket = e.percent_bucket
       AND s.metric_name = e.metric_name
      WHERE ABS(s.avg_score - e.avg_score) > 0.000001
         OR ABS(s.min_score - e.min_score) > 0.000001
         OR ABS(s.max_score - e.max_score) > 0.000001
         OR s.sample_count != e.sample_count
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  console.table(checks);
  await client.close();

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(
      `Reference curve view tests failed: ${failed.map((check) => check.name).join(', ')}`
    );
    process.exitCode = 1;
  } else {
    console.log('Reference curve view tests passed.');
  }
};

main().catch(async (error) => {
  console.error(error);
  await client.close();
  process.exitCode = 1;
});
