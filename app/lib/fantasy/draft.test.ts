import { describe, it, expect } from 'vite-plus/test';
import {
  userAt,
  pickWeight,
  isDraftComplete,
  legalityError,
  selectAutoPick,
  type LegalityInput,
} from './draft';
import { CAPTION_KEYS, type CaptionKey } from './captions';

const order = ['a', 'b', 'c'];

describe('userAt', () => {
  it('linear repeats the same order every round', () => {
    const seq = [0, 1, 2, 3, 4, 5].map((n) => userAt(order, n, 'linear'));
    expect(seq).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('snake reverses on odd rounds', () => {
    const seq = [0, 1, 2, 3, 4, 5, 6].map((n) => userAt(order, n, 'snake'));
    // round 0 forward, round 1 reverse, round 2 forward
    expect(seq).toEqual(['a', 'b', 'c', 'c', 'b', 'a', 'a']);
  });
});

describe('pickWeight', () => {
  const rw = { enabled: true, minWeight: 1.0, maxWeight: 2.0 };
  it('ramps linearly from min (round 1) to max (last round)', () => {
    expect(pickWeight(1, 14, rw)).toBeCloseTo(1.0, 5);
    expect(pickWeight(14, 14, rw)).toBeCloseTo(2.0, 5);
    expect(pickWeight(2, 14, rw)).toBeCloseTo(1 + 1 / 13, 5);
  });
  it('returns minWeight when disabled or single round', () => {
    expect(pickWeight(5, 14, { enabled: false, minWeight: 1, maxWeight: 2 })).toBe(1);
    expect(pickWeight(1, 1, rw)).toBe(1);
  });
});

describe('isDraftComplete', () => {
  it('completes after M*R picks', () => {
    expect(isDraftComplete(41, 3, 14)).toBe(false);
    expect(isDraftComplete(42, 3, 14)).toBe(true);
  });
});

describe('legalityError', () => {
  const caps = Object.fromEntries(CAPTION_KEYS.map((k) => [k, 2])) as Record<CaptionKey, number>;
  const base: LegalityInput = {
    caption: 'MB',
    captionCaps: caps,
    oneCaptionPerCorps: true,
    memberCaptionCount: 0,
    memberHasCorps: false,
    pairTakenInLeague: false,
    inPool: true,
  };

  it('allows a fresh legal pick', () => {
    expect(legalityError(base)).toBeNull();
  });
  it('rejects out-of-pool, taken pair, duplicate corps, and full caption in priority order', () => {
    expect(legalityError({ ...base, inPool: false })).toBe('not-in-pool');
    expect(legalityError({ ...base, pairTakenInLeague: true })).toBe('pair-taken');
    expect(legalityError({ ...base, memberHasCorps: true })).toBe('corps-on-roster');
    expect(legalityError({ ...base, memberCaptionCount: 2 })).toBe('caption-full');
  });
  it('permits a second caption of the same corps when oneCaptionPerCorps is false', () => {
    expect(legalityError({ ...base, oneCaptionPerCorps: false, memberHasCorps: true })).toBeNull();
  });
});

describe('selectAutoPick', () => {
  it('returns the first legal option from a ranked list', () => {
    const ranked = [
      { key: 'bd', ok: false },
      { key: 'sca', ok: true },
      { key: 'bk', ok: true },
    ];
    expect(selectAutoPick(ranked, (o) => o.ok)?.key).toBe('sca');
  });
  it('returns null when nothing is legal', () => {
    expect(selectAutoPick([{ ok: false }], (o) => o.ok)).toBeNull();
  });
});
