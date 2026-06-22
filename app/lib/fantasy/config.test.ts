import { describe, it, expect } from 'vite-plus/test';
import { DEFAULT_CONFIG, parseLeagueConfig, resolveLeagueConfig, totalRounds } from './config';

describe('LeagueConfig', () => {
  it('accepts and round-trips the default config', () => {
    const parsed = parseLeagueConfig(DEFAULT_CONFIG);
    expect(parsed.draftType).toBe('snake');
    expect(parsed.weights).toEqual({ ge: 40, visual: 30, music: 30 });
  });

  it('totalRounds = sum of caption caps (default = 14)', () => {
    expect(totalRounds(DEFAULT_CONFIG)).toBe(14);
  });

  it('normalizes weights to sum to 100', () => {
    const parsed = resolveLeagueConfig({ weights: { ge: 60, visual: 20, music: 20 } });
    expect(parsed.weights.ge + parsed.weights.visual + parsed.weights.music).toBeCloseTo(100, 5);
    expect(parsed.weights.ge).toBeCloseTo(60, 5);
  });

  it('clamps pickSeconds into [15, 600]', () => {
    expect(resolveLeagueConfig({ pickSeconds: 5 }).pickSeconds).toBe(15);
    expect(resolveLeagueConfig({ pickSeconds: 9999 }).pickSeconds).toBe(600);
  });

  it('rejects an unknown field (strict object)', () => {
    expect(() => parseLeagueConfig({ ...DEFAULT_CONFIG, bogus: 1 })).toThrow();
  });

  it('rejects a bad enum value', () => {
    expect(() => parseLeagueConfig({ ...DEFAULT_CONFIG, draftType: 'auction' })).toThrow();
  });

  it('rejects maxWeight < minWeight', () => {
    expect(() =>
      resolveLeagueConfig({ reverseWeighting: { enabled: true, minWeight: 2, maxWeight: 1 } })
    ).toThrow();
  });

  it('rejects all-zero weights (cannot normalize)', () => {
    expect(() => resolveLeagueConfig({ weights: { ge: 0, visual: 0, music: 0 } })).toThrow();
  });
});
