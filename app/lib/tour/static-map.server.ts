// Server-only static tour-map SVG rendering (shared by /api/og/tour/$season
// and /api/tour-map). Loads the pre-projected us-atlas topology from disk once
// (module cache), builds the state/nation path strings + the lon/lat projector,
// and can compose a full standalone SVG of a season's routes.
//
// Projection contract (mirrors app/components/tour/geometry.ts): the topology
// is pre-projected to a 975×610 frame; raw lon/lat points project with
// geoAlbersUsa().scale(1300).translate([487.5, 305]).
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { SeasonTourData } from '@sdk/src/readModel/builders/tour.js';

export const VIEW_W = 975;
export const VIEW_H = 610;

export interface StaticMapGeometry {
  statesPath: string;
  nationPath: string;
  project: (lng: number, lat: number) => [number, number] | null;
}

let geometryPromise: Promise<StaticMapGeometry> | null = null;

/** Topology + d3 loaded once per process. In the container the built assets
 *  live under .output/public (verified: /app/public does not exist at
 *  runtime); in dev they're in public/. */
export const loadServerGeometry = (): Promise<StaticMapGeometry> => {
  geometryPromise ??= (async () => {
    const [{ geoPath, geoAlbersUsa }, topoClient] = await Promise.all([
      import('d3-geo'),
      import('topojson-client'),
    ]);
    const topoPath = [
      path.resolve(process.cwd(), '.output', 'public', 'geo', 'us-states-albers-10m.json'),
      path.resolve(process.cwd(), 'public', 'geo', 'us-states-albers-10m.json'),
    ].find(existsSync);
    if (!topoPath) throw new Error('us-states topology asset not found');
    const topo = JSON.parse(readFileSync(topoPath, 'utf8'));
    const gp = geoPath(); // identity — topology is pre-projected
    const statesPath =
      gp(topoClient.mesh(topo, topo.objects.states, (a: unknown, b: unknown) => a !== b)) ?? '';
    const nationPath = gp(topoClient.feature(topo, topo.objects.nation)) ?? '';
    const projection = geoAlbersUsa()
      .scale(1300)
      .translate([VIEW_W / 2, VIEW_H / 2]);
    return {
      statesPath,
      nationPath,
      project: (lng: number, lat: number) => projection([lng, lat]) ?? null,
    };
  })();
  return geometryPromise;
};

export type StaticMapTheme = 'light' | 'dark';

// Literal hex palettes matching the interactive map's semantic classes
// (fill-muted / dark:fill-muted/30, stroke-muted-foreground/25 / dark:stroke-
// border). This is an IMAGE — Tailwind classes don't apply, so hex only.
// No background rect: the SVG stays transparent and blends with the page.
const PALETTES: Record<
  StaticMapTheme,
  { land: string; border: string; borderOpacity: number; dot: string; fallbackRoute: string }
> = {
  light: {
    land: '#e4e4e7',
    border: '#71717a',
    borderOpacity: 0.25,
    dot: 'rgba(24,24,27,0.45)',
    fallbackRoute: '#fd5007',
  },
  dark: {
    land: '#1a1f2b',
    border: '#2a3040',
    borderOpacity: 1,
    dot: 'rgba(235,238,245,0.45)',
    fallbackRoute: '#fd5007',
  },
};

const esc = (s: string) => s.replace(/[<>&"]/g, '');

/**
 * Standalone SVG string of a season tour map: landmass + state borders +
 * route polylines + venue dots, 975×610 viewBox. `corpsFilter` (slugs) limits
 * routes to a focused subset (drawn heavier, per-stop dots); otherwise every
 * non-SoundSport corps is drawn with shared venue dots. A season with no
 * geocoded stops still yields a valid map-only SVG.
 */
export async function renderStaticTourMapSvg(
  data: SeasonTourData | null,
  opts: { theme?: StaticMapTheme; corpsFilter?: readonly string[] } = {}
): Promise<string> {
  const geo = await loadServerGeometry();
  const pal = PALETTES[opts.theme ?? 'light'];

  const focused = opts.corpsFilter?.length
    ? new Set(opts.corpsFilter.map((s) => s.toLowerCase()))
    : null;
  const visible = (data?.corps ?? []).filter((c) =>
    focused ? focused.has(c.slug.toLowerCase()) : !/soundsport/i.test(c.division ?? '')
  );

  const routeParts: string[] = [];
  const dotParts: string[] = [];
  const sharedVenues = new Map<string, { x: number; y: number; n: number }>();

  for (const c of visible) {
    const pts: [number, number][] = [];
    for (const [, , lat, lng] of c.stops) {
      const p = geo.project(lng, lat);
      if (p) pts.push(p);
    }
    const color =
      c.colorPrimary && /^#[0-9a-fA-F]{3,8}$/.test(c.colorPrimary)
        ? c.colorPrimary
        : pal.fallbackRoute;
    if (pts.length >= 2) {
      const d = 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
      routeParts.push(
        `<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="${focused ? 2 : 1.25}" stroke-opacity="${focused ? 0.9 : 0.35}" stroke-linejoin="round" stroke-linecap="round"/>`
      );
    }
    for (const p of pts) {
      if (focused) {
        dotParts.push(
          `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${esc(color)}"/>`
        );
      } else {
        const key = `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
        const v = sharedVenues.get(key) ?? { x: p[0], y: p[1], n: 0 };
        v.n += 1;
        sharedVenues.set(key, v);
      }
    }
  }
  if (!focused) {
    for (const v of sharedVenues.values()) {
      const r = Math.min(2 + Math.sqrt(v.n) * 1.4, 8);
      dotParts.push(
        `<circle cx="${v.x.toFixed(1)}" cy="${v.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${pal.dot}"/>`
      );
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}">` +
    `<path d="${geo.nationPath}" fill="${pal.land}"/>` +
    `<path d="${geo.statesPath}" fill="none" stroke="${pal.border}" stroke-opacity="${pal.borderOpacity}" stroke-width="0.75"/>` +
    routeParts.join('') +
    dotParts.join('') +
    `</svg>`
  );
}
