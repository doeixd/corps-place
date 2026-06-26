// Shared logo/favicon palette helpers. The on-page logo uses the detailed
// public/logo.svg artwork; browser favicons use the compact mark below.
//
// The favicon IS the site logo, recolored exactly like the on-page <Logo>: the
// logo's 6 palette fills are the *defaults* of the --logo-* CSS variables, and
// CSS re-derives those from --primary via relative oklch (app.css §logo palette).
// We replicate those same formulas here so a static SVG (which can't read the
// page's CSS variables) matches what the page renders.
import { hexToOklch, oklchToRgb, rgbToHex } from '@sdk/src/corpsColors.js';

// Bump when the favicon artwork or generation rules change. Both the default
// icon and generated corps icon include this token so browser/SW caches cannot
// pin old artwork across deploys.
export const APP_ICON_VERSION = '2';
export const DEFAULT_APP_ICON_HREF = `/favicon.svg?v=${APP_ICON_VERSION}`;

const FAVORITE_ICON_PATH =
  'M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z';

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

/** Deterministic, versioned <link rel="icon"> href for a favorite. */
export function buildAppIconHref(colorPrimary: string | null): string {
  if (!colorPrimary || !hexToOklch(colorPrimary)) return DEFAULT_APP_ICON_HREF;
  const params = new URLSearchParams({ v: APP_ICON_VERSION, p: colorPrimary });
  return `/app-icon.svg?${params.toString()}`;
}

/** Generate the small tab icon directly. The detailed 63 KB site logo is useful
 * on-page but unreliable and wasteful when browsers repeatedly rasterize it at
 * 16–32 px. Light/dark media colors preserve contrast in browser chrome. */
export function favoriteIconMarkup(primaryHex: string): string | null {
  const primary = hexToOklch(primaryHex);
  if (!primary) return null;
  const accent = (l: number) => lchToHex({ l, c: Math.min(primary.c, 0.18), h: primary.h });
  const light = accent(0.55);
  const dark = accent(0.72);
  return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 128 128"><path d="${FAVORITE_ICON_PATH}"/><style>path{fill:${light}}@media(prefers-color-scheme:dark){path{fill:${dark}}}</style></svg>`;
}
