import { describe, it, expect } from 'vite-plus/test';
import { diffWords } from './text-diff';

describe('diffWords', () => {
  it('marks an inserted word as added and preserves the rest', () => {
    const segs = diffWords('the cat sat', 'the big cat sat');
    expect(segs.map((s) => s.value).join('')).toBe('the big cat sat');
    expect(segs.some((s) => s.added && s.value.includes('big'))).toBe(true);
    expect(segs.some((s) => s.removed)).toBe(false);
  });

  it('marks a removed word', () => {
    const segs = diffWords('the big cat', 'the cat');
    expect(segs.some((s) => s.removed && s.value.includes('big'))).toBe(true);
  });

  it('handles a full replacement', () => {
    const segs = diffWords('hello', 'world');
    expect(segs.some((s) => s.removed && s.value.includes('hello'))).toBe(true);
    expect(segs.some((s) => s.added && s.value.includes('world'))).toBe(true);
  });

  it('returns a single unchanged segment for identical input', () => {
    const segs = diffWords('same text', 'same text');
    expect(segs).toHaveLength(1);
    expect(segs[0].added).toBeUndefined();
    expect(segs[0].removed).toBeUndefined();
  });
});
