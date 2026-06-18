import {
  V9_BREAKDOWN_CAPTIONS,
  type V9BreakdownCaption,
  type V9BreakdownPair,
} from './v9BreakdownData.js';

export const V9_BREAKDOWN_SPLIT_CURVE_VERSION = 'v9-breakdown-split-curves-2026-06-05';

export type V9BreakdownSplitCurvePoint = {
  percentThroughSeason: number;
  contentShare: number;
  rawContentShare: number;
  count: number;
  medianContentShare: number;
  stdContentShare: number;
  q10ContentShare: number;
  q90ContentShare: number;
};

export type V9BreakdownSplitCurve = {
  count: number;
  contentShare: number;
  points: V9BreakdownSplitCurvePoint[];
};

export type V9BreakdownSplitCurveArtifact = {
  version: string;
  generatedAt: string;
  source: {
    dbPath: string;
    sourceV9ModelId: string | null;
    anchorMode: string | null;
    rowCount: number;
    pairCount: number;
  };
  config: {
    bucketSize: number;
    minShare: number;
    maxShare: number;
    divisionCaptionPrior: number;
    captionPrior: number;
    divisionPrior: number;
    globalPrior: number;
  };
  global: V9BreakdownSplitCurve;
  byCaption: Partial<Record<V9BreakdownCaption, V9BreakdownSplitCurve>>;
  byDivision: Record<string, V9BreakdownSplitCurve>;
  byDivisionCaption: Record<string, V9BreakdownSplitCurve>;
  evaluation?: {
    validationPairCount: number;
    fixed50ShareMae: number | null;
    curveShareMae: number | null;
    fixed50SubcaptionMaePtsUsingActualCaptionTotal: number | null;
    curveSubcaptionMaePtsUsingActualCaptionTotal: number | null;
    improvementVs50Pts: number | null;
    improvementVs50Tenths: number | null;
  };
};

export type V9BreakdownSplitInput = {
  divisionName?: string | null;
  caption: V9BreakdownCaption | string;
  percentThroughSeason?: number | null;
};

export type V9BreakdownPriorShare = {
  count: number;
  meanShare: number;
  emaShare?: number | null;
  latestShare?: number | null;
  stdShare?: number | null;
  latestDate?: string | null;
  daysSinceLatest?: number | null;
};

export type V9BreakdownPriorBlendConfig = {
  enabled: boolean;
  baseWeight: number;
  maxWeight: number;
  strongCount: number;
  emaAlpha: number;
  maxPriorAgeDays: number;
  minShare: number;
  maxShare: number;
};

export type V9BreakdownSplitAudit = V9BreakdownPair & {
  contentShare: number;
  curveShare: number;
  priorShare: number | null;
  priorWeight: number;
  priorCount: number;
  splitSource: 'curve_only' | 'curve_prior_blend';
};

export const DEFAULT_V9_BREAKDOWN_PRIOR_BLEND_CONFIG: V9BreakdownPriorBlendConfig = {
  enabled: false,
  baseWeight: 0.35,
  maxWeight: 0.4,
  strongCount: 3,
  emaAlpha: 0.55,
  maxPriorAgeDays: 45,
  minShare: 0.49,
  maxShare: 0.53,
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const assertFiniteNumber = (value: unknown, path: string) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid V9 breakdown split curve artifact: ${path} must be a finite number.`);
  }
};

const assertCurve = (value: unknown, path: string) => {
  if (!isRecord(value)) {
    throw new Error(`Invalid V9 breakdown split curve artifact: ${path} must be an object.`);
  }
  assertFiniteNumber(value.count, `${path}.count`);
  assertFiniteNumber(value.contentShare, `${path}.contentShare`);
  if (!Array.isArray(value.points) || value.points.length === 0) {
    throw new Error(`Invalid V9 breakdown split curve artifact: ${path}.points must be a non-empty array.`);
  }
  for (const [idx, point] of value.points.entries()) {
    if (!isRecord(point)) {
      throw new Error(`Invalid V9 breakdown split curve artifact: ${path}.points[${idx}] must be an object.`);
    }
    assertFiniteNumber(point.percentThroughSeason, `${path}.points[${idx}].percentThroughSeason`);
    assertFiniteNumber(point.contentShare, `${path}.points[${idx}].contentShare`);
    assertFiniteNumber(point.rawContentShare, `${path}.points[${idx}].rawContentShare`);
    assertFiniteNumber(point.count, `${path}.points[${idx}].count`);
    assertFiniteNumber(point.medianContentShare, `${path}.points[${idx}].medianContentShare`);
    assertFiniteNumber(point.stdContentShare, `${path}.points[${idx}].stdContentShare`);
    assertFiniteNumber(point.q10ContentShare, `${path}.points[${idx}].q10ContentShare`);
    assertFiniteNumber(point.q90ContentShare, `${path}.points[${idx}].q90ContentShare`);
  }
};

export function assertValidV9BreakdownSplitCurveArtifact(
  artifact: unknown
): asserts artifact is V9BreakdownSplitCurveArtifact {
  if (!isRecord(artifact)) {
    throw new Error('Invalid V9 breakdown split curve artifact: root must be an object.');
  }
  if (artifact.version !== V9_BREAKDOWN_SPLIT_CURVE_VERSION) {
    throw new Error(
      `Invalid V9 breakdown split curve artifact: unsupported version ${String(
        artifact.version
      )}; expected ${V9_BREAKDOWN_SPLIT_CURVE_VERSION}.`
    );
  }
  if (!isRecord(artifact.config)) {
    throw new Error('Invalid V9 breakdown split curve artifact: config must be an object.');
  }
  for (const key of [
    'bucketSize',
    'minShare',
    'maxShare',
    'divisionCaptionPrior',
    'captionPrior',
    'divisionPrior',
    'globalPrior',
  ]) {
    assertFiniteNumber(artifact.config[key], `config.${key}`);
  }
  if ((artifact.config.minShare as number) >= (artifact.config.maxShare as number)) {
    throw new Error('Invalid V9 breakdown split curve artifact: config.minShare must be below config.maxShare.');
  }
  assertCurve(artifact.global, 'global');
  if (!isRecord(artifact.byCaption)) {
    throw new Error('Invalid V9 breakdown split curve artifact: byCaption must be an object.');
  }
  for (const caption of V9_BREAKDOWN_CAPTIONS) {
    if (artifact.byCaption[caption] != null) assertCurve(artifact.byCaption[caption], `byCaption.${caption}`);
  }
  if (!isRecord(artifact.byDivision)) {
    throw new Error('Invalid V9 breakdown split curve artifact: byDivision must be an object.');
  }
  for (const [key, curve] of Object.entries(artifact.byDivision)) assertCurve(curve, `byDivision.${key}`);
  if (!isRecord(artifact.byDivisionCaption)) {
    throw new Error('Invalid V9 breakdown split curve artifact: byDivisionCaption must be an object.');
  }
  for (const [key, curve] of Object.entries(artifact.byDivisionCaption)) {
    const [, caption] = key.split('|');
    if (!caption || !isV9BreakdownCaption(caption)) {
      throw new Error(`Invalid V9 breakdown split curve artifact: bad division-caption key ${key}.`);
    }
    assertCurve(curve, `byDivisionCaption.${key}`);
  }
}

export const validateV9BreakdownSplitCurveArtifact = (
  artifact: unknown
): V9BreakdownSplitCurveArtifact => {
  assertValidV9BreakdownSplitCurveArtifact(artifact);
  return artifact;
};

export const normalizeV9BreakdownDivisionName = (divisionName?: string | null) => {
  const normalized = String(divisionName ?? 'Unknown').trim().replace(/\s+/g, ' ');
  return normalized || 'Unknown';
};

export const v9BreakdownDivisionCaptionKey = (
  divisionName: string | null | undefined,
  caption: V9BreakdownCaption
) => `${normalizeV9BreakdownDivisionName(divisionName)}|${caption}`;

export const isV9BreakdownCaption = (caption: string): caption is V9BreakdownCaption =>
  (V9_BREAKDOWN_CAPTIONS as readonly string[]).includes(caption);

export const clampV9BreakdownPercentThroughSeason = (percentThroughSeason?: number | null) => {
  const value = Number(percentThroughSeason);
  return Number.isFinite(value) ? clamp(value, 0, 100) : 50;
};

const normalizeCaptionInput = (caption: V9BreakdownCaption | string) => {
  const upper = String(caption).trim().toUpperCase();
  if (!isV9BreakdownCaption(upper)) {
    throw new Error(`Unsupported V9 breakdown caption: ${caption}`);
  }
  return upper;
};

const interpolateCurve = (
  curve: V9BreakdownSplitCurve | undefined,
  percentThroughSeason: number
) => {
  if (!curve?.points.length) return null;
  const points = curve.points
    .filter((point) => Number.isFinite(point.contentShare))
    .sort((left, right) => left.percentThroughSeason - right.percentThroughSeason);
  if (!points.length) return null;
  if (percentThroughSeason <= points[0]!.percentThroughSeason) {
    return { share: points[0]!.contentShare, count: points[0]!.count };
  }
  const last = points[points.length - 1]!;
  if (percentThroughSeason >= last.percentThroughSeason) {
    return { share: last.contentShare, count: last.count };
  }

  for (let idx = 1; idx < points.length; idx += 1) {
    const right = points[idx]!;
    const left = points[idx - 1]!;
    if (percentThroughSeason > right.percentThroughSeason) continue;
    const span = right.percentThroughSeason - left.percentThroughSeason;
    const ratio = span > 0 ? (percentThroughSeason - left.percentThroughSeason) / span : 0;
    return {
      share: left.contentShare + (right.contentShare - left.contentShare) * ratio,
      count: Math.min(left.count, right.count),
    };
  }

  return { share: curve.contentShare, count: curve.count };
};

export const predictV9BreakdownContentShare = (
  artifact: V9BreakdownSplitCurveArtifact,
  input: V9BreakdownSplitInput
) => {
  const caption = normalizeCaptionInput(input.caption);
  const divisionName = normalizeV9BreakdownDivisionName(input.divisionName);
  const percentThroughSeason = clampV9BreakdownPercentThroughSeason(input.percentThroughSeason);
  const config = artifact.config;
  const globalEstimate = interpolateCurve(artifact.global, percentThroughSeason) ?? {
    share: artifact.global.contentShare,
    count: artifact.global.count,
  };
  const divisionEstimate = interpolateCurve(
    artifact.byDivision[divisionName],
    percentThroughSeason
  );
  const captionEstimate = interpolateCurve(artifact.byCaption[caption], percentThroughSeason);
  const divisionCaptionEstimate = interpolateCurve(
    artifact.byDivisionCaption[v9BreakdownDivisionCaptionKey(divisionName, caption)],
    percentThroughSeason
  );

  const weighted = [
    { estimate: globalEstimate, weight: config.globalPrior },
    { estimate: divisionEstimate, weight: config.divisionPrior },
    { estimate: captionEstimate, weight: config.captionPrior },
    {
      estimate: divisionCaptionEstimate,
      weight:
        divisionCaptionEstimate == null
          ? 0
          : config.divisionCaptionPrior + Math.min(divisionCaptionEstimate.count, 250),
    },
  ].filter((entry): entry is { estimate: { share: number; count: number }; weight: number } => {
    return entry.estimate != null && entry.weight > 0 && Number.isFinite(entry.estimate.share);
  });

  const denominator = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  const share =
    denominator > 0
      ? weighted.reduce((sum, entry) => sum + entry.estimate.share * entry.weight, 0) / denominator
      : 0.5;

  return clamp(share, config.minShare, config.maxShare);
};

export const splitV9CaptionScoreWithContentShare = (
  captionScore: number,
  contentShare: number
): V9BreakdownPair => {
  const total = Math.max(0, Number(captionScore) || 0);
  const share = clamp(contentShare, 0, 1);
  const content = Number((total * share).toFixed(4));
  return {
    content,
    achievement: Number((total - content).toFixed(4)),
  };
};

export const splitV9CaptionScoreWithCurves = (
  artifact: V9BreakdownSplitCurveArtifact,
  input: V9BreakdownSplitInput & { captionScore: number }
) => {
  const contentShare = predictV9BreakdownContentShare(artifact, input);
  return {
    ...splitV9CaptionScoreWithContentShare(input.captionScore, contentShare),
    contentShare,
  };
};

const stabilityFactor = (stdShare: number | null | undefined) => {
  if (stdShare == null || !Number.isFinite(stdShare)) return 1;
  if (stdShare <= 0.004) return 1;
  if (stdShare <= 0.008) return 0.75;
  if (stdShare <= 0.012) return 0.5;
  return 0.25;
};

const recencyFactor = (daysSinceLatest: number | null | undefined, maxPriorAgeDays: number) => {
  if (daysSinceLatest == null || !Number.isFinite(daysSinceLatest)) return 1;
  if (daysSinceLatest < 0 || daysSinceLatest > maxPriorAgeDays) return 0;
  if (daysSinceLatest <= 10) return 1;
  if (daysSinceLatest <= 21) return 0.75;
  if (daysSinceLatest <= 35) return 0.5;
  return 0.25;
};

const validPriorShare = (share: number | null | undefined) =>
  typeof share === 'number' && Number.isFinite(share) && share >= 0.48 && share <= 0.54;

export const blendV9BreakdownContentShare = (
  curveShare: number,
  prior: V9BreakdownPriorShare | null | undefined,
  config: V9BreakdownPriorBlendConfig = DEFAULT_V9_BREAKDOWN_PRIOR_BLEND_CONFIG
) => {
  const safeCurveShare = clamp(curveShare, config.minShare, config.maxShare);
  if (!config.enabled || !prior || prior.count <= 0) {
    return {
      curveShare: safeCurveShare,
      priorShare: null,
      priorWeight: 0,
      finalShare: safeCurveShare,
      priorCount: 0,
      splitSource: 'curve_only' as const,
    };
  }

  const latestShare = validPriorShare(prior.latestShare) ? prior.latestShare! : null;
  const emaShare = validPriorShare(prior.emaShare) ? prior.emaShare! : null;
  const meanShare = validPriorShare(prior.meanShare) ? prior.meanShare : null;
  const priorShare =
    latestShare != null && emaShare != null
      ? emaShare * 0.65 + latestShare * 0.35
      : emaShare ?? latestShare ?? meanShare;

  if (priorShare == null || !validPriorShare(priorShare)) {
    return {
      curveShare: safeCurveShare,
      priorShare: null,
      priorWeight: 0,
      finalShare: safeCurveShare,
      priorCount: prior.count,
      splitSource: 'curve_only' as const,
    };
  }

  const countFactor = clamp(prior.count / Math.max(1, config.strongCount), 0, 1);
  const rawWeight =
    config.baseWeight *
    countFactor *
    recencyFactor(prior.daysSinceLatest, config.maxPriorAgeDays) *
    stabilityFactor(prior.stdShare);
  const priorWeight = clamp(rawWeight, 0, config.maxWeight);
  if (priorWeight <= 0) {
    return {
      curveShare: safeCurveShare,
      priorShare,
      priorWeight: 0,
      finalShare: safeCurveShare,
      priorCount: prior.count,
      splitSource: 'curve_only' as const,
    };
  }

  return {
    curveShare: safeCurveShare,
    priorShare,
    priorWeight,
    finalShare: clamp(safeCurveShare * (1 - priorWeight) + priorShare * priorWeight, config.minShare, config.maxShare),
    priorCount: prior.count,
    splitSource: 'curve_prior_blend' as const,
  };
};

export const splitV9CaptionScoreWithCurvesAndPrior = (
  artifact: V9BreakdownSplitCurveArtifact,
  input: V9BreakdownSplitInput & {
    captionScore: number;
    prior?: V9BreakdownPriorShare | null;
    priorBlendConfig?: Partial<V9BreakdownPriorBlendConfig>;
  }
): V9BreakdownSplitAudit => {
  const curveShare = predictV9BreakdownContentShare(artifact, input);
  const config = {
    ...DEFAULT_V9_BREAKDOWN_PRIOR_BLEND_CONFIG,
    minShare: artifact.config.minShare,
    maxShare: artifact.config.maxShare,
    ...input.priorBlendConfig,
  };
  const blend = blendV9BreakdownContentShare(curveShare, input.prior, config);
  return {
    ...splitV9CaptionScoreWithContentShare(input.captionScore, blend.finalShare),
    contentShare: blend.finalShare,
    curveShare: blend.curveShare,
    priorShare: blend.priorShare,
    priorWeight: blend.priorWeight,
    priorCount: blend.priorCount,
    splitSource: blend.splitSource,
  };
};

export const splitV9RecapWithCurves = (
  artifact: V9BreakdownSplitCurveArtifact,
  input: {
    divisionName?: string | null;
    percentThroughSeason?: number | null;
    captions: Partial<Record<V9BreakdownCaption, number>>;
  }
) =>
  Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption) => [
      caption,
      splitV9CaptionScoreWithCurves(artifact, {
        divisionName: input.divisionName,
        percentThroughSeason: input.percentThroughSeason,
        caption,
        captionScore: Number(input.captions[caption] ?? 0),
      }),
    ])
  ) as Record<V9BreakdownCaption, V9BreakdownPair & { contentShare: number }>;

export const splitV9RecapWithCurvesAndPrior = (
  artifact: V9BreakdownSplitCurveArtifact,
  input: {
    divisionName?: string | null;
    percentThroughSeason?: number | null;
    captions: Partial<Record<V9BreakdownCaption, number>>;
    priors?: Partial<Record<V9BreakdownCaption, V9BreakdownPriorShare>> | null;
    priorBlendConfig?: Partial<V9BreakdownPriorBlendConfig>;
  }
) =>
  Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption) => [
      caption,
      splitV9CaptionScoreWithCurvesAndPrior(artifact, {
        divisionName: input.divisionName,
        percentThroughSeason: input.percentThroughSeason,
        caption,
        captionScore: Number(input.captions[caption] ?? 0),
        prior: input.priors?.[caption] ?? null,
        priorBlendConfig: input.priorBlendConfig,
      }),
    ])
  ) as Record<V9BreakdownCaption, V9BreakdownSplitAudit>;
