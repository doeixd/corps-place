import type { Client } from '@libsql/client';
import {
  getV9CaptionBaseline,
  V9_CAPTIONS,
  type V9BaselineResult,
  type V9Caption,
} from './v9Baselines.js';
import { applyV9PredictionContextMode, type PredictionContextMode } from './v9FeatureModes.js';
import {
  V9_COLD_START_STATIC_OFFSET,
  V9_FEATURE_INDICES,
  V9_RAW_STATIC_DIM,
} from './v9FeatureModes.js';

export type V9MlTemplateRow = {
  corps_key: string;
  corps_id: number;
  season: string;
  division_name: string;
  competition_slug: string;
  competition_date: string;
  x_sequence_json: string;
  x_static_json: string;
  judge_indices_json: string;
  y_recap_json: string;
  y_total: number;
  agnostic_show_id?: number;
};

export type V9PredictionFeatureInput = {
  mode: PredictionContextMode;
  corpsKey: string;
  division: string;
  targetDate: string;
  percentThrough: number;
  season?: string;
  seedRank?: number;
  currentRank?: number;
  priorSeasonRank?: number;
  historicalMeanRank?: number;
  fieldSize?: number;
  judgeIndices?: number[];
  keepKnownLineupContext?: boolean;
  templateSeason?: string;
};

export type V9PredictionFeatures = {
  sequence: number[][];
  staticFeatures: number[];
  judgeIndices: number[];
  baselineRecap: number[];
  observedHistoryLen: number;
  corpsId: number;
  judgeBiasScale: number;
  corpsScale: number;
  agnosticShowId: number;
  baseline: V9BaselineResult;
  provenance: {
    mode: PredictionContextMode;
    template: {
      season: string;
      competitionSlug: string;
      competitionDate: string;
      yTotal: number;
      source: 'historical_template' | 'synthetic_unknown_corps';
    };
    fields: {
      sequence: 'actual_prior_history' | 'masked_preseason';
      staticContext: 'as_of_show_date' | 'preseason_masked' | 'lineup_masked' | 'panel_masked';
      judges: 'actual' | 'masked_unknown';
      baseline: V9BaselineResult;
    };
  };
};

export const totalFromV9Captions = (captions: Record<V9Caption, number>) =>
  captions.GE1 +
  captions.GE2 +
  (captions.VP + captions.VA + captions.CG) / 2 +
  (captions.MB + captions.MA + captions.MP) / 2;

export async function loadV9TemplateRow(
  db: Client,
  input: Pick<V9PredictionFeatureInput, 'corpsKey' | 'division' | 'templateSeason' | 'targetDate'>
) {
  const templateSeasonClause = input.templateSeason ? 'AND season = ?' : '';
  const dateClause = input.templateSeason ? '' : 'AND competition_date < ?';
  const args = input.templateSeason
    ? [input.corpsKey, input.division, input.templateSeason]
    : [input.corpsKey, input.division, input.targetDate];

  const result = await db.execute({
    sql: `
      SELECT season, division_name, corps_key, corps_id, competition_slug, competition_date,
             x_sequence_json, x_static_json, judge_indices_json, y_recap_json, y_total
             , agnostic_show_id
      FROM ml_sequence_rows_v9_subcaption
      WHERE corps_key = ?
        AND division_name = ?
        ${templateSeasonClause}
        ${dateClause}
      ORDER BY competition_date DESC
      LIMIT 1
    `,
    args,
  });
  return result.rows[0] as unknown as V9MlTemplateRow | undefined;
}

const normalizedRank = (rank?: number) => {
  if (!Number.isFinite(rank)) return 15 / 25;
  return Math.max(1, Math.min(25, Math.round(rank!))) / 25;
};

const normalizedPercent = (percentThrough: number) =>
  Math.max(0, Math.min(1, Number.isFinite(percentThrough) ? percentThrough / 100 : 0.5));

const normalizedFieldSize = (fieldSize?: number) => {
  if (!Number.isFinite(fieldSize)) return 20 / 25;
  return Math.max(1, Math.min(40, Math.round(fieldSize!))) / 25;
};

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const std = (values: number[]) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1)
  );
};

type CaptionFingerprintEntry = {
  season: number;
  percentThrough: number;
  residuals: Record<V9Caption, number>;
};

const emptyResiduals = () =>
  Object.fromEntries(V9_CAPTIONS.map((caption) => [caption, 0])) as Record<V9Caption, number>;

const averageResiduals = (entries: CaptionFingerprintEntry[]) => {
  const result = emptyResiduals();
  if (!entries.length) return result;
  for (const caption of V9_CAPTIONS) {
    result[caption] = mean(entries.map((entry) => entry.residuals[caption] ?? 0));
  }
  return result;
};

const weightedResiduals = (entries: CaptionFingerprintEntry[]) => {
  const result = emptyResiduals();
  if (!entries.length) return result;
  const maxSeason = Math.max(...entries.map((entry) => entry.season));
  for (const caption of V9_CAPTIONS) {
    let weightedSum = 0;
    let weightSum = 0;
    for (const entry of entries) {
      const weight = Math.pow(0.65, Math.max(0, maxSeason - entry.season));
      weightedSum += (entry.residuals[caption] ?? 0) * weight;
      weightSum += weight;
    }
    result[caption] = weightSum > 0 ? weightedSum / weightSum : 0;
  }
  return result;
};

const growthResiduals = (entries: CaptionFingerprintEntry[]) => {
  const result = emptyResiduals();
  for (const caption of V9_CAPTIONS) {
    const bySeason = new Map<number, { early: number[]; late: number[] }>();
    for (const entry of entries) {
      const bucket = bySeason.get(entry.season) ?? { early: [], late: [] };
      if (entry.percentThrough <= 35) bucket.early.push(entry.residuals[caption] ?? 0);
      if (entry.percentThrough >= 75) bucket.late.push(entry.residuals[caption] ?? 0);
      bySeason.set(entry.season, bucket);
    }
    result[caption] = mean(
      [...bySeason.values()]
        .filter((bucket) => bucket.early.length > 0 && bucket.late.length > 0)
        .map((bucket) => mean(bucket.late) - mean(bucket.early))
    );
  }
  return result;
};

const volatilityResiduals = (entries: CaptionFingerprintEntry[]) => {
  const result = emptyResiduals();
  for (const caption of V9_CAPTIONS) {
    result[caption] = std(entries.map((entry) => entry.residuals[caption] ?? 0));
  }
  return result;
};

const captionFingerprintBaselineAdjustments = (features: number[], confidence: number) => {
  const raw = V9_CAPTIONS.map((_, idx) => {
    const priorResidual = (features[idx * 4] ?? 0) * 2;
    const multiResidual = (features[idx * 4 + 1] ?? 0) * 2;
    return 0.55 * priorResidual + 0.45 * multiResidual;
  });
  const center = mean(raw);
  const confidenceWeight = Math.min(1, Math.max(0, confidence));
  return raw.map((value) => {
    const centered = (value - center) * confidenceWeight;
    return Math.max(-0.6, Math.min(0.6, centered));
  });
};

const RECAP_OFFSET_IN_FEATS = 21;
const CAPTION_STRIDE = 4;
const CAPTION_SCORE_SCALE = 20;

const recapMapToVector = (recap: Record<V9Caption, number>) =>
  V9_CAPTIONS.map((caption) => Number(recap[caption] ?? 0));

const lastHistoryRecapFromSequence = (sequence: number[][]) => {
  for (let stepIdx = sequence.length - 1; stepIdx >= 0; stepIdx--) {
    const step = sequence[stepIdx];
    if (!step || !step.some((value) => value !== 0)) continue;
    const recap = V9_CAPTIONS.map((_, idx) => {
      const normalizedScore = step[RECAP_OFFSET_IN_FEATS + idx * CAPTION_STRIDE + 2] ?? 0;
      return normalizedScore * CAPTION_SCORE_SCALE;
    });
    if (recap.some((value) => Number.isFinite(value) && value > 0)) return recap;
  }
  return undefined;
};

async function loadV9CaptionFingerprintFeatures(db: Client, input: V9PredictionFeatureInput) {
  const targetSeason = Number(input.season ?? input.targetDate.slice(0, 4));
  if (!Number.isFinite(targetSeason)) return { features: [], confidence: 0 };

  const result = await db.execute({
    sql: `
      SELECT season, x_static_json, y_recap_json
      FROM ml_sequence_rows_v9_subcaption
      WHERE corps_key = ?
        AND division_name = ?
        AND CAST(season AS INTEGER) < ?
      ORDER BY competition_date ASC
    `,
    args: [input.corpsKey, input.division, targetSeason],
  });

  const entries: CaptionFingerprintEntry[] = [];
  for (const row of result.rows) {
    try {
      const stat = JSON.parse(String(row.x_static_json)) as number[];
      const recap = JSON.parse(String(row.y_recap_json)) as Record<V9Caption, number>;
      const residuals = emptyResiduals();
      for (let idx = 0; idx < V9_CAPTIONS.length; idx++) {
        const caption = V9_CAPTIONS[idx]!;
        const baseline = Number(stat[V9_FEATURE_INDICES.rankBaselineStart + idx] ?? 0) * 20;
        residuals[caption] = Number(recap[caption] ?? 0) - (baseline || 15);
      }
      entries.push({
        season: Number(row.season),
        percentThrough: Number(stat[V9_COLD_START_STATIC_OFFSET + 9] ?? 0) * 100,
        residuals,
      });
    } catch {
      continue;
    }
  }

  const priorSeasonEntries = entries.filter((entry) => entry.season === targetSeason - 1);
  const latestSeason = entries.length
    ? Math.max(...entries.map((entry) => entry.season))
    : -Infinity;
  const priorOrLatest = priorSeasonEntries.length
    ? priorSeasonEntries
    : entries.filter((entry) => entry.season === latestSeason);
  const recent = entries.filter((entry) => entry.season >= targetSeason - 3);
  const source = recent.length ? recent : entries;
  const prior = averageResiduals(priorOrLatest);
  const multi = weightedResiduals(source);
  const growth = growthResiduals(source);
  const vol = volatilityResiduals(source);
  const features: number[] = [];
  for (const caption of V9_CAPTIONS) {
    features.push(
      prior[caption] / 2,
      multi[caption] / 2,
      growth[caption] / 2,
      Math.min(vol[caption] / 2, 2)
    );
  }
  const confidence = Math.min(1, entries.length / 24);
  features.push(confidence);
  return { features, confidence };
}

const buildSyntheticStatic = (input: V9PredictionFeatureInput, baseline: V9BaselineResult) => {
  const staticFeatures = new Array(V9_RAW_STATIC_DIM).fill(0);
  const rank = normalizedRank(
    input.seedRank ?? input.priorSeasonRank ?? input.historicalMeanRank ?? baseline.rank
  );
  const historicalRank = normalizedRank(
    input.historicalMeanRank ?? input.priorSeasonRank ?? input.seedRank ?? baseline.rank
  );

  staticFeatures[V9_FEATURE_INDICES.previousRank] = rank;
  staticFeatures[V9_FEATURE_INDICES.meanRank] = historicalRank;
  staticFeatures[V9_FEATURE_INDICES.sequenceLength] = 0;
  staticFeatures[V9_FEATURE_INDICES.rankEma] = rank;
  staticFeatures[V9_FEATURE_INDICES.rankVsHistorical] = rank - historicalRank;
  staticFeatures[V9_FEATURE_INDICES.daysSinceLastMatch] = 1;
  staticFeatures[V9_FEATURE_INDICES.showsRemaining] = Math.max(
    0,
    1 - normalizedPercent(input.percentThrough)
  );
  staticFeatures[V9_FEATURE_INDICES.fieldSize] = normalizedFieldSize(input.fieldSize);
  staticFeatures[V9_FEATURE_INDICES.divisionStrength] = historicalRank;
  staticFeatures[V9_FEATURE_INDICES.pastShowsCount] = 0;
  for (
    let idx = V9_FEATURE_INDICES.rankBaselineStart;
    idx <= V9_FEATURE_INDICES.rankBaselineEnd;
    idx++
  ) {
    const captionIdx = idx - V9_FEATURE_INDICES.rankBaselineStart;
    staticFeatures[idx] =
      (V9_CAPTIONS.map((caption) => baseline.captions[caption])[captionIdx] ?? 15) / 20;
  }
  return staticFeatures;
};

export async function buildV9PredictionFeatures(
  db: Client,
  input: V9PredictionFeatureInput
): Promise<V9PredictionFeatures> {
  const template = await loadV9TemplateRow(db, input);
  const templateStatic = template ? (JSON.parse(template.x_static_json) as number[]) : undefined;
  const historicalMeanRank =
    input.historicalMeanRank ??
    (templateStatic && Number(templateStatic[2]) > 0 ? Number(templateStatic[2]) * 25 : undefined);
  const priorSeasonRank =
    input.priorSeasonRank ??
    (templateStatic && Number(templateStatic[0]) > 0 ? Number(templateStatic[0]) * 25 : undefined);

  const baseline = getV9CaptionBaseline({
    mode: input.mode,
    division: input.division,
    percentThrough: input.percentThrough,
    currentRank: input.currentRank,
    seedRank: input.seedRank,
    priorSeasonRank,
    historicalMeanRank,
  });

  const rawStatic = new Array(V9_RAW_STATIC_DIM).fill(0);
  const sourceStatic = templateStatic ?? buildSyntheticStatic(input, baseline);
  for (let idx = 0; idx < Math.min(sourceStatic.length, V9_RAW_STATIC_DIM); idx++) {
    rawStatic[idx] = sourceStatic[idx] ?? 0;
  }
  const fingerprint = await loadV9CaptionFingerprintFeatures(db, input);
  for (let idx = 0; idx < fingerprint.features.length; idx++) {
    const targetIdx = V9_FEATURE_INDICES.captionFingerprintStart + idx;
    if (targetIdx <= V9_FEATURE_INDICES.captionFingerprintEnd) {
      rawStatic[targetIdx] = fingerprint.features[idx] ?? 0;
    }
  }
  const captionAwareBaselineCaptions = { ...baseline.captions };
  if (input.mode === 'preseason_forecast' && fingerprint.confidence > 0) {
    const adjustments = captionFingerprintBaselineAdjustments(
      fingerprint.features,
      fingerprint.confidence
    );
    for (let idx = 0; idx < V9_CAPTIONS.length; idx++) {
      const caption = V9_CAPTIONS[idx]!;
      captionAwareBaselineCaptions[caption] = Math.max(
        0,
        Math.min(20, captionAwareBaselineCaptions[caption] + adjustments[idx]!)
      );
      rawStatic[V9_FEATURE_INDICES.rankBaselineStart + idx] =
        captionAwareBaselineCaptions[caption] / 20;
    }
  }
  const templateTargetRecap = template
    ? recapMapToVector(JSON.parse(template.y_recap_json) as Record<V9Caption, number>)
    : undefined;
  const rawSequence = template ? (JSON.parse(template.x_sequence_json) as number[][]) : [];
  const rawJudges = template
    ? (JSON.parse(template.judge_indices_json) as number[])
    : new Array(V9_CAPTIONS.length).fill(0);
  const lastHistoryRecap =
    input.mode === 'preseason_forecast'
      ? undefined
      : (templateTargetRecap ?? lastHistoryRecapFromSequence(rawSequence));
  const baselineRecap =
    lastHistoryRecap ?? V9_CAPTIONS.map((caption) => captionAwareBaselineCaptions[caption]);
  const observedHistoryLen =
    input.mode === 'preseason_forecast'
      ? 0
      : rawSequence.filter((step) => step.some((value) => value !== 0)).length +
        (templateTargetRecap ? 1 : 0);

  const staticFeatures = applyV9PredictionContextMode(rawStatic, {
    mode: input.mode,
    seedRank: input.seedRank ?? priorSeasonRank ?? historicalMeanRank,
    fieldSize: input.fieldSize,
    keepKnownLineupContext: input.keepKnownLineupContext,
    recapMean: V9_CAPTIONS.map((caption) => captionAwareBaselineCaptions[caption]),
  });

  const sequence = input.mode === 'preseason_forecast' ? [] : rawSequence;
  const candidateJudgeIndices = input.judgeIndices ?? rawJudges;
  const hasKnownJudges = candidateJudgeIndices.some((idx) => Number.isFinite(idx) && idx > 0);
  const judgesUnknown =
    input.mode === 'panel_unknown' || input.mode === 'preseason_forecast' || !hasKnownJudges;
  const judgeIndices = judgesUnknown
    ? new Array(V9_CAPTIONS.length).fill(0)
    : candidateJudgeIndices;

  const staticContext =
    input.mode === 'preseason_forecast'
      ? 'preseason_masked'
      : input.mode === 'lineup_unknown'
        ? 'lineup_masked'
        : input.mode === 'panel_unknown'
          ? 'panel_masked'
          : 'as_of_show_date';

  return {
    sequence,
    staticFeatures,
    judgeIndices,
    baselineRecap,
    observedHistoryLen,
    corpsId: template ? Number(template.corps_id) : 0,
    judgeBiasScale: judgesUnknown ? 0 : 1,
    corpsScale: template ? 1 : 0,
    agnosticShowId:
      input.mode === 'preseason_forecast' || !template ? 0 : Number(template.agnostic_show_id ?? 0),
    baseline: { ...baseline, captions: captionAwareBaselineCaptions },
    provenance: {
      mode: input.mode,
      template: {
        season: String(template?.season ?? input.season ?? input.templateSeason ?? 'unknown'),
        competitionSlug: String(template?.competition_slug ?? 'synthetic-unknown-corps'),
        competitionDate: String(template?.competition_date ?? input.targetDate),
        yTotal: Number(template?.y_total ?? totalFromV9Captions(baseline.captions)),
        source: template ? 'historical_template' : 'synthetic_unknown_corps',
      },
      fields: {
        sequence: input.mode === 'preseason_forecast' ? 'masked_preseason' : 'actual_prior_history',
        staticContext,
        judges: judgesUnknown ? 'masked_unknown' : 'actual',
        baseline: { ...baseline, captions: captionAwareBaselineCaptions },
      },
    },
  };
}
