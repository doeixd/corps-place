/**
 * Pure Monte Carlo scenario math for the prediction recap.
 *
 * Ported verbatim (logic-for-logic) from the legacy Astro prediction page so the
 * "Roll" / "Ranges" behaviour carries over exactly. Kept side-effect free so it can be
 * driven from XState machine actions (see `app/machines/prediction-machine.ts`).
 */

export const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
export type Caption = (typeof CAPTIONS)[number];

export const SCENARIO_WINDOWS = ['0.5', '0.8', '0.95'] as const;
export type ScenarioWindow = (typeof SCENARIO_WINDOWS)[number];

export const WINDOW_LABELS: Record<ScenarioWindow, string> = {
  '0.5': 'Likely',
  '0.8': 'Possible',
  '0.95': 'Unlikely',
};

const zByWindow: Record<string, number> = {
  '0.5': 0.4,
  '0.8': 1.282,
  '0.95': 1.96,
};

export interface CaptionInterval {
  p10: number;
  p50?: number;
  p90: number;
}

export interface RecapRow {
  rank?: number;
  corps?: string;
  division?: string;
  total?: number;
  GE?: number;
  Visual?: number;
  Music?: number;
  caption_intervals?: Partial<Record<Caption, CaptionInterval>>;
  [key: string]: unknown;
}

export interface Range {
  low: number;
  high: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalSample = (rng: () => number) => {
  const u1 = Math.max(Number.MIN_VALUE, rng());
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

export const zLimitFor = (window: string) => zByWindow[window] ?? zByWindow['0.8'];

export const fmt = (value: unknown, decimals = 3): string =>
  typeof value === 'number' ? value.toFixed(decimals) : '';

// Decimal places a single score needs at 3-dp base precision, with trailing
// zeros stripped (e.g. 98.450 → 2, 98.500 → 1, 98.000 → 0).
const sigDecimals = (value: number): number => {
  const frac = value.toFixed(3).split('.')[1] ?? '';
  return frac.replace(/0+$/, '').length;
};

/**
 * The fewest decimal places that render every score in a table without losing
 * precision (0–3). Lets a table drop columns of uniform trailing zeros — show
 * `80`/`85` when all scores are whole, `80.0`/`85.5` when the finest score is a
 * half — while keeping every value aligned to the same width.
 */
export const scoreDecimals = (values: Iterable<number>): number => {
  let max = 0;
  for (const v of values) {
    if (typeof v !== 'number' || Number.isNaN(v)) continue;
    const d = sigDecimals(v);
    if (d > max) max = d;
    if (max === 3) break;
  }
  return max;
};

export const fmtRange = (low: unknown, high: unknown): string =>
  typeof low === 'number' && typeof high === 'number' ? `${low.toFixed(2)}-${high.toFixed(2)}` : '';

const sampleCaption = (
  center: number,
  interval: CaptionInterval | undefined,
  zLimit: number,
  rng: () => number
) => {
  if (!interval || typeof interval.p10 !== 'number' || typeof interval.p90 !== 'number')
    return center;
  const lowWidth = Math.max(0.05, center - interval.p10);
  const highWidth = Math.max(0.05, interval.p90 - center);
  const draw = clamp(normalSample(rng), -zLimit, zLimit);
  const sigma = (draw < 0 ? lowWidth : highWidth) / zByWindow['0.8'];
  const windowScale = zLimit / zByWindow['0.8'];
  const lower = Math.max(0, center - lowWidth * windowScale);
  const upper = Math.min(20, center + highWidth * windowScale);
  return Number(clamp(center + draw * sigma, lower, upper).toFixed(3));
};

const captionRange = (row: RecapRow, caption: Caption, zLimit: number): Range => {
  const interval = row?.caption_intervals?.[caption];
  if (!interval || typeof interval.p10 !== 'number' || typeof interval.p90 !== 'number') {
    const center = row?.[caption] as number | undefined;
    return { low: center ?? 0, high: center ?? 0 };
  }
  const center = interval.p50 ?? (interval.p10 + interval.p90) / 2;
  const lowWidth = Math.max(0.05, center - interval.p10);
  const highWidth = Math.max(0.05, interval.p90 - center);
  const windowScale = zLimit / zByWindow['0.8'];
  return {
    low: Number(clamp(center - lowWidth * windowScale, 0, 20).toFixed(3)),
    high: Number(clamp(center + highWidth * windowScale, 0, 20).toFixed(3)),
  };
};

export type RangeKey = Caption | 'GE' | 'Visual' | 'Music' | 'total';

export const computedRanges = (row: RecapRow, window: string): Record<RangeKey, Range> => {
  const zLimit = zLimitFor(window);
  const cap = Object.fromEntries(
    CAPTIONS.map((caption) => [caption, captionRange(row, caption, zLimit)])
  ) as Record<Caption, Range>;
  const add = (...items: Range[]): Range => ({
    low: items.reduce((sum, item) => sum + (item.low ?? 0), 0),
    high: items.reduce((sum, item) => sum + (item.high ?? 0), 0),
  });
  const halfAdd = (...items: Range[]): Range => {
    const sum = add(...items);
    return { low: sum.low / 2, high: sum.high / 2 };
  };
  const GE = add(cap.GE1, cap.GE2);
  const Visual = halfAdd(cap.VP, cap.VA, cap.CG);
  const Music = halfAdd(cap.MB, cap.MA, cap.MP);
  const total = add(GE, Visual, Music);
  return { ...cap, GE, Visual, Music, total };
};

const totalFromRow = (row: RecapRow) => {
  const GE = ((row.GE1 as number) ?? 0) + ((row.GE2 as number) ?? 0);
  const Visual =
    (((row.VP as number) ?? 0) + ((row.VA as number) ?? 0) + ((row.CG as number) ?? 0)) / 2;
  const Music =
    (((row.MB as number) ?? 0) + ((row.MA as number) ?? 0) + ((row.MP as number) ?? 0)) / 2;
  return { GE, Visual, Music, total: GE + Visual + Music };
};

const withComputedScores = (row: RecapRow): RecapRow => {
  const scores = totalFromRow(row);
  return {
    ...row,
    GE: Number(scores.GE.toFixed(3)),
    Visual: Number(scores.Visual.toFixed(3)),
    Music: Number(scores.Music.toFixed(3)),
    total: Number(scores.total.toFixed(3)),
  };
};

/**
 * Roll one Monte Carlo scenario: sample every caption, recompute totals, re-rank.
 * `rng` is a uniform [0, 1) generator; pass a seeded one (see `createRng` in
 * `app/lib/seeded-rng.ts`) for a reproducible roll.
 */
export const rollScenario = (
  baseRecap: RecapRow[],
  window: string,
  rng: () => number
): RecapRow[] => {
  const zLimit = zLimitFor(window);
  return baseRecap
    .map((row) => {
      const next: RecapRow = { ...row };
      for (const caption of CAPTIONS) {
        next[caption] = sampleCaption(
          row[caption] as number,
          row.caption_intervals?.[caption],
          zLimit,
          rng
        );
      }
      return withComputedScores(next);
    })
    .sort((a, b) => (b.total ?? -Infinity) - (a.total ?? -Infinity))
    .map((row, idx) => ({ ...row, rank: idx + 1 }));
};

/** Display value for a score cell, honouring the ranges toggle. */
export const scoreValue = (
  row: RecapRow,
  key: RangeKey,
  showRanges: boolean,
  window: string,
  decimals = 3
): string => {
  if (!showRanges) return fmt(row[key], decimals);
  const range = computedRanges(row, window)[key];
  return range ? fmtRange(range.low, range.high) : fmt(row[key], decimals);
};

/**
 * Interval-based rank range for each corps, derived from the total-score ranges
 * at the given window. Best (highest) possible rank = 1 + corps whose low total
 * still beats this corps' high total; worst possible rank = N − corps whose high
 * total still falls below this corps' low total. Keyed by corps name.
 */
export const computeRankRanges = (recap: RecapRow[], window: string): Map<string, Range> => {
  const totals = recap.map((row) => computedRanges(row, window).total);
  const map = new Map<string, Range>();
  recap.forEach((row, i) => {
    let definitelyAbove = 0;
    let definitelyBelow = 0;
    for (let j = 0; j < totals.length; j++) {
      if (j === i) continue;
      if (totals[j].low > totals[i].high) definitelyAbove++;
      if (totals[j].high < totals[i].low) definitelyBelow++;
    }
    map.set(String(row.corps ?? i), {
      low: 1 + definitelyAbove,
      high: recap.length - definitelyBelow,
    });
  });
  return map;
};

/** Format a rank range: a single number when unambiguous, else `low–high`. */
export const fmtRankRange = (
  range: Range | undefined,
  fallback: number | string | undefined
): string => {
  if (!range) return fallback == null ? '' : String(fallback);
  return range.low === range.high ? String(range.low) : `${range.low}-${range.high}`;
};

/** Every valid sort/range column key, for validating decoded URL sort tokens. */
const RANGE_KEYS = new Set<string>([...CAPTIONS, 'GE', 'Visual', 'Music', 'total']);

export type SortDir = 'desc' | 'asc';
export interface SortEntry {
  key: RangeKey;
  dir: SortDir;
}

/**
 * How multiple active column sorts coexist: `exclusive` keeps a single column;
 * `stack` keeps the whole ordered list (click order = tie-break priority).
 */
export type SortMode = 'exclusive' | 'stack';

/**
 * Per-column 3-state cycle applied to the active sort list: none → desc → asc →
 * none. In `exclusive` mode a column replaces the rest and the list never grows
 * past one; in `stack` mode a newly added column becomes primary while older
 * sorts remain as tie-breakers. Pure — returns the next sort list.
 */
/**
 * Key-agnostic 3-state sort cycle, shared by the compact recap (`RangeKey`
 * columns) and the full recap (opaque leaf-column ids). See `cycleSort` for the
 * per-mode semantics.
 */
export const cycleSortGeneric = <K extends string>(
  sorts: { key: K; dir: SortDir }[],
  key: K,
  mode: SortMode
): { key: K; dir: SortDir }[] => {
  const existing = sorts.find((s) => s.key === key);
  if (mode === 'exclusive') {
    if (!existing) return [{ key, dir: 'desc' }];
    if (existing.dir === 'desc') return [{ key, dir: 'asc' }];
    return [];
  }
  if (!existing) return [{ key, dir: 'desc' }, ...sorts];
  if (existing.dir === 'desc') return sorts.map((s) => (s.key === key ? { key, dir: 'asc' } : s));
  return sorts.filter((s) => s.key !== key);
};

export const cycleSort = (sorts: SortEntry[], key: RangeKey, mode: SortMode): SortEntry[] =>
  cycleSortGeneric(sorts, key, mode);

/** A full-recap sort entry keyed by an opaque leaf-column id (see `app/lib/full-recap.ts`). */
export interface FullSortEntry {
  key: string;
  dir: SortDir;
}

// Full-recap leaf ids may contain `:` (e.g. `GE1:judge-123:Rep`), so the compact
// `key:dir` encoding would be ambiguous. Use `!` as the dir separator — leaf ids
// are built to never contain `!` or `,` (see `app/lib/full-recap.ts`).
export const encodeFullSorts = (sorts: FullSortEntry[]): string =>
  sorts.map((s) => `${s.key}!${s.dir}`).join(',');

export const decodeFullSorts = (value: string | undefined): FullSortEntry[] => {
  if (!value) return [];
  return value
    .split(',')
    .map((token) => {
      const idx = token.lastIndexOf('!');
      if (idx <= 0) return null;
      const key = token.slice(0, idx);
      const dir = token.slice(idx + 1);
      if (!key || (dir !== 'desc' && dir !== 'asc')) return null;
      return { key, dir };
    })
    .filter((s): s is FullSortEntry => s !== null);
};

/** Serialize the active sort list for a URL: `total:desc,GE:asc`. */
export const encodeSorts = (sorts: SortEntry[]): string =>
  sorts.map((s) => `${s.key}:${s.dir}`).join(',');

/** Parse a `key:dir,key:dir` sort string back into entries, dropping invalid tokens. */
export const decodeSorts = (value: string | undefined): SortEntry[] => {
  if (!value) return [];
  return value
    .split(',')
    .map((token) => {
      const [key, dir] = token.split(':');
      if (!RANGE_KEYS.has(key) || (dir !== 'desc' && dir !== 'asc')) return null;
      return { key: key as RangeKey, dir };
    })
    .filter((s): s is SortEntry => s !== null);
};

// Column definitions for the recap score table (matches legacy layout/separators).
export const SCORE_COLUMNS: {
  key: RangeKey;
  label: string;
  separator?: boolean;
}[] = [
  { key: 'total', label: 'Total', separator: true },
  { key: 'GE', label: 'GE' },
  { key: 'Visual', label: 'Visual' },
  { key: 'Music', label: 'Music', separator: true },
  ...CAPTIONS.map((c) => ({ key: c as RangeKey, label: c })),
];

// Canonical display category for a raw division name. The source data carries
// several spellings per class — e.g. "All Age Class", "All-Age - Open Class",
// "All-Age - A Class" are all just All Age — so categorize by keyword rather
// than exact string. Order matters: All-Age is checked before Open because
// "All-Age - Open Class" contains both words but is an All Age unit.
export type DivisionCategory =
  | 'world'
  | 'open'
  | 'all-age'
  | 'international'
  | 'soundsport'
  | 'exhibition'
  | 'alumni'
  | 'other';

export const divisionCategory = (division: string | undefined): DivisionCategory => {
  const d = (division ?? '').toLowerCase();
  // All-Age first: DCA classes spell as "All-Age - World Class" / "All-Age - Open
  // Class", which also contain "world"/"open" but are All Age units.
  if (d.includes('all') && d.includes('age')) return 'all-age';
  if (d.includes('world')) return 'world';
  if (d.includes('international')) return 'international';
  if (d.includes('soundsport') || (d.includes('sound') && d.includes('sport'))) return 'soundsport';
  if (d.includes('exhibition')) return 'exhibition';
  if (d.includes('open')) return 'open';
  if (d.includes('alumni') || d.includes('legacy')) return 'alumni';
  return 'other';
};

export const classShortName = (division: string | undefined) => {
  switch (divisionCategory(division)) {
    case 'world':
      return 'World';
    case 'open':
      return 'Open';
    case 'all-age':
      return 'All Age';
    case 'international':
      return 'International';
    case 'soundsport':
      return 'SoundSport';
    case 'exhibition':
      return 'Exhibition';
    case 'alumni':
      return 'Alumni';
    default:
      return division || 'Unknown';
  }
};

export type RecapGroupKey = 'world' | 'open' | 'all-age' | 'other';

export const RECAP_GROUP_ORDER: RecapGroupKey[] = ['world', 'open', 'all-age', 'other'];

export const RECAP_GROUP_LABELS: Record<RecapGroupKey, string> = {
  world: 'World Class',
  open: 'Open Class',
  'all-age': 'All Age',
  other: 'Other',
};

export const recapGroup = (division: string | undefined): RecapGroupKey => {
  const cat = divisionCategory(division);
  if (cat === 'world' || cat === 'open' || cat === 'all-age') return cat;
  return 'other';
};
