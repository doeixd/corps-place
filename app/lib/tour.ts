// Tour-map data mapping (TOUR_MAP_PLAN): EventDirectoryRow[] + results →
// TourStop[]. Pure + client-safe; unit-tested. Stops without coordinates are
// dropped here (they stay in the appearances list, just not on the map).

import type { EventDirectoryRow } from '@/lib/event-directory';
import { preferredEventSlug } from '@/lib/dci-links';

export interface TourStop {
  slug: string;
  linkSlug: string; // preferredEventSlug — what event links use
  season: string;
  name: string;
  date: string; // ISO date (start_date)
  city: string | null;
  state: string | null;
  venue: string | null;
  lat: number;
  lng: number;
  place: number | null;
  total: number | null;
}

export interface AppearanceResultLike {
  place: number | null;
  total: number | null;
}

/** Map appearances to map-eligible stops: coordinates present, sorted by date
 *  (then time-ish, then name for a stable order). */
export function toTourStops(
  events: readonly EventDirectoryRow[],
  season: string,
  resultByEventId?: (e: EventDirectoryRow) => AppearanceResultLike | undefined
): TourStop[] {
  return events
    .filter(
      (e) =>
        (e.season ?? season) === season &&
        typeof e.venue_latitude === 'number' &&
        typeof e.venue_longitude === 'number'
    )
    .map((e) => {
      const result = resultByEventId?.(e);
      return {
        slug: e.slug,
        linkSlug: preferredEventSlug(e, e.slug),
        season: e.season ?? season,
        name: e.name,
        date: e.start_date.slice(0, 10),
        city: e.geocode_city ?? e.location_city,
        state: e.geocode_state ?? e.location_state,
        venue: e.venue_name,
        lat: e.venue_latitude as number,
        lng: e.venue_longitude as number,
        place: result?.place ?? null,
        total: result?.total ?? null,
      };
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    );
}
