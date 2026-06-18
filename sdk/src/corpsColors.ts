// Per-corps color derivation (CORPS_COLORS_PLAN). A corps stores just two brand
// colors (primary + optional secondary, hex); every accent the UI needs — light
// and dark mode — is *derived deterministically* from those here. This module is
// pure (no I/O) and shared by the app, the color editor's live preview, and the
// emitter, so the colors a corps shows can never drift between them.
//
// All derivation happens in OKLCH (the same space app.css uses), so lightness and
// chroma are perceptually uniform: "make it legible on a dark surface" is just a
// lightness target, not a per-color hand-tune.

export type Hex = string; // '#rrggbb'

export type ColorMode = 'light' | 'dark';

// The two stored brand colors for a corps. `secondary` is optional; when absent,
// derivation rotates the primary's hue for two-tone needs (e.g. chart compares).
export type CorpsBrandColors = {
  primary: Hex;
  secondary: Hex | null;
};

// The full derived palette for one mode. CSS-ready oklch() strings.
export type CorpsPalette = {
  accent: string; // primary, legible on the mode's surface
  accentFg: string; // text/icon ON the accent fill (contrast-picked)
  accentMuted: string; // tinted pill/chip background (favorites, badges)
  accentBorder: string; // subtle border/ring in the accent hue
  chart: string; // primary series color tuned for the chart surface
  chart2: string; // secondary series color (compares / two-tone)
};

// ── OKLCH ⇄ sRGB ─────────────────────────────────────────────────────────────
// Standard sRGB → linear → OKLab → OKLCH and back (Björn Ottosson's transform).

type Oklch = { l: number; c: number; h: number }; // l,c ∈ [0,1]; h in degrees

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const srgbToLinear = (v: number): number => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (v: number): number => {
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(clamp01(s) * 255);
};

export const hexToRgb = (hex: Hex): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

export const rgbToHex = (r: number, g: number, b: number): Hex =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

export const rgbToOklch = (r: number, g: number, b: number): Oklch => {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const C = Math.hypot(a, bb);
  let H = (Math.atan2(bb, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { l: L, c: C, h: H };
};

export const oklchToRgb = ({ l: L, c: C, h: H }: Oklch): [number, number, number] => {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
};

export const hexToOklch = (hex: Hex): Oklch | null => {
  const rgb = hexToRgb(hex);
  return rgb ? rgbToOklch(...rgb) : null;
};

// A compact CSS oklch() literal (3-dp l/c, 1-dp hue) matching app.css style.
const oklchCss = ({ l, c, h }: Oklch, alpha?: number): string => {
  const base = `${+l.toFixed(3)} ${+c.toFixed(3)} ${+h.toFixed(1)}`;
  return alpha == null ? `oklch(${base})` : `oklch(${base} / ${alpha})`;
};

// ── Derivation ───────────────────────────────────────────────────────────────

// Site fallback (mirrors --color-primary in app.css) for corps with no usable
// brand color (monochrome logos, missing data).
export const FALLBACK_PRIMARY: Hex = '#3b6fd4';

// Lightness/chroma targets per mode. An accent must read against the page surface
// (light surface → darker accent; dark surface → lighter accent), and the muted
// tint sits near the surface lightness with low chroma.
const TARGETS = {
  light: { accentL: 0.55, mutedL: 0.93, mutedC: 0.05, chartL: 0.55, borderL: 0.8, borderC: 0.06 },
  dark: { accentL: 0.72, mutedL: 0.28, mutedC: 0.05, chartL: 0.72, borderL: 0.4, borderC: 0.07 },
} as const;

// Pin lightness; keep the source hue. Chroma is clamped so a hyper-saturated
// brand hex can't blow past what oklch can render at the target lightness.
const atLightness = (src: Oklch, l: number, maxC = 0.18): Oklch => ({
  l,
  c: Math.min(src.c, maxC),
  h: src.h,
});

// Contrast-pick black vs white foreground for an accent fill.
const fgFor = (accent: Oklch): string => {
  const [r, g, b] = oklchToRgb(accent);
  // Relative luminance (sRGB) → WCAG-ish threshold.
  const lum = 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
  return lum > 0.4 ? 'oklch(0.15 0.02 260)' : 'oklch(0.98 0.005 260)';
};

const resolveBrand = (colors: Partial<CorpsBrandColors> | null | undefined): { primary: Oklch; secondary: Oklch } => {
  const primary = (colors?.primary && hexToOklch(colors.primary)) || hexToOklch(FALLBACK_PRIMARY)!;
  // Secondary: use the stored one, else rotate the primary hue 40° for a related
  // but distinguishable two-tone partner.
  const secondary =
    (colors?.secondary && hexToOklch(colors.secondary)) || { ...primary, h: (primary.h + 40) % 360 };
  return { primary, secondary };
};

/**
 * Derive the full CSS-ready palette for a corps in one mode. Pure + deterministic
 * — the same inputs always yield the same palette in the app, the editor preview,
 * and the emitter. Pass `null`/partial colors to get the site-fallback palette.
 */
export const corpsPalette = (
  colors: Partial<CorpsBrandColors> | null | undefined,
  mode: ColorMode
): CorpsPalette => {
  const t = TARGETS[mode];
  const { primary, secondary } = resolveBrand(colors);
  const accent = atLightness(primary, t.accentL);
  return {
    accent: oklchCss(accent),
    accentFg: fgFor(accent),
    accentMuted: oklchCss(atLightness(primary, t.mutedL, t.mutedC)),
    accentBorder: oklchCss(atLightness(primary, t.borderL, t.borderC)),
    chart: oklchCss(atLightness(primary, t.chartL)),
    chart2: oklchCss(atLightness(secondary, t.chartL)),
  };
};

/**
 * The CSS custom-property bag the app sets on a corps page / scope root. Pairs
 * with components reading `var(--corps-accent)` etc. Emits both modes is the
 * caller's job (set light on `:root`-scope, dark under `.dark`); this returns one
 * mode's vars.
 */
export const corpsPaletteVars = (
  colors: Partial<CorpsBrandColors> | null | undefined,
  mode: ColorMode
): Record<string, string> => {
  const p = corpsPalette(colors, mode);
  return {
    '--corps-accent': p.accent,
    '--corps-accent-fg': p.accentFg,
    '--corps-accent-muted': p.accentMuted,
    '--corps-accent-border': p.accentBorder,
    '--corps-chart': p.chart,
    '--corps-chart-2': p.chart2,
  };
};

// Validate + normalize a hex for storage (editor + extractor). Returns lowercase
// '#rrggbb' or null when unparseable.
export const normalizeHex = (value: string): Hex | null => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h}`;
};
