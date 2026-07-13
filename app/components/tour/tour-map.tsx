import { lazy, Suspense, useEffect, useState } from 'react';
import type { TourStop } from '@/lib/tour';
import { StaticTourMapImg } from './static-map-img';

/**
 * Corps season tour map (TOUR_MAP_PLAN M2–M4) — SSR-safe shell. Reserves the
 * map's aspect-ratio box, then lazy-loads the body (d3-geo + topojson + the
 * US-states asset, ~40KB total) after mount, so none of it lands in the
 * initial/SSR bundle and there is no CLS.
 */
const TourMapBody = lazy(() => import('./tour-map-body'));

export interface TourMapProps {
  stops: TourStop[];
  colors: { primary: string | null; secondary: string | null };
  /** Season + corps slug drive the static /api/tour-map placeholder image. */
  season: string;
  corpsSlug: string;
}

export function TourMap({ stops, colors, season, corpsSlug }: TourMapProps) {
  // SSR-visible placeholder: the static map image, in the same aspect box the
  // interactive SVG will occupy (no CLS, real first paint before any JS).
  const placeholder = <StaticTourMapImg season={season} corps={[corpsSlug]} />;
  // Mounted gate (repo idiom — no ClientOnly wrapper exists): the server and
  // the hydration pass both render the placeholder; the real map appears in a
  // post-hydration commit.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (stops.length < 2) return null; // <2 pins isn't a tour — section hidden

  return (
    <div>
      {mounted ? (
        <Suspense fallback={placeholder}>
          <TourMapBody stops={stops} colors={colors} season={season} corpsSlug={corpsSlug} />
        </Suspense>
      ) : (
        placeholder
      )}
    </div>
  );
}
