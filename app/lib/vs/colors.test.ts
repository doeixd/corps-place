import { describe, it, expect } from 'vite-plus/test';
import { corpsPalette } from '@sdk/src/corpsColors.js';
import { assignVsColors } from './colors';
import type { VsResolvedSeries } from './types';

const mk = (over: Partial<VsResolvedSeries>): VsResolvedSeries => ({
  id: 'x',
  label: 'x',
  kind: 'corps',
  color: '',
  lines: [],
  ...over,
});

describe('assignVsColors', () => {
  it('gives a corps its brand chart hue', () => {
    const brand = { primary: '#fd5007', secondary: null };
    const [out] = assignVsColors([mk({ id: 'corps~blue-devils~2025', brand })], 'light');
    expect(out.color).toBe(corpsPalette(brand, 'light').chart);
  });

  it('disambiguates two seasons of the same corps (chart vs chart2)', () => {
    const brand = { primary: '#fd5007', secondary: '#feb403' };
    const [a, b] = assignVsColors(
      [mk({ id: 'corps~bd~2024', brand }), mk({ id: 'corps~bd~2025', brand })],
      'light'
    );
    const p = corpsPalette(brand, 'light');
    expect(a.color).toBe(p.chart);
    expect(b.color).toBe(p.chart2);
    expect(a.color).not.toBe(b.color);
  });

  it('keeps two DIFFERENT corps that share a brand hex distinct', () => {
    const brand = { primary: '#fd5007', secondary: null };
    const [a, b] = assignVsColors(
      [mk({ id: 'corps~blue-devils~2025', brand }), mk({ id: 'corps~bluecoats~2025', brand })],
      'light'
    );
    // First gets the brand chart hue; the second collides → falls to a free ramp.
    expect(a.color).not.toBe(b.color);
  });

  it('colors a baseline from the ramp (not a brand hue)', () => {
    const [out] = assignVsColors([mk({ id: 'baseline~13', kind: 'baseline', brand: null })], 'light');
    expect(out.color).toMatch(/^oklch\(/);
  });

  it('assigns every series a distinct color in a mixed set', () => {
    const set = assignVsColors(
      [
        mk({ id: 'corps~blue-devils~2025', brand: { primary: '#fd5007', secondary: '#feb403' } }),
        mk({ id: 'corps~bluecoats~2025', brand: { primary: '#0a3161', secondary: null } }),
        mk({ id: 'baseline~1', kind: 'baseline', brand: null }),
        mk({ id: 'baseline~13', kind: 'baseline', brand: null }),
      ],
      'dark'
    );
    const colors = set.map((s) => s.color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});
