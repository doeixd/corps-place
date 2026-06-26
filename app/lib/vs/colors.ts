// VS chart colors — deterministic, theme-aware color per series (plan M1 "color"
// + M2). Corps/prediction series take their brand hue via `corpsPalette` (the
// same util the single-corps chart uses); baselines and brand-less series take a
// categorical ramp. Same-corps multi-season lines are disambiguated so two BD
// seasons don't render the same color. Pure + client-safe (color math only).
import { corpsPalette, type ColorMode } from '@sdk/src/corpsColors.js';
import type { VsResolvedSeries } from './types';

// Categorical ramp for baselines / brand-less series — distinct hues that read
// on both light and dark surfaces (mid lightness, moderate chroma). Cycled.
const BASELINE_RAMP_LIGHT = [
  'oklch(0.55 0.10 250)',
  'oklch(0.55 0.10 150)',
  'oklch(0.58 0.11 30)',
  'oklch(0.55 0.10 320)',
  'oklch(0.58 0.10 90)',
  'oklch(0.55 0.09 200)',
];
const BASELINE_RAMP_DARK = [
  'oklch(0.74 0.11 250)',
  'oklch(0.74 0.11 150)',
  'oklch(0.76 0.12 30)',
  'oklch(0.74 0.11 320)',
  'oklch(0.78 0.11 90)',
  'oklch(0.74 0.10 200)',
];

/** Nudge a corps's chart hue so the 2nd+ same-corps series is distinguishable
 *  from the 1st. We rotate to the secondary hue (`chart2`) for the 2nd, then
 *  fall back to ramp colors for any further duplicates (rare). */
function corpsColor(
  brand: { primary: string | null; secondary: string | null } | null | undefined,
  mode: ColorMode,
  occurrence: number
): string | null {
  const colors = brand?.primary ? { primary: brand.primary, secondary: brand.secondary } : null;
  if (!colors) return null;
  const palette = corpsPalette(colors, mode);
  return occurrence === 0 ? palette.chart : palette.chart2;
}

/**
 * Assign a final color to each resolved series, theme-aware. Mutates a copy:
 * returns new series objects with `color` filled. Deterministic for a given
 * (series list, mode).
 */
export function assignVsColors(series: VsResolvedSeries[], mode: ColorMode): VsResolvedSeries[] {
  const ramp = mode === 'dark' ? BASELINE_RAMP_DARK : BASELINE_RAMP_LIGHT;
  const corpsSeen = new Map<string, number>(); // corps identity → occurrence count
  const used = new Set<string>(); // every color already handed out (global)
  let rampIdx = 0;

  // The next ramp color not already used (cycles; repeats only past the cap).
  const nextRamp = (): string => {
    for (let i = 0; i < ramp.length; i++) {
      const c = ramp[rampIdx++ % ramp.length];
      if (!used.has(c)) return c;
    }
    return ramp[rampIdx++ % ramp.length];
  };

  return series.map((s) => {
    let color: string | null = null;
    if ((s.kind === 'corps' || s.kind === 'prediction') && s.brand?.primary) {
      // Key on the corps identity (the slug in the id, e.g. `corps~blue-devils~
      // 2025`), NOT the brand hex — distinct corps that share a primary color
      // must still get distinct lines.
      const key = s.id.split('~')[1] ?? s.id;
      const occ = corpsSeen.get(key) ?? 0;
      corpsSeen.set(key, occ + 1);
      // Use the brand hue only if it's still free; on ANY collision (3rd+ same
      // corps, or two corps sharing a hex) fall through to a free ramp color.
      const cand = occ < 2 ? corpsColor(s.brand, mode, occ) : null;
      if (cand && !used.has(cand)) color = cand;
    }
    if (!color) color = nextRamp();
    used.add(color);
    return { ...s, color };
  });
}
