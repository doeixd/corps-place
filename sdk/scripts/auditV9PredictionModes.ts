import { getV9CaptionBaseline } from '../src/training/v9Baselines.js';
import { buildV9PredictionFeatures } from '../src/training/v9PredictionFeatures.js';
import {
  applyV9PredictionContextMode,
  V9_FEATURE_INDICES,
  V9_RAW_STATIC_DIM,
} from '../src/training/v9FeatureModes.js';

type Result = {
  name: string;
  ok: boolean;
  details: string;
};

const zeroRange = (values: number[], start: number, end: number) =>
  values.slice(start, end + 1).every((value) => value === 0);

const allValue = (values: number[], start: number, end: number, expected: number) =>
  values.slice(start, end + 1).every((value) => value === expected);

const baseStatic = () =>
  Array.from({ length: V9_RAW_STATIC_DIM }, (_, idx) => {
    if (idx === V9_FEATURE_INDICES.previousRank) return 4 / 25;
    if (idx === V9_FEATURE_INDICES.meanRank) return 8 / 25;
    if (idx >= V9_FEATURE_INDICES.judgeEloStart && idx <= V9_FEATURE_INDICES.judgeEloEnd)
      return 0.5;
    if (
      idx >= V9_FEATURE_INDICES.opponentContextStart &&
      idx <= V9_FEATURE_INDICES.opponentContextEnd
    )
      return 0.25;
    if (idx >= V9_FEATURE_INDICES.lastResidualStart && idx <= V9_FEATURE_INDICES.lastResidualEnd)
      return 0.1;
    return 0.2;
  });

const results: Result[] = [];
const push = (name: string, ok: boolean, details: string) => results.push({ name, ok, details });

const preseason = applyV9PredictionContextMode(baseStatic(), {
  mode: 'preseason_forecast',
  seedRank: 3,
  fieldSize: 5,
  recapMean: [16, 16, 16, 16, 16, 16, 16, 16],
});

push(
  'preseason_zeroes_same_season_history',
  preseason[V9_FEATURE_INDICES.sequenceLength] === 0 &&
    preseason[V9_FEATURE_INDICES.pastShowsCount] === 0 &&
    zeroRange(preseason, V9_FEATURE_INDICES.lastResidualStart, V9_FEATURE_INDICES.lastResidualEnd),
  'sequence length, past show count, and same-season residual features must be masked'
);
push(
  'preseason_replaces_current_rank_with_seed',
  preseason[V9_FEATURE_INDICES.previousRank] === 3 / 25 &&
    preseason[V9_FEATURE_INDICES.rankEma] === 3 / 25,
  'preseason rank features should use supplied seed rank, not current-season rank'
);
push(
  'preseason_masks_judges_and_lineup',
  zeroRange(preseason, V9_FEATURE_INDICES.judgeEloStart, V9_FEATURE_INDICES.judgeEloEnd) &&
    allValue(
      preseason,
      V9_FEATURE_INDICES.performanceOrderStart,
      V9_FEATURE_INDICES.performanceOrderEnd,
      -1
    ) &&
    zeroRange(
      preseason,
      V9_FEATURE_INDICES.opponentContextStart,
      V9_FEATURE_INDICES.opponentContextEnd
    ),
  'preseason should mask panel, performance order, and opponent-current-form features'
);

const panelUnknown = applyV9PredictionContextMode(baseStatic(), { mode: 'panel_unknown' });
push(
  'panel_unknown_masks_only_judges',
  zeroRange(panelUnknown, V9_FEATURE_INDICES.judgeEloStart, V9_FEATURE_INDICES.judgeEloEnd) &&
    !zeroRange(
      panelUnknown,
      V9_FEATURE_INDICES.opponentContextStart,
      V9_FEATURE_INDICES.opponentContextEnd
    ),
  'panel_unknown masks judge Elo while preserving known lineup/opponent context'
);

const lineupUnknown = applyV9PredictionContextMode(baseStatic(), {
  mode: 'lineup_unknown',
  fieldSize: 12,
});
push(
  'lineup_unknown_masks_lineup_context',
  allValue(
    lineupUnknown,
    V9_FEATURE_INDICES.performanceOrderStart,
    V9_FEATURE_INDICES.performanceOrderEnd,
    -1
  ) &&
    zeroRange(
      lineupUnknown,
      V9_FEATURE_INDICES.opponentContextStart,
      V9_FEATURE_INDICES.opponentContextEnd
    ) &&
    !zeroRange(lineupUnknown, V9_FEATURE_INDICES.judgeEloStart, V9_FEATURE_INDICES.judgeEloEnd),
  'lineup_unknown masks performance/opponent context while preserving judge context'
);

const baseline = getV9CaptionBaseline({
  mode: 'preseason_forecast',
  division: 'World Class',
  percentThrough: 40,
  seedRank: 2,
  priorSeasonRank: 5,
  historicalMeanRank: 8,
});
push(
  'baseline_provenance_prefers_seed_for_preseason',
  baseline.rankSource === 'seed_rank' &&
    baseline.confidence === 'estimated' &&
    Object.keys(baseline.captions).length === 8,
  'preseason baseline should use seed rank when supplied and report estimated provenance'
);

const fakeDb = {
  execute: async () => ({ rows: [] }),
} as any;

const synthetic = await buildV9PredictionFeatures(fakeDb, {
  mode: 'preseason_forecast',
  corpsKey: 'brand-new-corps',
  division: 'World Class',
  targetDate: '2026-07-01',
  percentThrough: 20,
  seedRank: 12,
  fieldSize: 18,
});
push(
  'synthetic_unknown_corps_feature_builder',
  synthetic.provenance.template.source === 'synthetic_unknown_corps' &&
    synthetic.corpsId === 0 &&
    synthetic.corpsScale === 0 &&
    synthetic.sequence.length === 0 &&
    synthetic.judgeIndices.every((idx) => idx === 0),
  'missing corps template should still produce a valid unknown-corps preseason feature packet'
);

console.table(results);
const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(
    `V9 prediction mode audit failed: ${failed.map((result) => result.name).join(', ')}`
  );
  process.exitCode = 1;
} else {
  console.log('V9 prediction mode audit passed.');
}
