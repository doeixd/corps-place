import { createClient } from '@libsql/client';

const DB_PATH = './dci-relational.db';

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

  const domainTableCount = await scalar(`
    SELECT COUNT(*)
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'domain_divisions',
        'domain_captions',
        'domain_caption_aliases',
        'domain_event_exclusion_patterns'
      )
  `);
  checks.push({ name: 'domain_tables_exist', value: domainTableCount, ok: domainTableCount === 4 });

  const dqViewCount = await scalar(`
    SELECT COUNT(*)
    FROM sqlite_master
    WHERE type = 'view'
      AND name IN (
        'dq_zero_scores',
        'dq_invalid_caption_scores',
        'dq_missing_caption_panels',
        'dq_caption_total_mismatches',
        'dq_unknown_judges',
        'dq_showcase_rows',
        'dq_rank_inversions',
        'dq_duplicate_score_entries'
      )
  `);
  checks.push({ name: 'dq_views_exist', value: dqViewCount, ok: dqViewCount === 8 });

  checks.push({
    name: 'model_division_count',
    value: await scalar('SELECT COUNT(*) FROM domain_divisions WHERE is_model_division = 1'),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 2;

  checks.push({
    name: 'canonical_caption_count',
    value: await scalar('SELECT COUNT(*) FROM domain_captions'),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 8;

  checks.push({
    name: 'caption_alias_count',
    value: await scalar('SELECT COUNT(*) FROM domain_caption_aliases'),
    ok: true,
  });
  checks[checks.length - 1]!.ok = Number(checks[checks.length - 1]!.value) >= 13;

  checks.push({
    name: 'caption_weight_sum',
    value: await scalar('SELECT SUM(total_weight) FROM domain_captions'),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 5;

  checks.push({
    name: 'alias_orphans',
    value: await scalar(`
      SELECT COUNT(*)
      FROM domain_caption_aliases dca
      LEFT JOIN domain_captions dc ON dc.caption_key = dca.caption_key
      WHERE dc.caption_key IS NULL
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'clean_entries_match_ml_rows',
    value: await scalar(`
      SELECT ABS(
        (SELECT COUNT(*) FROM clean_reference_curve_entries) -
        (SELECT COUNT(*) FROM ml_sequence_rows_v9_subcaption)
      )
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'dq_duplicate_score_entries',
    value: await scalar('SELECT COUNT(*) FROM dq_duplicate_score_entries'),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'clean_entries_in_dq_zero_scores',
    value: await scalar(`
      SELECT COUNT(*)
      FROM clean_reference_curve_entries clean
      JOIN dq_zero_scores dq
        ON dq.competition_slug = clean.competition_slug
       AND dq.corps_key = clean.corps_key
       AND dq.division_name = clean.division_name
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'clean_entries_in_dq_showcase_rows',
    value: await scalar(`
      SELECT COUNT(*)
      FROM clean_reference_curve_entries clean
      JOIN dq_showcase_rows dq
        ON dq.competition_slug = clean.competition_slug
       AND dq.corps_key = clean.corps_key
       AND dq.division_name = clean.division_name
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  checks.push({
    name: 'clean_entries_in_caption_mismatches',
    value: await scalar(`
      SELECT COUNT(*)
      FROM clean_reference_curve_entries clean
      JOIN dq_caption_total_mismatches dq
        ON dq.competition_slug = clean.competition_slug
       AND dq.corps_key = clean.corps_key
       AND dq.division_name = clean.division_name
    `),
    ok: true,
  });
  checks[checks.length - 1]!.ok = checks[checks.length - 1]!.value === 0;

  console.table(checks);
  await client.close();

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    console.error(
      `Domain semantic layer tests failed: ${failed.map((check) => check.name).join(', ')}`
    );
    process.exitCode = 1;
  } else {
    console.log('Domain semantic layer tests passed.');
  }
};

main().catch(async (error) => {
  console.error(error);
  await client.close();
  process.exitCode = 1;
});
