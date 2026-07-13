import { createServerFileRoute } from '@tanstack/react-start/server';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { renderOgPng, OG_HEADERS } from '@/lib/og/render';
import { getSeasonTour } from '@/lib/server-fns/hybrid';

/**
 * /tour social card: an ACTUAL map render — the season's tour routes in corps
 * colors over the US states — composed as a data-URI background layer inside
 * the satori frame (satori's own SVG support is too limited to draw the map;
 * sharp rasterizes our hand-built SVG string instead, then satori overlays the
 * title/stats). Cached a day; errors are no-store (no CF rule on /api/og, so
 * there is no poisoning class, but don't cache failures anyway).
 */

const VIEW_W = 975;
const VIEW_H = 610;

let mapPngCache = new Map<string, { at: number; uri: string }>();
const DAY = 86_400_000;

async function seasonMapDataUri(season: string): Promise<{ uri: string; corps: number; shows: number } | null> {
  const cached = mapPngCache.get(season);
  const data = await getSeasonTour({ data: season });
  if (!data || data.corps.length === 0) return null;
  const competitive = data.corps.filter((c) => !/soundsport/i.test(c.division ?? ''));
  if (cached && Date.now() - cached.at < DAY)
    return { uri: cached.uri, corps: competitive.length, shows: data.mappableEvents };

  const [{ geoPath, geoAlbersUsa }, topoClient, sharp] = await Promise.all([
    import('d3-geo'),
    import('topojson-client'),
    import('sharp'),
  ]);
  // In the container the built assets live under .output/public (verified:
  // /app/public does not exist at runtime); in dev they're in public/.
  const topoPath = [
    path.resolve(process.cwd(), '.output', 'public', 'geo', 'us-states-albers-10m.json'),
    path.resolve(process.cwd(), 'public', 'geo', 'us-states-albers-10m.json'),
  ].find(existsSync);
  if (!topoPath) throw new Error('us-states topology asset not found');
  const topo = JSON.parse(readFileSync(topoPath, 'utf8'));
  const gp = geoPath();
  const states =
    gp(topoClient.mesh(topo, topo.objects.states, (a: unknown, b: unknown) => a !== b)) ?? '';
  const nation = gp(topoClient.feature(topo, topo.objects.nation)) ?? '';
  const project = geoAlbersUsa().scale(1300).translate([VIEW_W / 2, VIEW_H / 2]);

  const routes = competitive
    .map((c) => {
      const pts = c.stops
        .map(([, , lat, lng]) => project([lng, lat]))
        .filter((p): p is [number, number] => !!p);
      if (pts.length < 2) return '';
      const d = 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
      const color = c.colorPrimary ?? '#fd5007';
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-opacity="0.55" stroke-linejoin="round" stroke-linecap="round"/>`;
    })
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}">` +
    `<rect width="${VIEW_W}" height="${VIEW_H}" fill="#0b0d12"/>` +
    `<path d="${nation}" fill="#151923"/>` +
    `<path d="${states}" fill="none" stroke="#2a3040" stroke-width="0.8"/>` +
    routes +
    `</svg>`;

  const png = await sharp.default(Buffer.from(svg)).resize(1200, 630, { fit: 'cover' }).png()
    .toBuffer();
  const uri = `data:image/png;base64,${png.toString('base64')}`;
  mapPngCache.set(season, { at: Date.now(), uri });
  return { uri, corps: competitive.length, shows: data.mappableEvents };
}

export const ServerRoute = createServerFileRoute('/api/og/tour/$season').methods({
  GET: async ({ params }) => {
    const season = /^\d{4}$/.test(params.season) ? params.season : null;
    try {
      const map = season ? await seasonMapDataUri(season) : null;
      if (!map) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
      return new Response(
        await renderOgPng({
          type: 'div',
          props: {
            style: {
              width: 1200,
              height: 630,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              backgroundImage: `url(${map.uri})`,
              backgroundSize: '1200px 630px',
              fontFamily: 'Instrument Sans',
            },
            children: {
              type: 'div',
              props: {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '28px 44px 34px',
                  background: 'linear-gradient(transparent, rgba(6,8,12,0.92))',
                },
                children: [
                  {
                    type: 'div',
                    props: {
                      style: { fontSize: 52, fontWeight: 700, color: '#ffffff' },
                      children: `${season} DCI Tour Map`,
                    },
                  },
                  {
                    type: 'div',
                    props: {
                      style: { fontSize: 27, color: 'rgba(255,255,255,0.82)', marginTop: 6 },
                      children: `Every corps' summer route — ${map.corps} corps, ${map.shows} shows · DrumCorps.app`,
                    },
                  },
                ],
              },
            },
          },
        } as never),
        { headers: OG_HEADERS }
      );
    } catch (err) {
      console.error('[og/tour] render failed:', err);
      return new Response('render failed', {
        status: 500,
        headers: { 'cache-control': 'no-store' },
      });
    }
  },
});
