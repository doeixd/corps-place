// Server-only Open Graph image rendering: Satori (JSX → SVG) + sharp (SVG → PNG).
// Used by the /api/og/* routes. Fonts are bundled (fonts.generated.ts) so there's
// no runtime fetch and no dependency on system fonts in the container.
import satori from 'satori';
import sharp from 'sharp';
import type { ReactNode } from 'react';
import { interRegular, interBold } from './fonts.generated';

const fonts = [
  { name: 'Inter', data: interRegular, weight: 400 as const, style: 'normal' as const },
  { name: 'Inter', data: interBold, weight: 700 as const, style: 'normal' as const },
];

/**
 * Normalize typographic punctuation to ASCII for image rendering. The bundled
 * Inter subset doesn't cover every General Punctuation glyph, and Satori renders
 * missing glyphs as visible artifacts — user-supplied strings (titles, names)
 * especially can carry smart quotes from mobile keyboards.
 */
export const ogText = (s: string): string =>
  s
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ');

/** Render a Satori JSX tree (1200×630) to a PNG. Returns a Uint8Array (valid
 *  BodyInit for Response; Buffer is rejected by the DOM lib's BodyInit type). */
export async function renderOgPng(node: ReactNode): Promise<Uint8Array<ArrayBuffer>> {
  const svg = await satori(node, { width: 1200, height: 630, fonts });
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  // Copy into a fresh ArrayBuffer-backed view: the DOM BodyInit type rejects
  // Uint8Array<ArrayBufferLike> (Node Buffer's backing) under TS 5.7+.
  const out = new Uint8Array(png.byteLength);
  out.set(png);
  return out;
}

/** Standard headers: PNG + long, immutable-ish CDN cache (content is stable once scored). */
export const OG_HEADERS = {
  'Content-Type': 'image/png',
  'Cache-Control': 'public, max-age=86400, s-maxage=604800',
} as const;
