/**
 * Fantasy scoring engine (Fantasy DCI plan §5, Appendix D).
 *
 * PURE functions only — no DB, no I/O — so they're golden-file unit-testable
 * against `docs/dci_domain.md` arithmetic. The season-best lookup is injected as
 * a plain function so the score DB stays out of here.
 *
 * Core idea (§5.2): a pick's value is the corps' SEASON-BEST score in that one
 * caption so far. Per caption we take a WEIGHTED AVERAGE (divide by the sum of
 * weights, not the count) so each caption stays ≤ 20 and the DCI total stays
 * ≤ 100, while reverse-weighting still biases the average toward high-weight
 * (late-round) picks.
 */
import { CAPTION_KEYS, type CaptionKey } from './captions';

export type ScoringMode = 'recap' | 'sum';

export type Pick = {
  corpsKey: string;
  caption: CaptionKey;
  captionSlotIndex: number;
  weight: number;
};

export type Weights = { ge: number; visual: number; music: number };

/** Corps' season-best in one caption (0 if it hasn't scored that caption yet). */
export type SeasonBest = (corpsKey: string, caption: CaptionKey) => number;

export type RosterScore = {
  total: number;
  ge: number;
  visual: number;
  music: number;
  /** Per-caption aggregated value (the weighted average, 0–20 in 'recap' mode). */
  perCaption: Record<CaptionKey, number>;
};

const emptyPerCaption = (): Record<CaptionKey, number> =>
  Object.fromEntries(CAPTION_KEYS.map((k) => [k, 0])) as Record<CaptionKey, number>;

/**
 * Compute one member's roster score (Appendix D steps 1–6).
 *
 * @param picks   the member's drafted picks (each with its reverse-weight)
 * @param best    season-best lookup (§5.2)
 * @param weights category weights; assumed pre-normalized to sum 100 (the config
 *                layer guarantees this). Default magnitudes 40/30/30.
 * @param mode    'recap' (weighted average, total ≤ 100) or 'sum' (unbounded)
 */
export function computeRosterScore(
  picks: readonly Pick[],
  best: SeasonBest,
  weights: Weights,
  mode: ScoringMode = 'recap'
): RosterScore {
  // Step 1–3: per-caption aggregate.
  const perCaption = emptyPerCaption();
  for (const key of CAPTION_KEYS) {
    const group = picks.filter((p) => p.caption === key);
    if (group.length === 0) {
      perCaption[key] = 0; // missingCaptionPolicy 'zero'
      continue;
    }
    let weightedSum = 0; // Σ(vᵢ·wᵢ) over SCORED picks
    let weightTotal = 0; // Σ(wᵢ) over SCORED picks
    for (const p of group) {
      const v = best(p.corpsKey, p.caption);
      // "No season-best yet" (the corps hasn't competed) is MISSING DATA, not a
      // zero performance — averaging it in halves the caption early season and
      // makes totals look nothing like real DCI scores. Exclude unscored picks
      // from the average; they start counting the day the corps first scores.
      if (v <= 0) continue;
      weightedSum += v * p.weight;
      weightTotal += p.weight;
    }
    if (mode === 'sum') {
      perCaption[key] = weightedSum; // unbounded points pile, no normalization
    } else {
      // 0 only while NONE of the caption's picks have scored yet.
      perCaption[key] = weightTotal === 0 ? 0 : weightedSum / weightTotal;
    }
  }

  // Step 4: category subtotals (real DCI formula).
  const geRaw = perCaption.GE1 + perCaption.GE2; // each ≤ 20 → ≤ 40
  const visualRaw = (perCaption.VP + perCaption.VA + perCaption.CG) / 2; // ≤ 30
  const musicRaw = (perCaption.MB + perCaption.MA + perCaption.MP) / 2; // ≤ 30

  // Step 5: apply configurable weights (default 40/30/30 leaves scores unchanged).
  const ge = geRaw * (weights.ge / 40);
  const visual = visualRaw * (weights.visual / 30);
  const music = musicRaw * (weights.music / 30);

  // Step 6.
  return { total: ge + visual + music, ge, visual, music, perCaption };
}
