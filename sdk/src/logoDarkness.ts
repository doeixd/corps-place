// Pure logo-darkness heuristic, shared by scripts/flagDarkLogos.ts (the ingest
// step) and its unit test. A "primarily dark/grey" logo (black/grey ink, e.g.
// Mandarins / Cavaliers / Troopers) reads poorly on a dark page, so the UI swaps
// in a luminance-inverted variant in dark mode; this decides which logos qualify.

import sharp from 'sharp';

// Thresholds, evaluated in 0–255 space; opacity gates which pixels count.
export const DARK_LOGO_THRESHOLDS = {
  alphaMin: 32, // ignore near-transparent pixels (anti-alias halo)
  darkLumMax: 110, // a pixel this dark (or darker) reads as "ink"
  lowSatMax: 0.22, // HSV saturation below this reads as grey/neutral
  coloredSatMin: 0.4, // saturated + not-dark => a real color in the mark
  minOpaqueFraction: 0.02, // need some actual artwork to judge
  // A logo is "dark" when most of its ink is dark+neutral and there's little color.
  darkFractionMin: 0.55,
  coloredFractionMax: 0.12,
} as const;

export type LogoStats = {
  /** Fraction of all sampled pixels that are opaque (have real artwork). */
  opaqueFraction: number;
  /** Of opaque pixels: fraction that are dark AND low-saturation (neutral ink). */
  darkFraction: number;
  /** Of opaque pixels: fraction that are saturated AND not dark (real color). */
  coloredFraction: number;
  /** Mean luminance of opaque pixels (0–255). */
  meanLum: number;
};

// HSV saturation in [0,1] from 0–255 RGB.
const hsvSat = (r: number, g: number, b: number): number => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
};

/**
 * Aggregate pixel stats for a logo's bytes. Returns null when the image has no
 * decodable opaque pixels (e.g. fully transparent or unreadable). A small raster
 * is plenty for aggregate stats and keeps this fast.
 */
export const analyzeLogoBytes = async (bytes: Uint8Array): Promise<LogoStats | null> => {
  const { alphaMin, darkLumMax, lowSatMax, coloredSatMin } = DARK_LOGO_THRESHOLDS;
  const { data, info } = await sharp(Buffer.from(bytes))
    .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels; // 4 after ensureAlpha
  const total = info.width * info.height;
  if (total === 0) return null;

  let opaque = 0;
  let dark = 0;
  let colored = 0;
  let lumSum = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = channels >= 4 ? data[i + 3] : 255;
    if (a < alphaMin) continue;
    opaque++;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumSum += lum;
    const sat = hsvSat(r, g, b);
    if (lum <= darkLumMax && sat <= lowSatMax) dark++;
    if (sat >= coloredSatMin && lum > darkLumMax) colored++;
  }

  if (opaque === 0) return null;
  return {
    opaqueFraction: opaque / total,
    darkFraction: dark / opaque,
    coloredFraction: colored / opaque,
    meanLum: lumSum / opaque,
  };
};

/** True when a logo's stats mark it as "primarily dark/grey" (see thresholds). */
export const isDarkLogo = (s: LogoStats): boolean =>
  s.opaqueFraction >= DARK_LOGO_THRESHOLDS.minOpaqueFraction &&
  s.darkFraction >= DARK_LOGO_THRESHOLDS.darkFractionMin &&
  s.coloredFraction <= DARK_LOGO_THRESHOLDS.coloredFractionMax;
