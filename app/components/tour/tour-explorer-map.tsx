import { lazy, Suspense, useEffect, useState } from 'react';
import type { SeasonTourCorps, SeasonTourEventIndex } from '@sdk/src/readModel/builders/tour.js';
import { VIEW_W, VIEW_H } from './geometry';

/**
 * /tour explorer map — SSR-safe shell (same pattern as the corps-page TourMap):
 * aspect-ratio placeholder, then the lazy body (d3-geo/topojson shared via
 * ./geometry with the corps map).
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

function Placeholder() {
  return (
    <div
      className="w-full animate-pulse rounded-lg bg-muted/40"
      style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }}
      aria-hidden
    />
  );
}

export function TourExplorerMap(props: TourExplorerMapProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? (
    <Suspense fallback={<Placeholder />}>
      <TourExplorerBody {...props} />
    </Suspense>
  ) : (
    <Placeholder />
  );
}
