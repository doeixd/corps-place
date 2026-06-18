// Pure geo helpers for the home "shows near you" carousel. No React, no effects —
// just math, so they're trivially testable and safe to run in render.

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_MI = 3958.7613;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two points, in miles (haversine). */
export const haversineMiles = (a: LatLng, b: LatLng): number => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Human label for a distance, e.g. "12 mi away" / "< 1 mi away". */
export const formatDistance = (miles: number): string =>
  miles < 1 ? '< 1 mi away' : `${Math.round(miles)} mi away`;

/**
 * Attach distance-from-origin to each item that has coordinates and sort
 * nearest-first; items missing coordinates keep their original relative order
 * and sort last (distance = null). Pure — returns a new array.
 */
export const sortByDistance = <T>(
  items: readonly T[],
  origin: LatLng,
  coordsOf: (item: T) => LatLng | null
): Array<{ item: T; distanceMiles: number | null }> =>
  items
    .map((item, index) => {
      const coords = coordsOf(item);
      return {
        item,
        index,
        distanceMiles: coords ? haversineMiles(origin, coords) : null,
      };
    })
    .sort((a, b) => {
      if (a.distanceMiles === null && b.distanceMiles === null) return a.index - b.index;
      if (a.distanceMiles === null) return 1;
      if (b.distanceMiles === null) return -1;
      return a.distanceMiles - b.distanceMiles;
    })
    .map(({ item, distanceMiles }) => ({ item, distanceMiles }));
