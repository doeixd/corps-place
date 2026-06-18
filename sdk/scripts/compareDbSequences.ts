// Usage: npx tsx scripts/compareDbSequences.ts [--new file:./dci-relational.db] [--old file:./dci-relational.old.db]

import { createClient } from '@libsql/client';

type SequenceRow = {
  competition_slug: string;
  x_sequence_json: string | null;
  y_recap_json: string | null;
  y_residuals_json: string | null;
  judge_indices_json: string | null;
};

type Stats = {
  rows: number;
  competitions: number;
  missingX: number;
  missingYRecap: number;
  missingYResiduals: number;
  missingJudges: number;
  yRecapInvalid: number;
  yResidualsInvalid: number;
  judgeIndicesInvalid: number;
  yRecapLength: number;
  yResidualsLength: number;
  judgeIndicesLength: number;
};

const getArg = (flag: string) => {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
};

const safeParse = (text: string | null) => {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const countInvalidNumbers = (value: unknown) => {
  if (!Array.isArray(value)) return { invalid: 1, length: 0 };
  let invalid = 0;
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      invalid += 1;
    }
  }
  return { invalid, length: value.length };
};

const countInvalidIndices = (value: unknown) => {
  if (!Array.isArray(value)) return { invalid: 1, length: 0 };
  let invalid = 0;
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      invalid += 1;
    }
  }
  return { invalid, length: value.length };
};

const computeStats = async (dbUrl: string) => {
  const client = createClient({ url: dbUrl });

  const rowsResult = await client.execute(
    'SELECT competition_slug, x_sequence_json, y_recap_json, y_residuals_json, judge_indices_json FROM ml_sequence_rows_v9_subcaption'
  );

  const rows = rowsResult.rows as unknown as SequenceRow[];
  const stats: Stats = {
    rows: 0,
    competitions: 0,
    missingX: 0,
    missingYRecap: 0,
    missingYResiduals: 0,
    missingJudges: 0,
    yRecapInvalid: 0,
    yResidualsInvalid: 0,
    judgeIndicesInvalid: 0,
    yRecapLength: 0,
    yResidualsLength: 0,
    judgeIndicesLength: 0,
  };

  const competitionSet = new Set<string>();

  for (const row of rows) {
    stats.rows += 1;
    competitionSet.add(row.competition_slug);

    if (!row.x_sequence_json) stats.missingX += 1;
    if (!row.y_recap_json) stats.missingYRecap += 1;
    if (!row.y_residuals_json) stats.missingYResiduals += 1;
    if (!row.judge_indices_json) stats.missingJudges += 1;

    const yRecap = safeParse(row.y_recap_json);
    const yResiduals = safeParse(row.y_residuals_json);
    const judgeIndices = safeParse(row.judge_indices_json);

    const yRecapInfo = countInvalidNumbers(yRecap);
    stats.yRecapInvalid += yRecapInfo.invalid;
    stats.yRecapLength += yRecapInfo.length;

    const yResidualsInfo = countInvalidNumbers(yResiduals);
    stats.yResidualsInvalid += yResidualsInfo.invalid;
    stats.yResidualsLength += yResidualsInfo.length;

    const judgeInfo = countInvalidIndices(judgeIndices);
    stats.judgeIndicesInvalid += judgeInfo.invalid;
    stats.judgeIndicesLength += judgeInfo.length;
  }

  stats.competitions = competitionSet.size;

  const countsResult = await client.execute(
    'SELECT \n' +
      '  (SELECT COUNT(*) FROM judge_assignments) AS judge_assignments,\n' +
      '  (SELECT COUNT(*) FROM judge_scores) AS judge_scores,\n' +
      '  (SELECT COUNT(*) FROM caption_scores) AS caption_scores,\n' +
      '  (SELECT COUNT(*) FROM subcaption_scores) AS subcaption_scores'
  );
  const counts = countsResult.rows[0] as unknown as {
    judge_assignments: number;
    judge_scores: number;
    caption_scores: number;
    subcaption_scores: number;
  };

  client.close();

  return { stats, counts };
};

const formatRatio = (invalid: number, length: number) =>
  length === 0 ? '-' : `${invalid}/${length} (${((invalid / length) * 100).toFixed(2)}%)`;

const renderTable = (title: string, rows: Array<[string, string, string]>) => {
  const header = ['Metric', 'New', 'Old'];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]?.length ?? 0))
  );
  const pad = (value: string, width: number) =>
    value + ' '.repeat(Math.max(0, width - value.length));
  const line = (values: string[]) => `| ${values.map((v, i) => pad(v, widths[i]!)).join(' | ')} |`;
  const divider = `+-${widths.map((w) => '-'.repeat(w)).join('-+-')}-+`;

  console.log(`\n=== ${title} ===`);
  console.log(
    [divider, line(header), divider, ...rows.map((row) => line(row)), divider].join('\n')
  );
};

const main = async () => {
  const newDb = getArg('--new') ?? 'file:./dci-relational.db';
  const oldDb = getArg('--old') ?? 'file:./dci-relational.old.db';

  const newResult = await computeStats(newDb);
  const oldResult = await computeStats(oldDb);

  const rows: Array<[string, string, string]> = [
    ['Rows', String(newResult.stats.rows), String(oldResult.stats.rows)],
    ['Competitions', String(newResult.stats.competitions), String(oldResult.stats.competitions)],
    ['Missing x_sequence_json', String(newResult.stats.missingX), String(oldResult.stats.missingX)],
    [
      'Missing y_recap_json',
      String(newResult.stats.missingYRecap),
      String(oldResult.stats.missingYRecap),
    ],
    [
      'Missing y_residuals_json',
      String(newResult.stats.missingYResiduals),
      String(oldResult.stats.missingYResiduals),
    ],
    [
      'Missing judge_indices_json',
      String(newResult.stats.missingJudges),
      String(oldResult.stats.missingJudges),
    ],
    [
      'y_recap invalid',
      formatRatio(newResult.stats.yRecapInvalid, newResult.stats.yRecapLength),
      formatRatio(oldResult.stats.yRecapInvalid, oldResult.stats.yRecapLength),
    ],
    [
      'y_residuals invalid',
      formatRatio(newResult.stats.yResidualsInvalid, newResult.stats.yResidualsLength),
      formatRatio(oldResult.stats.yResidualsInvalid, oldResult.stats.yResidualsLength),
    ],
    [
      'judge_indices invalid',
      formatRatio(newResult.stats.judgeIndicesInvalid, newResult.stats.judgeIndicesLength),
      formatRatio(oldResult.stats.judgeIndicesInvalid, oldResult.stats.judgeIndicesLength),
    ],
  ];

  const recapRows: Array<[string, string, string]> = [
    [
      'judge_assignments',
      String(newResult.counts.judge_assignments),
      String(oldResult.counts.judge_assignments),
    ],
    ['judge_scores', String(newResult.counts.judge_scores), String(oldResult.counts.judge_scores)],
    [
      'caption_scores',
      String(newResult.counts.caption_scores),
      String(oldResult.counts.caption_scores),
    ],
    [
      'subcaption_scores',
      String(newResult.counts.subcaption_scores),
      String(oldResult.counts.subcaption_scores),
    ],
  ];

  renderTable('V9 Subcaption Sequence Stats', rows);
  renderTable('Recap Table Counts', recapRows);

  console.log('\n=== JSON Summary ===');
  console.log(JSON.stringify({ new: newResult, old: oldResult }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
