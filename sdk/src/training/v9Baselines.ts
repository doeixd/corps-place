import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PredictionContextMode } from './v9FeatureModes.js';

export const V9_CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
export type V9Caption = (typeof V9_CAPTIONS)[number];

export type V9BaselineRankSource =
  | 'current_rank'
  | 'seed_rank'
  | 'prior_season_rank'
  | 'historical_mean_rank';

export type V9BaselineConfidence = 'actual' | 'estimated';

export type V9BaselineInput = {
  mode: PredictionContextMode;
  division: string;
  percentThrough: number;
  currentRank?: number;
  seedRank?: number;
  priorSeasonRank?: number;
  historicalMeanRank?: number;
  referenceCurvesPath?: string;
};

export type V9BaselineResult = {
  captions: Record<V9Caption, number>;
  rank: number;
  rankSource: V9BaselineRankSource;
  confidence: V9BaselineConfidence;
  percentThrough: number;
  division: string;
};

type ReferenceCurves = {
  curves?: Record<string, Record<string, number>>;
};

let cachedCurvesPath: string | null = null;
let cachedCurves: ReferenceCurves | null = null;
// Resolved lazily (not at module top level) so importing this module is safe in
// non-Node contexts — e.g. the Vite dev client bundle, where `node:url` is
// externalized and a top-level `fileURLToPath` call would throw.
const getDefaultReferenceCurvesPath = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'referenceCurvesV4.json');

const loadReferenceCurves = (filePath: string) => {
  if (cachedCurves && cachedCurvesPath === filePath) return cachedCurves;
  cachedCurves = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ReferenceCurves;
  cachedCurvesPath = filePath;
  return cachedCurves;
};

const validRank = (value?: number) =>
  Number.isFinite(value) && value! > 0 ? Math.max(1, Math.min(25, Math.round(value!))) : null;

const validPercent = (value: number) =>
  Math.max(0, Math.min(100, Math.round((Number.isFinite(value) ? value : 50) / 5) * 5));

const selectRank = (
  input: V9BaselineInput
): Pick<V9BaselineResult, 'rank' | 'rankSource' | 'confidence'> => {
  const currentRank = validRank(input.currentRank);
  const seedRank = validRank(input.seedRank);
  const priorSeasonRank = validRank(input.priorSeasonRank);
  const historicalMeanRank = validRank(input.historicalMeanRank);

  if (
    input.mode === 'as_of_show_date' ||
    input.mode === 'panel_unknown' ||
    input.mode === 'lineup_unknown'
  ) {
    if (currentRank) return { rank: currentRank, rankSource: 'current_rank', confidence: 'actual' };
    if (seedRank) return { rank: seedRank, rankSource: 'seed_rank', confidence: 'estimated' };
  }

  if (input.mode === 'preseason_forecast' && seedRank) {
    return { rank: seedRank, rankSource: 'seed_rank', confidence: 'estimated' };
  }
  if (priorSeasonRank) {
    return { rank: priorSeasonRank, rankSource: 'prior_season_rank', confidence: 'estimated' };
  }
  if (historicalMeanRank) {
    return {
      rank: historicalMeanRank,
      rankSource: 'historical_mean_rank',
      confidence: 'estimated',
    };
  }
  return { rank: 15, rankSource: 'historical_mean_rank', confidence: 'estimated' };
};

export function getV9CaptionBaseline(input: V9BaselineInput): V9BaselineResult {
  const referenceCurvesPath = input.referenceCurvesPath ?? getDefaultReferenceCurvesPath();
  const referenceCurves = loadReferenceCurves(referenceCurvesPath);
  const rankSelection = selectRank(input);
  const bucket = validPercent(input.percentThrough);
  const division = input.division || 'World Class';

  const captions = Object.fromEntries(
    V9_CAPTIONS.map((caption) => {
      const exact =
        referenceCurves.curves?.[`${division}|${rankSelection.rank}-${bucket}`]?.[caption];
      const midSeason = referenceCurves.curves?.[`${division}|${rankSelection.rank}-50`]?.[caption];
      const legacy = referenceCurves.curves?.[`${rankSelection.rank}-${bucket}`]?.[caption];
      return [caption, exact ?? midSeason ?? legacy ?? 15];
    })
  ) as Record<V9Caption, number>;

  return {
    captions,
    rank: rankSelection.rank,
    rankSource: rankSelection.rankSource,
    confidence: rankSelection.confidence,
    percentThrough: bucket,
    division,
  };
}
