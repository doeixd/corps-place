import { createServerFileRoute } from '@tanstack/react-start/server';
import { getSeasonTour } from '@/lib/server-fns/hybrid';
import { parseCorpsList } from '@/lib/tour/codec';
import { renderStaticTourMapSvg, type StaticMapTheme } from '@/lib/tour/static-map.server';

/**
 * Static tour-map SVG (LQIP for the interactive maps): US landmass + state
 * borders + route polylines + venue dots in a 975×610 viewBox. The map pages
 * render this as an <img> in SSR HTML; the interactive SVG swaps in once its
 * geometry chunk loads. Same data source as the pages (getSeasonTour) — the
 * geometry never enters the TSR loader payload.
 *
 * Params: ?season=2026 (required), &corps=slug,slug (optional, capped at 12 by
 * parseCorpsList — not an amplification vector), &theme=light|dark.
 * Success is edge-cacheable; invalid params / failures are no-store.
 */
const NO_STORE = { 'cache-control': 'no-store' } as const;

export const ServerRoute = createServerFileRoute('/api/tour-map').methods({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const season = url.searchParams.get('season') ?? '';
    if (!/^20\d{2}$/.test(season))
      return new Response('invalid season', { status: 400, headers: NO_STORE });
    const themeParam = url.searchParams.get('theme');
    if (themeParam && themeParam !== 'light' && themeParam !== 'dark')
      return new Response('invalid theme', { status: 400, headers: NO_STORE });
    const theme: StaticMapTheme = themeParam === 'dark' ? 'dark' : 'light';
    const corpsFilter = parseCorpsList(url.searchParams.get('corps') ?? undefined);
    try {
      // Null / empty season data still renders a valid map-only SVG.
      const data = await getSeasonTour({ data: season });
      const svg = await renderStaticTourMapSvg(data, { theme, corpsFilter });
      return new Response(svg, {
        headers: {
          'content-type': 'image/svg+xml; charset=utf-8',
          'cache-control': 'public, max-age=300, s-maxage=3600',
        },
      });
    } catch (err) {
      console.error('[api/tour-map] render failed:', err);
      return new Response('render failed', { status: 500, headers: NO_STORE });
    }
  },
});
