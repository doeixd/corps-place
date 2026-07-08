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
  // Knowledge horizon: only data with competition_date < knowledgeDate is used for
  // template selection and same-season history. Defaults to targetDate (predict with
  // all data up to the event). Set it to a PAST date to reconstruct "prediction as of
  // <date>" faithfully (frozen knowledge) for the scrubber history.
  knowledgeDate?: string;
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
  input: Pick<
    V9PredictionFeatureInput,
    'corpsKey' | 'division' | 'templateSeason' | 'targetDate' | 'knowledgeDate'
  >
) {
  const templateSeasonClause = input.templateSeason ? 'AND season = ?' : '';
  const dateClause = input.templateSeason ? '' : 'AND competition_date < ?';
  const args = input.templateSeason
    ? [input.corpsKey, input.division, input.templateSeason]
    : [input.corpsKey, input.division, input.knowledgeDate ?? input.targetDate];

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

// The cold-start block (V9_COLD_START_STATIC_OFFSET .. +9) describes the TARGET show's
// season context (debut?, same-season history, days/percent-through, prior-season
// finish). The builder computes it per-target. When inference templates off a DIFFERENT
// season — e.g. a season opener with no same-season row falls back to last year's finals
// — the template's cold-start leaks that season's context, most damagingly
// percentThrough=1.0 (finals) into an early-season forecast, biasing predictions high
// (2026-06-27 barnum: 7th Regiment 64.6 predicted vs 47.25 actual). Recompute it for the
// target so the model sees the correct "as-of-target" context. Mirrors the builder's
// cold-start section (see buildSequencesV9).
async function computeColdStartBlock(
  db: Client,
  input: V9PredictionFeatureInput,
  priorSeasonRank: number | undefined
): Promise<number[]> {
  const season = String(input.season ?? input.targetDate.slice(0, 4));
  const prevSeason = String(Number(season) - 1);
  const target = input.targetDate;
  // Same-season history is known only up to the knowledge horizon (defaults to the
  // event date); the day-diffs below are still measured to the forecast target.
  const horizon = input.knowledgeDate ?? input.targetDate;
  const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const nScore = (s: number) => (s - 70) / 30;
  const nRank = (r: number) => Math.max(1, Math.min(25, Math.round(r))) / 25;
  const nDays = (d: number) => Math.min(Math.max(d, 0), 120) / 120;
  const nRecent = (d: number) => Math.min(Math.max(d, 0), 14) / 14;
  const nOff = (d: number) => Math.min(Math.max(d, 0), 365) / 365;

  const ss = await db.execute({
    sql: `SELECT competition_date AS d FROM corps_competition_results
          WHERE corps_key = ? AND season = ? AND competition_date < ? ORDER BY competition_date`,
    args: [input.corpsKey, season, horizon],
  });
  const pastDates = ss.rows.map((r) => String(r.d));
  const pastCount = pastDates.length;
  const lastSame = pastCount ? pastDates[pastCount - 1]! : undefined;

  const fs = await db.execute({
    sql: `SELECT MIN(competition_date) AS d FROM corps_competition_results
          WHERE season = ? AND competition_date < ?`,
    args: [season, horizon],
  });
  const firstScored = fs.rows[0]?.d ? String(fs.rows[0].d) : undefined;

  const ps = await db.execute({
    sql: `SELECT MAX(total_score) AS t, MAX(competition_date) AS d
          FROM corps_competition_results WHERE corps_key = ? AND season = ?`,
    args: [input.corpsKey, prevSeason],
  });
  const prevTotal = ps.rows[0]?.t != null ? Number(ps.rows[0].t) : undefined;
  const prevLast = ps.rows[0]?.d ? String(ps.rows[0].d) : undefined;
  const lastAnyScored = lastSame ?? prevLast;

  return [
    pastCount === 0 ? 1 : 0, // isSeasonDebut
    Math.min(pastCount, 40) / 40, // sameSeasonHistoryCount
    lastSame ? nRecent(days(lastSame, target)) : 1, // daysSinceLastSameSeasonShow
    lastAnyScored ? nOff(days(lastAnyScored, target)) : 1, // daysSinceLastScoredAnySeason
    prevTotal != null ? nScore(prevTotal) : nScore(70), // lastSeasonFinalScore
    nRank(priorSeasonRank ?? 12), // lastSeasonFinalRank
    firstScored && firstScored === target ? 1 : 0, // isFirstScoredEventOfSeason
    firstScored ? Math.min(Math.floor(days(firstScored, target) / 7), 12) / 12 : 0, // eventWeekIndex
    firstScored ? nDays(days(firstScored, target)) : 0, // targetDayOfSeason
    Math.max(0, Math.min(1, (input.percentThrough ?? 50) / 100)), // percentThrough
  ];
}

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
  // ALWAYS recompute the cold-start block for the TARGET. The template's block reflects
  // the template show's season context — percentThrough, shows-so-far, days-since-start,
  // event-week — which is stale for the event we're forecasting (a same-season template
  // is the corps' LAST show, so e.g. percentThrough/178 would read the last show's ~2%
  // instead of the target's 19%). All 10 features are known for the target, and training
  // stored each row's block for ITS OWN show, so this matches the training distribution
  // and stays consistent with the curve baseline (also rebuilt at the target percent).
  const coldStart = await computeColdStartBlock(db, input, priorSeasonRank);
  for (let i = 0; i < coldStart.length; i++) {
    rawStatic[V9_COLD_START_STATIC_OFFSET + i] = coldStart[i]!;
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
