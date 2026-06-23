import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { rateLimit, __resetRateLimits } from './rate-limit';

describe('rateLimit', () => {
  beforeEach(() => __resetRateLimits());

  it('allows up to the limit, then rejects within the window', () => {
    const t = 1_000;
    expect(rateLimit('k', 3, 1000, t)).toBe(true);
    expect(rateLimit('k', 3, 1000, t)).toBe(true);
    expect(rateLimit('k', 3, 1000, t)).toBe(true);
    expect(rateLimit('k', 3, 1000, t)).toBe(false); // 4th in the same window
  });

  it('resets after the window elapses', () => {
    expect(rateLimit('k', 1, 1000, 1_000)).toBe(true);
    expect(rateLimit('k', 1, 1000, 1_500)).toBe(false); // still in window
    expect(rateLimit('k', 1, 1000, 2_000)).toBe(true); // window rolled over
  });

  it('tracks keys independently', () => {
    expect(rateLimit('a', 1, 1000, 0)).toBe(true);
    expect(rateLimit('a', 1, 1000, 0)).toBe(false);
    expect(rateLimit('b', 1, 1000, 0)).toBe(true); // different key unaffected
  });
});
