// Recolors the site logo (public/logo.svg) to a corps's brand palette. Shared by
// the server icon route (app-icon.svg) which bakes the colors into the SVG, and
// by the client store which builds the matching <link rel="icon"> href.
//
// The favicon IS the site logo, recolored exactly like the on-page <Logo>: the
// logo's 6 palette fills are the *defaults* of the --logo-* CSS variables, and
// CSS re-derives those from --primary via relative oklch (app.css §logo palette).
// We replicate those same formulas here so a static SVG (which can't read the
// page's CSS variables) matches what the page renders.
import { hexToOklch, oklchToRgb, rgbToHex } from '@sdk/src/corpsColors.js';

// The default fills baked into public/logo.svg, paired with the relative-oklch
// derivation each one gets from --primary. Keep in sync with app.css §logo.
type Lch = { l: number; c: number; h: number };
const LOGO_FILLS: { hex: string; derive: (p: Lch) => Lch }[] = [
  { hex: '#feb403', derive: (p) => ({ l: 0.72, c: p.c, h: p.h + 12 }) }, // --logo-accent
  { hex: '#fd5007', derive: (p) => ({ l: p.l + 0.02, c: p.c * 1.15, h: p.h }) }, // --logo-accent-vivid
  { hex: '#fe7f02', derive: (p) => ({ l: p.l + 0.08, c: p.c * 0.75, h: p.h }) }, // --logo-accent-muted
  { hex: '#0c2e1d', derive: (p) => ({ l: 0.17, c: p.c * 0.3, h: p.h + 50 }) }, // --logo-dark
  { hex: '#e22517', derive: (p) => ({ l: p.l - 0.1, c: p.c * 1.1, h: p.h }) }, // --logo-detail
  { hex: '#fbfbf2', derive: (p) => ({ l: 0.96, c: p.c * 0.08, h: p.h }) }, // --logo-light
];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const lchToHex = ({ l, c, h }: Lch): string => {
  const [r, g, b] = oklchToRgb({ l: clamp01(l), c: Math.max(0, c), h: ((h % 360) + 360) % 360 });
  return rgbToHex(r, g, b);
};

/** Parse an `oklch(l c h)` string (the form --logo-dark is stored in). */
const parseOklchString = (s: string): Lch | null => {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.-]+)/i.exec(s);
  return m ? { l: +m[1], c: +m[2], h: +m[3] } : null;
};

/** Recolor the site logo markup to a corps's palette. `logoDark` (oklch string)
 *  overrides the derived structural-dark fill so the favicon matches the page.
 *  Returns null if the primary hex can't be parsed (caller falls back to default). */
export function recolorLogoMarkup(
  markup: string,
  primaryHex: string,
  logoDark: string | null
): string | null {
  const primary = hexToOklch(primaryHex);
  if (!primary) return null;
  const darkOverride = logoDark ? parseOklchString(logoDark) : null;
  let out = markup;
  for (const { hex, derive } of LOGO_FILLS) {
    const color =
      hex === '#0c2e1d' && darkOverride ? lchToHex(darkOverride) : lchToHex(derive(primary));
    out = out.replaceAll(hex, color);
  }
  return out;
}

/** The <link rel="icon"> href for a favorite. Points at the server icon route so
 *  the SVG is generated (and cached) server-side from the query colors — the URL
 *  is deterministic, so SSR and client hydration agree and never clash. Returns
 *  the default logo when the corps has no brand color. */
export function buildAppIconHref(colorPrimary: string | null, logoDark: string | null): string {
  if (!colorPrimary) return '/logo.svg';
  const params = new URLSearchParams({ p: colorPrimary });
  if (logoDark) params.set('d', logoDark);
  return `/app-icon.svg?${params.toString()}`;
}
