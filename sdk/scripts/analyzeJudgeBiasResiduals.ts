import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
type Caption = (typeof CAPTIONS)[number];

type Args = {
  db: string;
  outJson: string;
  outCsv: string;
  divisions: string[];
  minJudgeScores: number;
  minPairScores: number;
  minAbsResidual: number;
  shrinkageK: number;
  emaAlpha: number;
  minYear?: number;
  maxYear?: number;
};

type RawRow = {
  competition_slug: string;
  season: string;
  date: string;
  percent_through: number | null;
  event_name: string | null;
  corps_key: string;
  corps_name: string;
  division_name: string;
  corps_rank: number;
  total_score: number;
  caption: Caption;
  judge_id: string;
  judge_name: string;
  score: number;
};

type ResidualRow = RawRow & {
  expected_score: number;
  residual: number;
  interaction_residual?: number;
  baseline_source: 'corps_ema' | 'cell_mean' | 'caption_mean';
};

type Summary = {
  n: number;
  mean: number;
  sd: number;
  se: number;
  ci95_low: number;
  ci95_high: number;
  mean_abs: number;
  positive_pct: number;
  shrinkage_mean: number;
  z: number | null;
};

const usage = () => `Usage:
  npx tsx scripts/analyzeJudgeBiasResiduals.ts [options]

Options:
  --db <path>                    SQLite DB. Default: ./dci-relational.db
  --out-json <path>              Default: results/judge-bias-residuals.json
  --out-csv <path>               Default: results/judge-bias-residuals.csv
  --divisions <csv>              Default: World Class,Open Class
  --min-judge-scores <n>         Min judge+caption scores. Default: 20
  --min-pair-scores <n>          Min judge+corps+caption scores. Default: 4
  --min-abs-residual <pts>       Flag threshold. Default: 0.20
  --shrinkage-k <n>              Empirical shrinkage strength. Default: 8
  --ema-alpha <n>                Corps rolling baseline alpha. Default: 0.35
  --min-year <yyyy>              Optional inclusive season min
  --max-year <yyyy>              Optional inclusive season max

Method:
  residual = actual judge caption score - expected caption score.
  Expected score is the pre-show corps caption EMA when available, otherwise a
  same division/caption/rank/progress cell mean, otherwise caption mean.
  Judge-corps interactions are then adjusted by leave-one-out judge-caption and
  corps-caption residual tendencies, so broad harsh/easy judging and broad corps
  caption strength are not mistaken for pair-specific effects.

Caveat:
  This is an observational residual audit. It controls for important context but
  cannot prove causal judge bias because judge assignments are not random.`;

const getArg = (argv: string[], name: string, fallback?: string) => {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : fallback;
};

const parseArgs = (argv: string[]): Args => {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }
  return {
    db: getArg(argv, '--db', './dci-relational.db')!,
    outJson: getArg(argv, '--out-json', 'results/judge-bias-residuals.json')!,
    outCsv: getArg(argv, '--out-csv', 'results/judge-bias-residuals.csv')!,
    divisions: getArg(argv, '--divisions', 'World Class,Open Class')!
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    minJudgeScores: Number(getArg(argv, '--min-judge-scores', '20')),
    minPairScores: Number(getArg(argv, '--min-pair-scores', '4')),
    minAbsResidual: Number(getArg(argv, '--min-abs-residual', '0.20')),
    shrinkageK: Number(getArg(argv, '--shrinkage-k', '8')),
    emaAlpha: Number(getArg(argv, '--ema-alpha', '0.35')),
    minYear: getArg(argv, '--min-year') ? Number(getArg(argv, '--min-year')) : undefined,
    maxYear: getArg(argv, '--max-year') ? Number(getArg(argv, '--max-year')) : undefined,
  };
};

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const sd = (values: number[]) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)
  );
};
const round = (value: number | null | undefined, digits = 4) =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
const rankBucket = (rank: number) => {
  if (rank <= 3) return '01_top3';
  if (rank <= 6) return '02_4_6';
  if (rank <= 12) return '03_7_12';
  if (rank <= 18) return '04_13_18';
  return '05_19_plus';
};
const progressBucket = (percent: number | null) =>
  Math.max(0, Math.min(100, Math.round((percent ?? 50) / 10) * 10));
const key = (...parts: Array<string | number | null | undefined>) =>
  parts.map((part) => String(part ?? '')).join('|');

const summarize = (values: number[], shrinkageK: number): Summary => {
  const n = values.length;
  const avg = mean(values);
  const sigma = sd(values);
  const se = n > 1 ? sigma / Math.sqrt(n) : 0;
  const shrinkage = n / (n + shrinkageK);
  return {
    n,
    mean: avg,
    sd: sigma,
    se,
    ci95_low: avg - 1.96 * se,
    ci95_high: avg + 1.96 * se,
    mean_abs: mean(values.map(Math.abs)),
    positive_pct: values.filter((value) => value > 0).length / Math.max(1, n),
    shrinkage_mean: avg * shrinkage,
    z: se > 1e-9 ? avg / se : null,
  };
};

const csvEscape = (value: unknown) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

async function loadRows(args: Args): Promise<RawRow[]> {
  const db = createClient({ url: `file:${args.db}` });
  try {
    const divisionSql = args.divisions.map(sqlString).join(',');
    const minYearSql = args.minYear ? `AND CAST(c.season AS INTEGER) >= ${args.minYear}` : '';
    const maxYearSql = args.maxYear ? `AND CAST(c.season AS INTEGER) <= ${args.maxYear}` : '';
    const result = await db.execute(`
      SELECT
        js.competition_slug,
        c.season,
        c.date,
        c.percent_through,
        c.event_name,
        js.corps_key,
        cs.corps_name,
        cs.division_name,
        cs.rank AS corps_rank,
        cs.total_score,
        js.normalized_caption_name AS caption,
        js.judge_id,
        COALESCE(j.display_name, js.judge_id) AS judge_name,
        js.score
      FROM judge_scores js
      JOIN competitions c ON c.slug = js.competition_slug
      JOIN corps_scores cs ON cs.competition_slug = js.competition_slug AND cs.corps_key = js.corps_key
      LEFT JOIN judges j ON j.judge_id = js.judge_id
      WHERE js.normalized_caption_name IN (${CAPTIONS.map(sqlString).join(',')})
        AND js.score > 0
        AND js.judge_id IS NOT NULL
        AND js.judge_id NOT LIKE '%unknown%'
        AND js.judge_id NOT LIKE '%missing%'
        AND cs.division_name IN (${divisionSql})
        AND cs.total_score > 0
        AND cs.total_score <= 100
        AND c.slug NOT LIKE '%performers-showcase%'
        ${minYearSql}
        ${maxYearSql}
      ORDER BY c.date, js.competition_slug, cs.division_name, cs.rank, js.corps_key, js.normalized_caption_name
    `);
    return result.rows
      .map((row: any) => ({
        competition_slug: String(row.competition_slug),
        season: String(row.season),
        date: String(row.date),
        percent_through: row.percent_through == null ? null : Number(row.percent_through),
        event_name: row.event_name == null ? null : String(row.event_name),
        corps_key: String(row.corps_key),
        corps_name: String(row.corps_name),
        division_name: String(row.division_name),
        corps_rank: Number(row.corps_rank),
        total_score: Number(row.total_score),
        caption: row.caption as Caption,
        judge_id: String(row.judge_id),
        judge_name: String(row.judge_name),
        score: Number(row.score),
      }))
      .filter((row) => Number.isFinite(row.score) && CAPTIONS.includes(row.caption));
  } finally {
    db.close();
  }
}

function buildCellMeans(rows: RawRow[]) {
  const values = new Map<string, number[]>();
  const captionValues = new Map<string, number[]>();
  for (const row of rows) {
    const cellKey = key(
      row.division_name,
      row.caption,
      rankBucket(row.corps_rank),
      progressBucket(row.percent_through)
    );
    const cell = values.get(cellKey) ?? [];
    cell.push(row.score);
    values.set(cellKey, cell);
    const capKey = key(row.division_name, row.caption);
    const cap = captionValues.get(capKey) ?? [];
    cap.push(row.score);
    captionValues.set(capKey, cap);
  }
  return {
    cellMeans: new Map([...values.entries()].map(([k, v]) => [k, mean(v)])),
    captionMeans: new Map([...captionValues.entries()].map(([k, v]) => [k, mean(v)])),
  };
}

function computeResiduals(rows: RawRow[], args: Args): ResidualRow[] {
  const { cellMeans, captionMeans } = buildCellMeans(rows);
  const sorted = [...rows].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.competition_slug.localeCompare(b.competition_slug) ||
      a.corps_key.localeCompare(b.corps_key) ||
      a.caption.localeCompare(b.caption)
  );
  const ema = new Map<string, number>();
  const residuals: ResidualRow[] = [];

  for (const row of sorted) {
    const corpsCaptionKey = key(row.division_name, row.corps_key, row.caption);
    const cellKey = key(
      row.division_name,
      row.caption,
      rankBucket(row.corps_rank),
      progressBucket(row.percent_through)
    );
    const capKey = key(row.division_name, row.caption);
    const priorEma = ema.get(corpsCaptionKey);
    const cellMean = cellMeans.get(cellKey);
    const captionMean = captionMeans.get(capKey) ?? row.score;
    const expected = priorEma ?? cellMean ?? captionMean;
    const source: ResidualRow['baseline_source'] =
      priorEma != null ? 'corps_ema' : cellMean != null ? 'cell_mean' : 'caption_mean';
    residuals.push({
      ...row,
      expected_score: expected,
      residual: row.score - expected,
      baseline_source: source,
    });
    ema.set(
      corpsCaptionKey,
      priorEma == null ? row.score : args.emaAlpha * row.score + (1 - args.emaAlpha) * priorEma
    );
  }
  return residuals;
}

function withInteractionResiduals(residuals: ResidualRow[]): ResidualRow[] {
  const allByCaption = new Map<string, { sum: number; n: number }>();
  const judgeCaption = new Map<string, { sum: number; n: number }>();
  const corpsCaption = new Map<string, { sum: number; n: number }>();

  for (const row of residuals) {
    for (const [map, groupKey] of [
      [allByCaption, key(row.division_name, row.caption)],
      [judgeCaption, key(row.division_name, row.judge_id, row.caption)],
      [corpsCaption, key(row.division_name, row.corps_key, row.caption)],
    ] as const) {
      const current = map.get(groupKey) ?? { sum: 0, n: 0 };
      current.sum += row.residual;
      current.n += 1;
      map.set(groupKey, current);
    }
  }

  const leaveOneOutMean = (stats: { sum: number; n: number } | undefined, value: number) => {
    if (!stats || stats.n <= 1) return 0;
    return (stats.sum - value) / (stats.n - 1);
  };

  return residuals.map((row) => {
    const captionStats = allByCaption.get(key(row.division_name, row.caption));
    const captionMean = leaveOneOutMean(captionStats, row.residual);
    const judgeMean = leaveOneOutMean(
      judgeCaption.get(key(row.division_name, row.judge_id, row.caption)),
      row.residual
    );
    const corpsMean = leaveOneOutMean(
      corpsCaption.get(key(row.division_name, row.corps_key, row.caption)),
      row.residual
    );
    return {
      ...row,
      interaction_residual: row.residual - judgeMean - corpsMean + captionMean,
    };
  });
}

function aggregateResiduals<T extends string>(
  residuals: ResidualRow[],
  makeKey: (row: ResidualRow) => T,
  makeMeta: (rows: ResidualRow[]) => Record<string, unknown>,
  minN: number,
  shrinkageK: number,
  getValue: (row: ResidualRow) => number = (row) => row.residual
) {
  const groups = new Map<T, ResidualRow[]>();
  for (const row of residuals) {
    const groupKey = makeKey(row);
    const group = groups.get(groupKey) ?? [];
    group.push(row);
    groups.set(groupKey, group);
  }
  return [...groups.entries()]
    .filter(([, rows]) => rows.length >= minN)
    .map(([groupKey, rows]) => {
      const summary = summarize(rows.map(getValue), shrinkageK);
      return {
        key: groupKey,
        ...makeMeta(rows),
        n: summary.n,
        mean_residual: round(summary.mean),
        shrinkage_mean_residual: round(summary.shrinkage_mean),
        sd: round(summary.sd),
        se: round(summary.se),
        ci95_low: round(summary.ci95_low),
        ci95_high: round(summary.ci95_high),
        mean_abs_residual: round(summary.mean_abs),
        positive_pct: round(summary.positive_pct),
        z: round(summary.z),
        seasons: [...new Set(rows.map((row) => row.season))].sort().join(','),
        examples: rows
          .slice()
          .sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual))
          .slice(0, 5)
          .map((row) => ({
            date: row.date,
            competition_slug: row.competition_slug,
            corps: row.corps_name,
            score: round(row.score),
            expected: round(row.expected_score),
            residual: round(row.residual),
            interaction_residual: round(row.interaction_residual),
            baseline_source: row.baseline_source,
          })),
      };
    });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rawRows = await loadRows(args);
  const residuals = withInteractionResiduals(computeResiduals(rawRows, args));

  const judgeCaption = aggregateResiduals(
    residuals,
    (row) => key(row.judge_id, row.caption),
    (rows) => ({
      judge_id: rows[0]!.judge_id,
      judge_name: rows[0]!.judge_name,
      caption: rows[0]!.caption,
      division_mix: Object.fromEntries(
        [...new Set(rows.map((row) => row.division_name))].map((division) => [
          division,
          rows.filter((row) => row.division_name === division).length,
        ])
      ),
    }),
    args.minJudgeScores,
    args.shrinkageK
  );

  const judgeCorpsCaption = aggregateResiduals(
    residuals,
    (row) => key(row.judge_id, row.corps_key, row.caption),
    (rows) => ({
      judge_id: rows[0]!.judge_id,
      judge_name: rows[0]!.judge_name,
      corps_key: rows[0]!.corps_key,
      corps_name: rows[0]!.corps_name,
      caption: rows[0]!.caption,
      division: rows[0]!.division_name,
      raw_mean_residual: round(mean(rows.map((row) => row.residual))),
      adjusted_for: 'judge_caption_and_corps_caption_leave_one_out_means',
    }),
    args.minPairScores,
    args.shrinkageK,
    (row) => row.interaction_residual ?? row.residual
  );

  const flaggedJudgeCaption = judgeCaption
    .filter(
      (row: any) =>
        Math.abs(row.shrinkage_mean_residual) >= args.minAbsResidual &&
        (row.ci95_low > 0 || row.ci95_high < 0)
    )
    .sort(
      (a: any, b: any) => Math.abs(b.shrinkage_mean_residual) - Math.abs(a.shrinkage_mean_residual)
    );
  const flaggedJudgeCorpsCaption = judgeCorpsCaption
    .filter(
      (row: any) =>
        Math.abs(row.shrinkage_mean_residual) >= args.minAbsResidual &&
        (row.ci95_low > 0 || row.ci95_high < 0)
    )
    .sort(
      (a: any, b: any) => Math.abs(b.shrinkage_mean_residual) - Math.abs(a.shrinkage_mean_residual)
    );

  const output = {
    generated_at: new Date().toISOString(),
    db: args.db,
    method: 'pre_show_corps_ema_or_rank_progress_cell_residual',
    args,
    row_count: rawRows.length,
    residual_count: residuals.length,
    caveats: [
      'Observational residuals are not proof of causal bias because judge assignments are not random.',
      'Expected score uses pre-show corps caption EMA when available, then division/caption/rank/progress cell mean.',
      'Judge-corps interaction rows use residuals adjusted by leave-one-out judge-caption and corps-caption tendencies.',
      'Judge-corps interaction rows with low sample sizes should be treated as hypotheses, not conclusions.',
      'Shrinkage means pull small samples toward zero; flagged rows also require 95% CI excluding zero.',
    ],
    judge_caption_severity: judgeCaption.sort(
      (a: any, b: any) => Math.abs(b.shrinkage_mean_residual) - Math.abs(a.shrinkage_mean_residual)
    ),
    judge_corps_caption_interactions: judgeCorpsCaption.sort(
      (a: any, b: any) => Math.abs(b.shrinkage_mean_residual) - Math.abs(a.shrinkage_mean_residual)
    ),
    flagged_judge_caption_severity: flaggedJudgeCaption,
    flagged_judge_corps_caption_interactions: flaggedJudgeCorpsCaption,
  };

  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify(output, null, 2));

  const columns = [
    'kind',
    'judge_id',
    'judge_name',
    'corps_key',
    'corps_name',
    'caption',
    'division',
    'n',
    'mean_residual',
    'raw_mean_residual',
    'shrinkage_mean_residual',
    'se',
    'ci95_low',
    'ci95_high',
    'mean_abs_residual',
    'positive_pct',
    'z',
    'seasons',
  ];
  const csvRows = [
    ...output.judge_caption_severity.map((row: any) => ({ kind: 'judge_caption', ...row })),
    ...output.judge_corps_caption_interactions.map((row: any) => ({
      kind: 'judge_corps_caption',
      ...row,
    })),
  ];
  fs.writeFileSync(
    args.outCsv,
    [
      columns.join(','),
      ...csvRows.map((row: any) => columns.map((col) => csvEscape(row[col])).join(',')),
    ].join('\n')
  );

  console.log(`Loaded ${rawRows.length} judge score rows; computed ${residuals.length} residuals.`);
  console.log(`Wrote ${args.outJson}`);
  console.log(`Wrote ${args.outCsv}`);
  console.log('\nFlagged judge caption severity:');
  console.table(
    flaggedJudgeCaption.slice(0, 20).map((row: any) => ({
      judge: row.judge_name,
      caption: row.caption,
      n: row.n,
      shrink: row.shrinkage_mean_residual,
      ci: `[${row.ci95_low}, ${row.ci95_high}]`,
      pos: row.positive_pct,
    }))
  );
  console.log('\nFlagged judge-corps-caption interactions:');
  console.table(
    flaggedJudgeCorpsCaption.slice(0, 20).map((row: any) => ({
      judge: row.judge_name,
      corps: row.corps_name,
      caption: row.caption,
      n: row.n,
      shrink: row.shrinkage_mean_residual,
      raw: row.raw_mean_residual,
      ci: `[${row.ci95_low}, ${row.ci95_high}]`,
      pos: row.positive_pct,
    }))
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
