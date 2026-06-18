// Pure logo color extraction, shared by scripts/extractCorpsColors.ts (the ingest
// step) and its unit test (sibling of logoDarkness.ts). Picks two brand colors
// from a corps logo's pixels: the dominant saturated color (primary) and the most
// distinct other hue (secondary), so a corps's accent + chart colors come from
// its own mark.
//
// Heuristic, not exact: downscale, drop near-transparent / near-white / near-black
// pixels (background + neutral ink carry no brand hue), bucket the rest by hue,
// and average the winning buckets. Returns null when the logo has no usable color
// (monochrome marks — those fall back to the site accent at the call site).

import sharp from 'sharp';
import { rgbToHex, type Hex } from './corpsColors.js';

export const LOGO_COLOR_THRESHOLDS = {
  alphaMin: 128, // ignore near-transparent pixels (anti-alias halo + background)
  satMin: 0.25, // below this is grey/neutral ink — no brand hue
  lumMin: 28, // drop near-black (0–255)
  lumMax: 235, // drop near-white
  minColoredFraction: 0.01, // need some colored artwork to extract from
  hueBuckets: 12, // 30° hue buckets
  secondaryMinHueGap: 40, // secondary must differ from primary by this many degrees
} as const;

export type LogoColors = { primary: Hex; secondary: Hex | null };

const rgbToHsv = (r: number, g: number, b: number): { h: number; s: number; v: number } => {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx / 255 };
};

type Bucket = { count: number; r: number; g: number; b: number };

/**
 * Extract up to two brand colors from logo bytes. Returns null when no decodable
 * colored pixels exist (fully transparent, or a purely black/grey/white mark).
 */
export const extractLogoColors = async (bytes: Uint8Array): Promise<LogoColors | null> => {
  const { alphaMin, satMin, lumMin, lumMax, minColoredFraction, hueBuckets, secondaryMinHueGap } =
    LOGO_COLOR_THRESHOLDS;
  const { data, info } = await sharp(Buffer.from(bytes))
    .resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const total = info.width * info.height;
  if (total === 0) return null;

  // Weight each colored pixel into its hue bucket, summing RGB so the winning
  // bucket can be averaged back to a representative color.
  const buckets: Bucket[] = Array.from({ length: hueBuckets }, () => ({ count: 0, r: 0, g: 0, b: 0 }));
  const span = 360 / hueBuckets;
  let colored = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = channels >= 4 ? data[i + 3] : 255;
    if (a < alphaMin) continue;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < lumMin || lum > lumMax) continue;
    const { h, s } = rgbToHsv(r, g, b);
    if (s < satMin) continue;
    colored++;
    // Weight by saturation so vivid pixels dominate over washed-out ones.
    const w = s;
    const idx = Math.min(hueBuckets - 1, Math.floor(h / span));
    const bk = buckets[idx];
    bk.count += w;
    bk.r += r * w;
    bk.g += g * w;
    bk.b += b * w;
  }

  if (colored / total < minColoredFraction) return null;

  const ranked = buckets
    .map((bk, idx) => ({ idx, bk }))
    .filter((x) => x.bk.count > 0)
    .sort((a, b) => b.bk.count - a.bk.count);
  if (ranked.length === 0) return null;

  const avg = (bk: Bucket): Hex => rgbToHex(bk.r / bk.count, bk.g / bk.count, bk.b / bk.count);
  const primaryIdx = ranked[0].idx;
  const primary = avg(ranked[0].bk);

  // Secondary: the highest-count bucket whose hue is far enough from primary's.
  const secondaryEntry = ranked
    .slice(1)
    .find((x) => Math.min(Math.abs(x.idx - primaryIdx), hueBuckets - Math.abs(x.idx - primaryIdx)) * span >= secondaryMinHueGap);

  return { primary, secondary: secondaryEntry ? avg(secondaryEntry.bk) : null };
};
