import { createClient } from '@libsql/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const METRICS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP', 'TOTAL'] as const;
type Metric = (typeof METRICS)[number];

const CAPTION_METRICS = METRICS.filter((metric) => metric !== 'TOTAL') as Exclude<
  Metric,
  'TOTAL'
>[];
const DEFAULT_DIVISIONS = ['World Class', 'Open Class'];

type Args = {
  db: string;
  outJson: string;
  outCsv: string;
  divisions: string[];
  minCellCount: number;
};

type CleanEntry = {
  season: string;
  competitionSlug: string;
  corpsKey: string;
  corpsName: string;
  divisionName: string;
  date: string;
  eventName: string | null;
  totalScore: number;
  percentThrough: number;
  percentBucket: number;
  rankBucket: number;
  computedRank: number;
  scores: Record<Metric, number>;
};

type Summary = {
  count: number;
  mean: number | null;
  sd: number | null;
  mae: number | null;
  rmse: number | null;
  medianAbs: number | null;
  p75Abs: number | null;
  p90Abs: number | null;
  p95Abs: number | null;
  min: number | null;
  max: number | null;
};

type OutputRow = {
  estimator: string;
  division: string;
  metric: string;
  group: string;
  count: number;
  mean: number | null;
  sd: number | null;
  mae: number | null;
  rmse: number | null;
  medianAbs: number | null;
  p75Abs: number | null;
  p90Abs: number | null;
  p95Abs: number | null;
  min: number | null;
  max: number | null;
  impliedObservationSigma: number | null;
  impliedNormalMae: number | null;
  note: string;
};

type AnalysisOutput = {
  generatedAt: string;
  db: string;
  divisions: string[];
  minCellCount: number;
  notes: string[];
  rowCount: number;
  summaries: OutputRow[];
};

const usage = () => `Usage:
  npx tsx scripts/analyzeScoreNoiseFloor.ts [options]

Options:
  --db <path>                SQLite database path. Default: ./dci-relational.db
  --out-json <path>          JSON output path. Default: ./results/noise-floor-analysis.json
  --out-csv <path>           CSV output path. Default: ./results/noise-floor-summary.csv
  --divisions <csv>          Divisions to include. Default: World Class,Open Class
  --min-cell-count <number>  Minimum reference-curve cell size. Default: 5

This script estimates practical lower bounds for model accuracy from multiple proxies.
No estimator is a perfect "true noise" measurement because corps improve, panels change,
and show context changes. Treat the results as a range with labeled assumptions.`;

const parseArgs = (argv: string[]): Args => {
  const args: Args = {
    db: './dci-relational.db',
    outJson: './results/noise-floor-analysis.json',
    outCsv: './results/noise-floor-summary.csv',
    divisions: DEFAULT_DIVISIONS,
    minCellCount: 5,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === '--db') {
      args.db = next;
      i++;
    } else if (arg === '--out-json') {
      args.outJson = next;
      i++;
    } else if (arg === '--out-csv') {
      args.outCsv = next;
      i++;
    } else if (arg === '--divisions') {
      args.divisions = next
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      i++;
    } else if (arg === '--min-cell-count') {
      args.minCellCount = Number(next);
      if (!Number.isFinite(args.minCellCount) || args.minCellCount < 1) {
        throw new Error('--min-cell-count must be a positive number');
      }
      i++;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
};

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

const quantile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
};

const mean = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const sampleSd = (values: number[]): number | null => {
  if (values.length < 2) return null;
  const avg = mean(values)!;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
};

const summarize = (values: number[]): Summary => {
  const absValues = values.map((value) => Math.abs(value));
  const squaredMean = values.length
    ? values.reduce((sum, value) => sum + value ** 2, 0) / values.length
    : null;
  return {
    count: values.length,
    mean: mean(values),
    sd: sampleSd(values),
    mae: mean(absValues),
    rmse: squaredMean === null ? null : Math.sqrt(squaredMean),
    medianAbs: quantile(absValues, 0.5),
    p75Abs: quantile(absValues, 0.75),
    p90Abs: quantile(absValues, 0.9),
    p95Abs: quantile(absValues, 0.95),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
};

const round = (value: number | null, digits = 6): number | null => {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const toOutputRow = (
  estimator: string,
  division: string,
  metric: string,
  group: string,
  values: number[],
  note: string,
  includePairNoise = false
): OutputRow => {
  const summary = summarize(values);
  const impliedObservationSigma =
    includePairNoise && summary.sd !== null ? summary.sd / Math.sqrt(2) : null;
  const impliedNormalMae =
    impliedObservationSigma === null ? null : impliedObservationSigma * Math.sqrt(2 / Math.PI);

  return {
    estimator,
    division,
    metric,
    group,
    count: summary.count,
    mean: round(summary.mean),
    sd: round(summary.sd),
    mae: round(summary.mae),
    rmse: round(summary.rmse),
    medianAbs: round(summary.medianAbs),
    p75Abs: round(summary.p75Abs),
    p90Abs: round(summary.p90Abs),
    p95Abs: round(summary.p95Abs),
    min: round(summary.min),
    max: round(summary.max),
    impliedObservationSigma: round(impliedObservationSigma),
    impliedNormalMae: round(impliedNormalMae),
    note,
  };
};

const dateMs = (row: CleanEntry): number => {
  const parsed = Date.parse(row.date);
  if (Number.isFinite(parsed)) return parsed;
  return Number(row.percentThrough) * 86_400_000;
};

const dayGap = (a: CleanEntry, b: CleanEntry): number => {
  const gap = Math.abs(dateMs(b) - dateMs(a)) / 86_400_000;
  return Number.isFinite(gap) ? gap : 0;
};

const groupKey = (...parts: string[]) => parts.join('\u0001');

const pushValue = (map: Map<string, number[]>, key: string, value: number) => {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
};

const getScore = (row: CleanEntry, metric: Metric) => row.scores[metric];

const isCloseToInteger = (value: number, multiplier: number) => {
  const scaled = value * multiplier;
  return Math.abs(scaled - Math.round(scaled)) < 0.000001;
};

const roundNameFromSlug = (slug: string) => {
  const lower = slug.toLowerCase();
  if (lower.includes('prelim')) return 'prelims';
  if (lower.includes('semi')) return 'semis';
  if (lower.includes('final')) return 'finals';
  return null;
};

const readCleanEntries = async (dbPath: string, divisions: string[]): Promise<CleanEntry[]> => {
  const client = createClient({ url: `file:${dbPath}` });
  const divisionSql = divisions.map(sqlString).join(', ');

  try {
    const viewCheck = await client.execute(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'view'
        AND name IN ('clean_reference_curve_entries', 'clean_reference_curve_metric_scores', 'reference_curve_metric_stats')
    `);
    const viewCount = Number(viewCheck.rows[0]?.count ?? 0);
    if (viewCount !== 3) {
      throw new Error(
        'Expected clean reference curve views to exist. Run the relational/domain schema setup before this analysis.'
      );
    }

    const result = await client.execute(`
      SELECT
        e.season,
        e.competition_slug,
        e.corps_key,
        e.corps_name,
        e.division_name,
        c.date,
        c.event_name,
        e.total_score,
        e.percent_through,
        e.percent_bucket,
        e.rank_bucket,
        e.computed_rank,
        e.GE1,
        e.GE2,
        e.VP,
        e.VA,
        e.CG,
        e.MB,
        e.MA,
        e.MP
      FROM clean_reference_curve_entries e
      JOIN competitions c ON c.slug = e.competition_slug
      WHERE e.division_name IN (${divisionSql})
      ORDER BY e.division_name, e.season, e.corps_key, c.date, e.percent_through, e.competition_slug
    `);

    return result.rows.map((row) => {
      const totalScore = Number(row.total_score);
      return {
        season: String(row.season),
        competitionSlug: String(row.competition_slug),
        corpsKey: String(row.corps_key),
        corpsName: String(row.corps_name),
        divisionName: String(row.division_name),
        date: String(row.date ?? ''),
        eventName:
          row.event_name === null || row.event_name === undefined ? null : String(row.event_name),
        totalScore,
        percentThrough: Number(row.percent_through),
        percentBucket: Number(row.percent_bucket),
        rankBucket: Number(row.rank_bucket),
        computedRank: Number(row.computed_rank),
        scores: {
          GE1: Number(row.GE1),
          GE2: Number(row.GE2),
          VP: Number(row.VP),
          VA: Number(row.VA),
          CG: Number(row.CG),
          MB: Number(row.MB),
          MA: Number(row.MA),
          MP: Number(row.MP),
          TOTAL: totalScore,
        },
      };
    });
  } finally {
    client.close();
  }
};

const adjacentVolatilityRows = (entries: CleanEntry[]): OutputRow[] => {
  const values = new Map<string, number[]>();
  const bySeries = new Map<string, CleanEntry[]>();

  for (const row of entries) {
    pushRow(bySeries, groupKey(row.divisionName, row.season, row.corpsKey), row);
  }

  for (const series of bySeries.values()) {
    series.sort((a, b) => dateMs(a) - dateMs(b) || a.percentThrough - b.percentThrough);
    for (let i = 1; i < series.length; i++) {
      const previous = series[i - 1]!;
      const current = series[i]!;
      const gap = dayGap(previous, current);
      const gapGroups = ['all'];
      if (gap <= 3) gapGroups.push('gap<=3d');
      if (gap <= 7) gapGroups.push('gap<=7d');
      if (gap <= 14) gapGroups.push('gap<=14d');

      for (const metric of METRICS) {
        const delta = getScore(current, metric) - getScore(previous, metric);
        for (const gapGroup of gapGroups) {
          pushValue(values, groupKey(current.divisionName, metric, gapGroup), delta);
        }
      }
    }
  }

  return Array.from(values.entries())
    .map(([key, deltas]) => {
      const [division, metric, group] = key.split('\u0001');
      return toOutputRow(
        'adjacent_show_delta',
        division!,
        metric!,
        group!,
        deltas,
        'Consecutive same-corps show deltas. This is an upper-bound volatility proxy because it includes real improvement and panel/show-context changes.',
        true
      );
    })
    .sort(sortOutputRows);
};

const interpolationOracleRows = (entries: CleanEntry[]): OutputRow[] => {
  const errors = new Map<string, number[]>();
  const bySeries = new Map<string, CleanEntry[]>();

  for (const row of entries) {
    pushRow(bySeries, groupKey(row.divisionName, row.season, row.corpsKey), row);
  }

  for (const series of bySeries.values()) {
    series.sort((a, b) => dateMs(a) - dateMs(b) || a.percentThrough - b.percentThrough);
    for (let i = 1; i < series.length - 1; i++) {
      const previous = series[i - 1]!;
      const current = series[i]!;
      const next = series[i + 1]!;
      const previousTime = dateMs(previous);
      const currentTime = dateMs(current);
      const nextTime = dateMs(next);
      if (nextTime <= previousTime) continue;
      const weight = (currentTime - previousTime) / (nextTime - previousTime);
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) continue;

      const surroundingGap = dayGap(previous, next);
      const gapGroups = ['all'];
      if (surroundingGap <= 7) gapGroups.push('surrounding_gap<=7d');
      if (surroundingGap <= 14) gapGroups.push('surrounding_gap<=14d');
      if (surroundingGap <= 21) gapGroups.push('surrounding_gap<=21d');

      for (const metric of METRICS) {
        const predicted =
          getScore(previous, metric) +
          (getScore(next, metric) - getScore(previous, metric)) * weight;
        const error = getScore(current, metric) - predicted;
        for (const gapGroup of gapGroups) {
          pushValue(errors, groupKey(current.divisionName, metric, gapGroup), error);
        }
      }
    }
  }

  return Array.from(errors.entries())
    .map(([key, values]) => {
      const [division, metric, group] = key.split('\u0001');
      return toOutputRow(
        'centered_interpolation_oracle',
        division!,
        metric!,
        group!,
        values,
        'Post-hoc linear interpolation between previous and next shows. This uses future data, so it is an optimistic smooth-trajectory residual proxy rather than a deployable model.'
      );
    })
    .sort(sortOutputRows);
};

const championshipRepeatabilityRows = (entries: CleanEntry[]): OutputRow[] => {
  const residuals = new Map<string, number[]>();
  const byCorps = new Map<string, CleanEntry[]>();
  const roundsByCorps = new Map<string, Map<string, CleanEntry>>();

  for (const row of entries) {
    const roundName = roundNameFromSlug(row.competitionSlug);
    if (!roundName) continue;
    if (!row.competitionSlug.toLowerCase().includes('championship')) continue;
    const key = groupKey(row.divisionName, row.season, row.corpsKey);
    const rounds = roundsByCorps.get(key) ?? new Map<string, CleanEntry>();
    rounds.set(roundName, row);
    roundsByCorps.set(key, rounds);
    pushRow(byCorps, key, row);
  }

  for (const [key, rounds] of roundsByCorps.entries()) {
    const finals = rounds.get('finals');
    const semis = rounds.get('semis');
    const prelims = rounds.get('prelims');
    if (!finals || !semis || !prelims) continue;
    if (finals.computedRank > 12) continue;

    const rows = [prelims, semis, finals];
    for (const metric of METRICS) {
      const avg = mean(rows.map((row) => getScore(row, metric)));
      if (avg === null) continue;
      const [division] = key.split('\u0001');
      for (const row of rows) {
        pushValue(
          residuals,
          groupKey(division!, metric, 'top12_prelims_semis_finals'),
          getScore(row, metric) - avg
        );
      }
    }
  }

  return Array.from(residuals.entries())
    .map(([key, values]) => {
      const [division, metric, group] = key.split('\u0001');
      return toOutputRow(
        'championship_week_repeatability',
        division!,
        metric!,
        group!,
        values,
        "Residual around each finalist corps' own prelims/semis/finals mean. Useful near-repeatability proxy, but still includes real championship-week changes and panel effects."
      );
    })
    .sort(sortOutputRows);
};

const referenceCurveResidualRows = (entries: CleanEntry[], minCellCount: number): OutputRow[] => {
  const cellValues = new Map<string, number[]>();
  for (const row of entries) {
    for (const metric of METRICS) {
      pushValue(
        cellValues,
        groupKey(row.divisionName, metric, String(row.rankBucket), String(row.percentBucket)),
        getScore(row, metric)
      );
    }
  }

  const residuals = new Map<string, number[]>();
  for (const [cellKey, values] of cellValues.entries()) {
    if (values.length < minCellCount) continue;
    const [division, metric] = cellKey.split('\u0001');
    const avg = mean(values)!;
    for (const value of values) {
      pushValue(residuals, groupKey(division!, metric!, `cell_n>=${minCellCount}`), value - avg);
    }
  }

  return Array.from(residuals.entries())
    .map(([key, values]) => {
      const [division, metric, group] = key.split('\u0001');
      return toOutputRow(
        'rank_progress_cell_residual',
        division!,
        metric!,
        group!,
        values,
        'Residual within division + rank bucket + 5 percent-through bucket cells. This measures scatter left after a coarse reference curve and includes within-cell corps/event differences.'
      );
    })
    .sort(sortOutputRows);
};

const scoreGranularityRows = (entries: CleanEntry[]): OutputRow[] => {
  const valuesByKey = new Map<string, number[]>();
  for (const row of entries) {
    for (const metric of METRICS) {
      pushValue(valuesByKey, groupKey(row.divisionName, metric, 'all'), getScore(row, metric));
    }
  }

  const rows: OutputRow[] = [];
  for (const [key, values] of valuesByKey.entries()) {
    const [division, metric, group] = key.split('\u0001');
    const quarterPct = values.filter((value) => isCloseToInteger(value, 4)).length / values.length;
    const tenthPct = values.filter((value) => isCloseToInteger(value, 10)).length / values.length;
    const hundredthPct =
      values.filter((value) => isCloseToInteger(value, 100)).length / values.length;
    const uniqueScores = new Set(values.map((value) => value.toFixed(3))).size;
    rows.push({
      estimator: 'score_granularity',
      division: division!,
      metric: metric!,
      group: group!,
      count: values.length,
      mean: round(mean(values)),
      sd: round(sampleSd(values)),
      mae: round(quarterPct),
      rmse: round(tenthPct),
      medianAbs: round(hundredthPct),
      p75Abs: null,
      p90Abs: null,
      p95Abs: null,
      min: round(Math.min(...values)),
      max: round(Math.max(...values)),
      impliedObservationSigma: null,
      impliedNormalMae: null,
      note: `Granularity diagnostic: mae=quarter_point_pct, rmse=tenth_point_pct, medianAbs=hundredth_point_pct, unique_scores=${uniqueScores}.`,
    });
  }

  return rows.sort(sortOutputRows);
};

function pushRow<T>(map: Map<string, T[]>, key: string, row: T) {
  const rows = map.get(key);
  if (rows) rows.push(row);
  else map.set(key, [row]);
}

const sortOutputRows = (a: OutputRow, b: OutputRow) =>
  a.estimator.localeCompare(b.estimator) ||
  a.division.localeCompare(b.division) ||
  metricOrder(a.metric) - metricOrder(b.metric) ||
  a.group.localeCompare(b.group);

const metricOrder = (metric: string) => {
  const index = METRICS.indexOf(metric as Metric);
  return index === -1 ? 999 : index;
};

const csvEscape = (value: string | number | null) => {
  if (value === null) return '';
  const text = String(value);
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
};

const writeCsv = (path: string, rows: OutputRow[]) => {
  const headers = [
    'estimator',
    'division',
    'metric',
    'group',
    'count',
    'mean',
    'sd',
    'mae',
    'rmse',
    'medianAbs',
    'p75Abs',
    'p90Abs',
    'p95Abs',
    'min',
    'max',
    'impliedObservationSigma',
    'impliedNormalMae',
    'note',
  ] as const;
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ];
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`);
};

const printConsoleSummary = (rows: OutputRow[]) => {
  const keyRows = rows.filter(
    (row) =>
      row.metric === 'TOTAL' &&
      (row.estimator === 'centered_interpolation_oracle' ||
        row.estimator === 'adjacent_show_delta' ||
        row.estimator === 'championship_week_repeatability' ||
        row.estimator === 'rank_progress_cell_residual') &&
      (row.group === 'all' ||
        row.group === 'gap<=7d' ||
        row.group === 'top12_prelims_semis_finals' ||
        row.group.startsWith('cell_n>='))
  );

  console.log('\nTotal-score noise-floor proxies');
  console.table(
    keyRows.map((row) => ({
      estimator: row.estimator,
      division: row.division,
      group: row.group,
      n: row.count,
      mae: row.mae,
      rmse: row.rmse,
      sd: row.sd,
      impliedMae: row.impliedNormalMae,
      p90Abs: row.p90Abs,
    }))
  );

  const captionRows = rows.filter(
    (row) =>
      CAPTION_METRICS.includes(row.metric as Exclude<Metric, 'TOTAL'>) &&
      row.estimator === 'centered_interpolation_oracle' &&
      row.group === 'all'
  );
  console.log('\nCaption centered-interpolation oracle MAE by division');
  console.table(
    captionRows.map((row) => ({
      division: row.division,
      metric: row.metric,
      n: row.count,
      mae: row.mae,
      rmse: row.rmse,
      p90Abs: row.p90Abs,
    }))
  );
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const entries = await readCleanEntries(args.db, args.divisions);

  if (entries.length === 0) {
    throw new Error(
      `No clean reference curve entries found for divisions: ${args.divisions.join(', ')}`
    );
  }

  const summaries = [
    ...adjacentVolatilityRows(entries),
    ...interpolationOracleRows(entries),
    ...championshipRepeatabilityRows(entries),
    ...referenceCurveResidualRows(entries, args.minCellCount),
    ...scoreGranularityRows(entries),
  ].sort(sortOutputRows);

  const output: AnalysisOutput = {
    generatedAt: new Date().toISOString(),
    db: resolve(args.db),
    divisions: args.divisions,
    minCellCount: args.minCellCount,
    rowCount: entries.length,
    notes: [
      'The true irreducible noise floor is not directly observable because corps quality changes over time and judges/panels/events are not repeated under controlled conditions.',
      'Adjacent-show deltas are upper-bound volatility proxies: they include real corps improvement plus event and panel effects.',
      'Centered interpolation uses future data and is therefore an optimistic post-hoc lower-bound proxy for smooth-trajectory residual error.',
      'Championship-week repeatability is a near-repeat measurement for finalist corps, but it is late-season only and still includes real changes across prelims, semis, and finals.',
      'Rank-progress cell residuals estimate scatter left after coarse division/rank/season-progress baselines; this includes within-cell systematic differences, not just judging noise.',
      'TOTAL is on the 100-point scale. Caption metrics are on their raw caption scales and should not be compared numerically to TOTAL without rescaling.',
    ],
    summaries,
  };

  mkdirSync(dirname(resolve(args.outJson)), { recursive: true });
  writeFileSync(args.outJson, `${JSON.stringify(output, null, 2)}\n`);
  writeCsv(args.outCsv, summaries);

  printConsoleSummary(summaries);
  console.log(`\nWrote ${args.outJson}`);
  console.log(`Wrote ${args.outCsv}`);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
