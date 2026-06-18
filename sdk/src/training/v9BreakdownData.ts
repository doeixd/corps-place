export const V9_BREAKDOWN_CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;

// In ml_sequence_rows_v9_subcaption, the original V9 static vector stores these
// prior subcaption features just before the appended caption-fingerprint block:
// last Content, last Achievement, EMA Content, EMA Achievement, each by caption.
export const V9_BREAKDOWN_STATIC_SUBCAPTION_START = 137;
export const V9_BREAKDOWN_STATIC_LAST_CONTENT_START = V9_BREAKDOWN_STATIC_SUBCAPTION_START;
export const V9_BREAKDOWN_STATIC_LAST_ACHIEVEMENT_START =
  V9_BREAKDOWN_STATIC_LAST_CONTENT_START + V9_BREAKDOWN_CAPTIONS.length;
export const V9_BREAKDOWN_STATIC_EMA_CONTENT_START =
  V9_BREAKDOWN_STATIC_LAST_ACHIEVEMENT_START + V9_BREAKDOWN_CAPTIONS.length;
export const V9_BREAKDOWN_STATIC_EMA_ACHIEVEMENT_START =
  V9_BREAKDOWN_STATIC_EMA_CONTENT_START + V9_BREAKDOWN_CAPTIONS.length;
export const V9_BREAKDOWN_STATIC_SUBCAPTION_END =
  V9_BREAKDOWN_STATIC_EMA_ACHIEVEMENT_START + V9_BREAKDOWN_CAPTIONS.length - 1;

export type V9BreakdownCaption = (typeof V9_BREAKDOWN_CAPTIONS)[number];
export type V9BreakdownSubcaptionKind = 'content' | 'achievement';

export type V9BreakdownPriorFeatures = {
  lastContent: number[];
  lastAchievement: number[];
  emaContent: number[];
  emaAchievement: number[];
  lastShare: Array<number | null>;
  emaShare: Array<number | null>;
  hasExpectedStaticShape: boolean;
};

export type V9BreakdownPair = {
  content: number;
  achievement: number;
};

export type V9BreakdownMask = {
  content: boolean;
  achievement: boolean;
  pair: boolean;
};

export type V9BreakdownSubcaptionRow = {
  competition_slug: string;
  corps_key: string;
  caption_name: string;
  judge_id: string | null;
  subcaption_name: string;
  score: number;
};

const CAPTION_ALIASES: Record<string, V9BreakdownCaption> = {
  'general effect 1': 'GE1',
  'ge 1': 'GE1',
  ge1: 'GE1',
  'general effect 2': 'GE2',
  'ge 2': 'GE2',
  ge2: 'GE2',
  'visual proficiency': 'VP',
  'visual - proficiency': 'VP',
  'visual prof': 'VP',
  vp: 'VP',
  'visual analysis': 'VA',
  'visual - analysis': 'VA',
  va: 'VA',
  'color guard': 'CG',
  guard: 'CG',
  cg: 'CG',
  'music - brass': 'MB',
  'music brass': 'MB',
  brass: 'MB',
  mb: 'MB',
  'music - analysis': 'MA',
  'music analysis': 'MA',
  ma: 'MA',
  'music - percussion': 'MP',
  'music percussion': 'MP',
  percussion: 'MP',
  mp: 'MP',
};

const normalizeLabel = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');

export const normalizeV9BreakdownCaption = (captionName: string) =>
  CAPTION_ALIASES[normalizeLabel(captionName)];

export const normalizeV9BreakdownSubcaptionKind = (
  subcaptionName: string
): V9BreakdownSubcaptionKind | 'other' => {
  const name = normalizeLabel(subcaptionName);
  if (!name || name.includes('penalty')) return 'other';

  if (
    [
      'content',
      'repertoire',
      'composition',
      'rep',
      'comp',
      'design',
      'dsgn',
      'repertoire composition',
      'design development',
      'composition development',
      'repertoire effect',
      'design effect',
    ].some((variant) => name === variant || name.includes(variant))
  ) {
    return 'content';
  }

  if (
    [
      'achievement',
      'performance',
      'execution',
      'perf',
      'excellence',
      'exc',
      'clarity excellence',
      'clarity & excellence',
      'performer excellence',
      'performance showmanship',
      'performance/showmanship',
      'performer effect',
      'accuracy',
      'technique',
      'intonation',
      'tone',
      'expression',
    ].some((variant) => name === variant || name.includes(variant))
  ) {
    return 'achievement';
  }

  return 'other';
};

const zeroPair = (): V9BreakdownPair => ({ content: 0, achievement: 0 });

const contentShare = (content: number, achievement: number) => {
  if (!Number.isFinite(content) || !Number.isFinite(achievement)) return null;
  const total = content + achievement;
  return total > 0 ? content / total : null;
};

export const extractV9BreakdownPriorFeatures = (
  staticFeatures: readonly number[]
): V9BreakdownPriorFeatures => {
  const hasExpectedStaticShape = staticFeatures.length > V9_BREAKDOWN_STATIC_SUBCAPTION_END;
  const readBlock = (start: number) =>
    V9_BREAKDOWN_CAPTIONS.map((_, idx) => Number(staticFeatures[start + idx] ?? 0));
  const lastContent = readBlock(V9_BREAKDOWN_STATIC_LAST_CONTENT_START);
  const lastAchievement = readBlock(V9_BREAKDOWN_STATIC_LAST_ACHIEVEMENT_START);
  const emaContent = readBlock(V9_BREAKDOWN_STATIC_EMA_CONTENT_START);
  const emaAchievement = readBlock(V9_BREAKDOWN_STATIC_EMA_ACHIEVEMENT_START);

  return {
    lastContent,
    lastAchievement,
    emaContent,
    emaAchievement,
    lastShare: V9_BREAKDOWN_CAPTIONS.map((_, idx) =>
      contentShare(lastContent[idx] ?? 0, lastAchievement[idx] ?? 0)
    ),
    emaShare: V9_BREAKDOWN_CAPTIONS.map((_, idx) =>
      contentShare(emaContent[idx] ?? 0, emaAchievement[idx] ?? 0)
    ),
    hasExpectedStaticShape,
  };
};

export const emptyV9BreakdownTarget = () =>
  Object.fromEntries(V9_BREAKDOWN_CAPTIONS.map((caption) => [caption, zeroPair()])) as Record<
    V9BreakdownCaption,
    V9BreakdownPair
  >;

export const emptyV9BreakdownMask = () =>
  Object.fromEntries(
    V9_BREAKDOWN_CAPTIONS.map((caption) => [
      caption,
      { content: false, achievement: false, pair: false },
    ])
  ) as Record<V9BreakdownCaption, V9BreakdownMask>;

export type AggregatedBreakdown = {
  target: Record<V9BreakdownCaption, V9BreakdownPair>;
  mask: Record<V9BreakdownCaption, V9BreakdownMask>;
  unknownLabels: Map<string, number>;
  scaleRepairs: number;
  scaleExclusions: number;
};

export const aggregateV9BreakdownSubcaptions = (
  rows: readonly V9BreakdownSubcaptionRow[],
  captionTotals: Record<string, number>,
  options: {
    repairTolerance?: number;
    excludeTolerance?: number;
  } = {}
): AggregatedBreakdown => {
  const repairTolerance = options.repairTolerance ?? 0.2;
  const excludeTolerance = options.excludeTolerance ?? 0.2;
  const byCaptionJudge = new Map<
    V9BreakdownCaption,
    Map<string, { content: number; achievement: number; hasContent: boolean; hasAchievement: boolean }>
  >();
  const unknownLabels = new Map<string, number>();

  for (const row of rows) {
    const caption = normalizeV9BreakdownCaption(row.caption_name);
    if (!caption) {
      const key = `caption:${row.caption_name}`;
      unknownLabels.set(key, (unknownLabels.get(key) ?? 0) + 1);
      continue;
    }

    const kind = normalizeV9BreakdownSubcaptionKind(row.subcaption_name);
    if (kind === 'other') {
      const key = `${caption}:${row.subcaption_name}`;
      unknownLabels.set(key, (unknownLabels.get(key) ?? 0) + 1);
      continue;
    }

    const score = Number(row.score);
    if (!Number.isFinite(score) || score <= 0) continue;

    const judgeId = row.judge_id || 'unknown';
    let byJudge = byCaptionJudge.get(caption);
    if (!byJudge) {
      byJudge = new Map();
      byCaptionJudge.set(caption, byJudge);
    }

    const current = byJudge.get(judgeId) ?? {
      content: 0,
      achievement: 0,
      hasContent: false,
      hasAchievement: false,
    };
    current[kind] += score;
    if (kind === 'content') current.hasContent = true;
    if (kind === 'achievement') current.hasAchievement = true;
    byJudge.set(judgeId, current);
  }

  const target = emptyV9BreakdownTarget();
  const mask = emptyV9BreakdownMask();
  let scaleRepairs = 0;
  let scaleExclusions = 0;

  for (const caption of V9_BREAKDOWN_CAPTIONS) {
    const byJudge = byCaptionJudge.get(caption);
    if (!byJudge) continue;

    const validJudgePairs = [...byJudge.values()].filter(
      (entry) => entry.hasContent && entry.hasAchievement
    );
    if (!validJudgePairs.length) continue;

    let content =
      validJudgePairs.reduce((sum, entry) => sum + entry.content, 0) / validJudgePairs.length;
    let achievement =
      validJudgePairs.reduce((sum, entry) => sum + entry.achievement, 0) / validJudgePairs.length;

    const captionTotal = Number(captionTotals[caption] ?? 0);
    const pairTotal = content + achievement;
    if (!Number.isFinite(captionTotal) || captionTotal <= 0 || !Number.isFinite(pairTotal) || pairTotal <= 0)
      continue;

    const diff = Math.abs(pairTotal - captionTotal);
    if (diff > excludeTolerance) {
      scaleExclusions += 1;
      continue;
    }
    if (diff > 0.05 && diff <= repairTolerance) {
      const scale = captionTotal / pairTotal;
      content *= scale;
      achievement *= scale;
      scaleRepairs += 1;
    }

    target[caption] = {
      content: Number(content.toFixed(4)),
      achievement: Number(achievement.toFixed(4)),
    };
    mask[caption] = { content: true, achievement: true, pair: true };
  }

  return { target, mask, unknownLabels, scaleRepairs, scaleExclusions };
};

export const totalFromV9BreakdownCaptions = (captions: Record<string, number>) =>
  (captions.GE1 ?? 0) +
  (captions.GE2 ?? 0) +
  ((captions.VP ?? 0) + (captions.VA ?? 0) + (captions.CG ?? 0)) / 2 +
  ((captions.MB ?? 0) + (captions.MA ?? 0) + (captions.MP ?? 0)) / 2;

export const categoriesFromV9BreakdownCaptions = (captions: Record<string, number>) => ({
  ge: (captions.GE1 ?? 0) + (captions.GE2 ?? 0),
  visual: ((captions.VP ?? 0) + (captions.VA ?? 0) + (captions.CG ?? 0)) / 2,
  music: ((captions.MB ?? 0) + (captions.MA ?? 0) + (captions.MP ?? 0)) / 2,
});
