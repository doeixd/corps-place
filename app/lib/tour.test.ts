import { describe, it, expect } from 'vite-plus/test';
import { toTourStops } from './tour';
import type { EventDirectoryRow } from '@/lib/event-directory';

const row = (over: Partial<EventDirectoryRow>): EventDirectoryRow => ({
  slug: 'x',
  name: 'X',
  event_name: null,
  start_date: '2026-07-01T00:00:00.000Z',
  start_time: null,
  web_start_time: null,
  edt_start_time: null,
  timezone: null,
  location_city: null,
  location_state: null,
  venue_name: null,
  venue_address: null,
  venue_latitude: null,
  venue_longitude: null,
  geocode_city: null,
  geocode_state: null,
  event_image: null,
  event_image_thumb: null,
  buy_tickets: null,
  competition_slug: null,
  scores_released: 0,
  recap_released: 0,
  lineup_entries: 0,
  all_times_present: 0,
  participant_entries: 0,
  schedule_entries: 0,
  judge_assignments: 0,
  prediction_runs: 0,
  latest_prediction_at: null,
  season: '2026',
  ...over,
});

describe('toTourStops', () => {
  it('drops rows without coordinates, keeps geocoded ones', () => {
    const stops = toTourStops(
      [
        row({ slug: 'a', venue_latitude: 40, venue_longitude: -80 }),
        row({ slug: 'b' }), // no coords
        row({ slug: 'c', venue_latitude: 41, venue_longitude: -81 }),
      ],
      '2026'
    );
    expect(stops.map((s) => s.slug)).toEqual(['a', 'c']);
  });

  it('filters to the requested season', () => {
    const stops = toTourStops(
      [
        row({ slug: 'a', season: '2025', venue_latitude: 40, venue_longitude: -80 }),
        row({ slug: 'b', season: '2026', venue_latitude: 41, venue_longitude: -81 }),
      ],
      '2026'
    );
    expect(stops.map((s) => s.slug)).toEqual(['b']);
  });

  it('sorts by date then name, and slices the ISO date', () => {
    const stops = toTourStops(
      [
        row({ slug: 'later', start_date: '2026-07-04T00:00:00.000Z', venue_latitude: 1, venue_longitude: 1 }),
        row({ slug: 'b-same-day', name: 'B', start_date: '2026-07-01T00:00:00.000Z', venue_latitude: 1, venue_longitude: 1 }),
        row({ slug: 'a-same-day', name: 'A', start_date: '2026-07-01T00:00:00.000Z', venue_latitude: 1, venue_longitude: 1 }),
      ],
      '2026'
    );
    expect(stops.map((s) => s.slug)).toEqual(['a-same-day', 'b-same-day', 'later']);
    expect(stops[0]!.date).toBe('2026-07-01');
  });

  it('link slug prefers competition_slug; results attach via the callback', () => {
    const stops = toTourStops(
      [
        row({
          slug: 'raw',
          competition_slug: '2026-raw',
          venue_latitude: 40,
          venue_longitude: -80,
        }),
      ],
      '2026',
      () => ({ place: 2, total: 91.5 })
    );
    expect(stops[0]!.linkSlug).toBe('2026-raw');
    expect(stops[0]!.place).toBe(2);
    expect(stops[0]!.total).toBe(91.5);
  });
});
