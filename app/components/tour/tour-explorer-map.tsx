import { lazy, Suspense, useEffect, useState } from 'react';
import type { SeasonTourCorps, SeasonTourEventIndex } from '@sdk/src/readModel/builders/tour.js';
import { StaticTourMapImg } from './static-map-img';

/**
 * /tour explorer map — SSR-safe shell (same pattern as the corps-page TourMap):
 * the static /api/tour-map image paints in the SSR HTML (season + initial ?c
 * focus only — it's a placeholder, live filters don't re-render it), then the
 * lazy body (d3-geo/topojson shared via ./geometry with the corps map) swaps
 * in inside the same aspect box.
 */
const TourExplorerBody = lazy(() => import('./tour-explorer-body'));

export interface TourExplorerMapProps {
  /** Visible corps (already division-filtered / focused by the page). */
  corps: SeasonTourCorps[];
  events: SeasonTourEventIndex;
  season: string;
  /** Focused mode: exactly the selected corps, full pins. Null = all-corps mode. */
  focused: string[] | null;
  asof?: string;
  hoverSlug: string | null;
  onHoverSlug: (slug: string | null) => void;
  onToggleFocus: (slug: string) => void;
}

export function TourExplorerMap(props: TourExplorerMapProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const placeholder = <StaticTourMapImg season={props.season} corps={props.focused} />;
  return mounted ? (
    <Suspense fallback={placeholder}>
      <TourExplorerBody {...props} />
    </Suspense>
  ) : (
    placeholder
  );
}
