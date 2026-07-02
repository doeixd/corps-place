import { describe, it, expect } from 'vite-plus/test';
import { computeRosterScore, type Pick, type SeasonBest } from './scoring';
import type { CaptionKey } from './captions';

const DEFAULT_WEIGHTS = { ge: 40, visual: 30, music: 30 };

// A pick with weight 1.0 in its caption's first slot.
const pick = (corpsKey: string, caption: CaptionKey, weight = 1.0): Pick => ({
  corpsKey,
  caption,
  captionSlotIndex: 1,
  weight,
});

// Build a SeasonBest from a {corpsKey|caption -> value} table.
const lookup =
  (table: Record<string, number>): SeasonBest =>
  (corpsKey, caption) =>
    table[`${corpsKey}|${caption}`] ?? 0;

describe('computeRosterScore', () => {
  it('matches Appendix D worked example (one pick per caption, default weights)', () => {
    const bests = {
      'c|GE1': 19.4,
      'c|GE2': 19.2,
      'c|VP': 19.0,
      'c|VA': 18.8,
      'c|CG': 18.5,
      'c|MB': 19.3,
      'c|MA': 19.1,
      'c|MP': 18.9,
    };
    const picks = (Object.keys(bests) as string[]).map((k) => {
      const caption = k.split('|')[1] as CaptionKey;
      return pick('c', caption);
    });

    const score = computeRosterScore(picks, lookup(bests), DEFAULT_WEIGHTS, 'recap');

    expect(score.ge).toBeCloseTo(38.6, 5);
    expect(score.visual).toBeCloseTo(28.15, 5);
    expect(score.music).toBeCloseTo(28.65, 5);
    expect(score.total).toBeCloseTo(95.4, 5);
  });

  it('reverse-weighting: weighted average stays on the 0–20 scale (Appendix D MP example)', () => {
    // Two MP picks: elite at weight 2.0, weaker at weight ~1.077.
    const w2 = 2.0;
    const wWeak = 1 + (2 - 1) / 13; // round 2 of 14 → ≈1.0769
    const bests = { 'bd|MP': 19.3, 'weak|MP': 17.0 };
    const picks = [pick('bd', 'MP', w2), pick('weak', 'MP', wWeak)];

    const score = computeRosterScore(picks, lookup(bests), DEFAULT_WEIGHTS, 'recap');

    // cap.MP = (19.3·2.0 + 17.0·1.077)/(2.0+1.077) ≈ 18.495 (plan rounds to 18.49)
    expect(score.perCaption.MP).toBeCloseTo(18.495, 2);
    expect(score.perCaption.MP).toBeLessThanOrEqual(20);
  });

  it('saving the elite for the high-weight round scores strictly higher', () => {
    const wWeak = 1 + (2 - 1) / 13;
    const bests = { 'bd|MP': 19.3, 'weak|MP': 17.0 };
    const saved = computeRosterScore(
      [pick('bd', 'MP', 2.0), pick('weak', 'MP', wWeak)],
      lookup(bests),
      DEFAULT_WEIGHTS
    );
    const flipped = computeRosterScore(
      [pick('bd', 'MP', wWeak), pick('weak', 'MP', 2.0)],
      lookup(bests),
      DEFAULT_WEIGHTS
    );
    expect(saved.perCaption.MP).toBeGreaterThan(flipped.perCaption.MP);
    expect(flipped.perCaption.MP).toBeCloseTo(17.8, 1);
  });

  it('a corps with no season-best contributes 0', () => {
    const score = computeRosterScore([pick('ghost', 'GE1')], lookup({}), DEFAULT_WEIGHTS);
    expect(score.total).toBe(0);
    expect(score.perCaption.GE1).toBe(0);
  });

  it('an unscored pick is excluded from the caption average, not counted as 0', () => {
    // One scored corps (15.6) + one that hasn't competed yet. Early season the
    // caption should read 15.6 — NOT (15.6·w + 0·w)/(w+w) ≈ 7.8.
    const bests = { 'scored|VP': 15.6 };
    const score = computeRosterScore(
      [pick('scored', 'VP', 1.0), pick('ghost', 'VP', 2.0)],
      lookup(bests),
      DEFAULT_WEIGHTS,
      'recap'
    );
    expect(score.perCaption.VP).toBeCloseTo(15.6, 5);
  });

  it("'sum' mode does not normalize (unbounded points pile)", () => {
    const bests = { 'a|MB': 19, 'b|MB': 18 };
    const score = computeRosterScore(
      [pick('a', 'MB', 2.0), pick('b', 'MB', 2.0)],
      lookup(bests),
      DEFAULT_WEIGHTS,
      'sum'
    );
    // Σ(v·w) = 19·2 + 18·2 = 74, far above the 20 cap.
    expect(score.perCaption.MB).toBeCloseTo(74, 5);
  });

  it('a perfect 20-everywhere roster totals 100 at default weights', () => {
    const captions: CaptionKey[] = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'];
    const bests = Object.fromEntries(captions.map((c) => [`p|${c}`, 20]));
    const picks = captions.map((c) => pick('p', c));
    const score = computeRosterScore(picks, lookup(bests), DEFAULT_WEIGHTS);
    expect(score.total).toBeCloseTo(100, 5);
  });
});
