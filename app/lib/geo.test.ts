import { describe, it, expect } from 'vite-plus/test';
import { haversineMiles, formatDistance, sortByDistance, type LatLng } from '@/lib/geo';

describe('haversineMiles', () => {
  it('is ~0 for the same point', () => {
    const p: LatLng = { lat: 40.7128, lng: -74.006 };
    expect(haversineMiles(p, p)).toBeCloseTo(0, 5);
  });

  it('matches a known city pair within tolerance (NYC ↔ LA ≈ 2445 mi)', () => {
    const nyc: LatLng = { lat: 40.7128, lng: -74.006 };
    const la: LatLng = { lat: 34.0522, lng: -118.2437 };
    const d = haversineMiles(nyc, la);
    expect(d).toBeGreaterThan(2400);
    expect(d).toBeLessThan(2500);
  });

  it('is symmetric', () => {
    const a: LatLng = { lat: 41.8781, lng: -87.6298 };
    const b: LatLng = { lat: 29.7604, lng: -95.3698 };
    expect(haversineMiles(a, b)).toBeCloseTo(haversineMiles(b, a), 6);
  });
});

describe('formatDistance', () => {
  it('renders sub-mile distances as "< 1 mi away"', () => {
    expect(formatDistance(0)).toBe('< 1 mi away');
    expect(formatDistance(0.4)).toBe('< 1 mi away');
  });

  it('rounds a few-mile value', () => {
    expect(formatDistance(3.4)).toBe('3 mi away');
    expect(formatDistance(3.6)).toBe('4 mi away');
  });

  it('renders a large value', () => {
    expect(formatDistance(2445.7)).toBe('2446 mi away');
  });
});

describe('sortByDistance', () => {
  interface Item {
    name: string;
    coords: LatLng | null;
  }
  const origin: LatLng = { lat: 40, lng: -74 };

  it('sorts nearest-first and attaches distanceMiles', () => {
    const near: Item = { name: 'near', coords: { lat: 40.1, lng: -74.1 } };
    const far: Item = { name: 'far', coords: { lat: 34, lng: -118 } };
    const result = sortByDistance([far, near], origin, (i) => i.coords);
    expect(result.map((r) => r.item.name)).toEqual(['near', 'far']);
    expect(result[0].distanceMiles).not.toBeNull();
    expect(result[0].distanceMiles!).toBeLessThan(result[1].distanceMiles!);
  });

  it('sorts coord-less items last with distanceMiles null, preserving their order', () => {
    const a: Item = { name: 'a', coords: { lat: 40.1, lng: -74.1 } };
    const noCoordsX: Item = { name: 'x', coords: null };
    const noCoordsY: Item = { name: 'y', coords: null };
    const result = sortByDistance([noCoordsX, a, noCoordsY], origin, (i) => i.coords);
    expect(result.map((r) => r.item.name)).toEqual(['a', 'x', 'y']);
    expect(result[1].distanceMiles).toBeNull();
    expect(result[2].distanceMiles).toBeNull();
  });
});
