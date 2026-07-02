/**
 * LeagueConfig — the per-league settings blob stored in
 * `fantasy_leagues.config_json` (Fantasy DCI plan §6, Appendix E.0).
 *
 * Validated with valibot on every read and write (never trust the client; JSON
 * config is re-parsed server-side). `parseLeagueConfig` both validates the shape
 * and normalizes it per Appendix E.0: clamp ranges and normalize the three
 * category `weights` to sum to 100 (so the max possible recap total stays 100).
 */
import * as v from 'valibot';
import { CAPTION_KEYS, type CaptionKey } from './captions';

// NOTE(plan-gap): Appendix D's TS sketch names ScoringMode as
// 'weighted_sum'|'dci_average'|'single_pick', but §5.3, §6 and the E.0 default
// object use 'recap'|'sum'. We follow E.0 / the prose (the authoritative,
// internally-consistent source): 'recap' (weighted-avg → DCI math, total ≤ 100)
// and 'sum' (unbounded points pile). — TODO(plan-gap): reconcile the appendix sketch.

const CapNumber = v.pipe(v.number(), v.integer(), v.minValue(0));
const CaptionCapsSchema = v.object(
  Object.fromEntries(CAPTION_KEYS.map((k) => [k, CapNumber])) as Record<
    CaptionKey,
    typeof CapNumber
  >
);

export const LeagueConfigSchema = v.strictObject({
  // Draft
  draftType: v.picklist(['snake', 'linear']),
  pickSeconds: v.pipe(v.number(), v.integer()),
  quizOrderDir: v.picklist(['high_first', 'low_first', 'random', 'manual']),
  captionCaps: CaptionCapsSchema,
  oneCaptionPerCorps: v.boolean(),
  allowedDivisions: v.array(v.picklist(['world', 'open'])),

  // Reverse weighting — "save the best for last" (§6).
  reverseWeighting: v.strictObject({
    enabled: v.boolean(),
    minWeight: v.pipe(v.number(), v.minValue(0)),
    maxWeight: v.pipe(v.number(), v.minValue(0)),
  }),

  // Scoring
  scoringMode: v.picklist(['recap', 'sum']),
  weights: v.strictObject({
    ge: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
    visual: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
    music: v.pipe(v.number(), v.minValue(0), v.maxValue(100)),
  }),
  weightsLockedAt: v.picklist(['never', 'finals_week']),
  // Only 'zero' is implemented (computeRosterScore hard-codes missing captions to
  // 0). 'prorate' is undefined per FANTASY_DCI_PLAN §19.3 D1, so it is rejected at
  // validation rather than silently behaving as 'zero' — reinstate the option here
  // once buildStandings is policy-aware.
  missingCaptionPolicy: v.picklist(['zero']),

  // Draft timing / ranking (v1 fixed values, but validated)
  draftPhase: v.picklist(['preseason']),
  rankingSource: v.picklist(['prior_season']),

  // Notifications
  notify: v.strictObject({ email: v.boolean(), push: v.boolean() }),

  // Quiz
  quiz: v.strictObject({
    enabled: v.boolean(),
    questionCount: v.pipe(v.number(), v.integer()),
    perQuestionSeconds: v.pipe(v.number(), v.integer()),
  }),
});

export type LeagueConfig = v.InferOutput<typeof LeagueConfigSchema>;

/** The exact object written when a league is created (Appendix E.0). */
export const DEFAULT_CONFIG: LeagueConfig = {
  draftType: 'snake',
  pickSeconds: 60,
  quizOrderDir: 'high_first',
  captionCaps: { GE1: 2, GE2: 2, VP: 2, VA: 2, CG: 2, MB: 2, MA: 2, MP: 2 }, // sum = 16 rounds (GE capped the same as every other caption)
  oneCaptionPerCorps: true,
  allowedDivisions: ['world', 'open'],
  reverseWeighting: { enabled: true, minWeight: 1.0, maxWeight: 2.0 },
  scoringMode: 'recap',
  weights: { ge: 40, visual: 30, music: 30 },
  weightsLockedAt: 'finals_week',
  missingCaptionPolicy: 'zero',
  draftPhase: 'preseason',
  rankingSource: 'prior_season',
  notify: { email: true, push: false },
  quiz: { enabled: true, questionCount: 10, perQuestionSeconds: 30 },
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Normalize a *validated* config in place of returning a fresh one: clamp ranges
 * and normalize the three category weights to sum to 100 (Appendix E.0). Throws
 * if the weights are all zero (can't normalize). Caller passes a value that has
 * already passed `LeagueConfigSchema`.
 */
const normalizeConfig = (c: LeagueConfig): LeagueConfig => {
  const weightSum = c.weights.ge + c.weights.visual + c.weights.music;
  if (weightSum <= 0) throw new Error('LeagueConfig weights must sum to a positive number');
  const k = 100 / weightSum;

  if (c.reverseWeighting.maxWeight < c.reverseWeighting.minWeight) {
    throw new Error('LeagueConfig reverseWeighting.maxWeight must be >= minWeight');
  }

  const captionCaps = Object.fromEntries(
    CAPTION_KEYS.map((key) => [key, clamp(Math.round(c.captionCaps[key]), 0, 10)])
  ) as Record<CaptionKey, number>;

  return {
    ...c,
    pickSeconds: clamp(Math.round(c.pickSeconds), 15, 600),
    captionCaps,
    weights: {
      ge: c.weights.ge * k,
      visual: c.weights.visual * k,
      music: c.weights.music * k,
    },
    quiz: {
      ...c.quiz,
      questionCount: clamp(Math.round(c.quiz.questionCount), 1, 50),
      perQuestionSeconds: clamp(Math.round(c.quiz.perQuestionSeconds), 5, 600),
    },
  };
};

/** Validate (strict) then normalize an unknown config blob. Throws on invalid input. */
export const parseLeagueConfig = (input: unknown): LeagueConfig =>
  normalizeConfig(v.parse(LeagueConfigSchema, input));

/**
 * Merge a partial override onto DEFAULT_CONFIG (shallow — nested objects like
 * `weights` must be passed whole), then validate + normalize.
 */
export const resolveLeagueConfig = (override?: Partial<LeagueConfig>): LeagueConfig =>
  parseLeagueConfig({ ...DEFAULT_CONFIG, ...override });

/** Total draft rounds = sum of caption caps. */
export const totalRounds = (config: LeagueConfig): number =>
  CAPTION_KEYS.reduce((sum, k) => sum + config.captionCaps[k], 0);

/**
 * Draft-shape fields that freeze once the draft starts (§6) — everything except
 * scoring `weights` (editable until finals week) and `notify` prefs.
 */
const DRAFT_SHAPE_KEYS: (keyof LeagueConfig)[] = [
  'draftType',
  'pickSeconds',
  'quizOrderDir',
  'captionCaps',
  'oneCaptionPerCorps',
  'allowedDivisions',
  'reverseWeighting',
  'scoringMode',
  'weightsLockedAt',
  'missingCaptionPolicy',
  'draftPhase',
  'rankingSource',
  'quiz',
];

/** True if any draft-shape field differs between two configs (ignores weights + notify). */
export const draftShapeChanged = (a: LeagueConfig, b: LeagueConfig): boolean =>
  DRAFT_SHAPE_KEYS.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
