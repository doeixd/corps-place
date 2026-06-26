// /rankings — shared types (RANKINGS_PAGE_PLAN.md). Client-safe (no server/SDK
// value imports), so the codec, machine, list, and chart all share these.

export const RANK_METRICS = ['total', 'ge', 'visual', 'guard', 'brass', 'perc'] as const;
export type RankMetric = (typeof RANK_METRICS)[number];

export const RANK_METRIC_LABELS: Record<RankMetric, string> = {
  total: 'Total',
  ge: 'General Effect',
  visual: 'Visual',
  guard: 'Color Guard',
  brass: 'Brass',
  perc: 'Percussion',
};

export type RankAgg = 'best' | 'last3';
export type RankGroup = 'overall' | 'division';

/** Division category keys (from `divisionCategory`) the `div` filter offers. */
export const RANK_DIVISIONS = ['world', 'open', 'all-age'] as const;
export type RankDivision = (typeof RANK_DIVISIONS)[number];
export const DEFAULT_DIVISIONS: RankDivision[] = ['world', 'open'];

/** One corps in the resolved standings. */
export interface RankRow {
  corpsSlug: string;
  corpsName: string;
  division: string; // raw division name (UI groups via recapGroup)
  score: number;
  rank: number; // overall rank by aggregated score at asof
  lastPerformedDate: string; // YYYY-MM-DD
  daysSinceLast: number; // asof − lastPerformed (recency indicator)
  partial: boolean; // last3 had <3 shows
  /** Rank history for the bump chart: one point per competition day ≤ asof on
   *  which the corps had a standing. */
  history: { date: string; rank: number; score: number }[];
}

export interface RankingsResult {
  season: string;
  asof: string | null; // resolved as-of day (YYYY-MM-DD); null = no data
  /** Competition days ≤ asof (bump-chart x-axis + the as-of scrubber). */
  dates: string[];
  rows: RankRow[];
}

export const RANK_SERIES_CAP = 18; // bump-chart line cap (top N + selected)
