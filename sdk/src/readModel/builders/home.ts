// Read-model builder for the home "shows this weekend, near you" carousel.
// Groups a season's events into Fri–Sun weekend buckets, each show carrying its
// venue coordinates (for client-side nearest-first sorting) and its performing
// lineup. Like the other builders this is framework-agnostic and shared by both
// the live fallback and the emitter so the two can't drift (READ_MODEL_PLAN §5).
//
// The emitted data is NOT time-relative: we store EVERY weekend bucket of the
// season and let the reader/loader pick the current-or-next-non-empty one at
// request time (`chooseWeekend`). That keeps a stale emit correct.

import type { Client } from '@libsql/client';
import { buildEventSchedule } from './events.js';
import { buildEventRecap } from './recap.js';
import { buildLatestPredictionSummary } from './predictions.js';

export interface WeekendShowLineupEntry {
  performanceOrder: number | null;
  time: string | null;
  corpsName: string;
  corpsKey: string | null;
  divisionName: string | null;
  isExhibition: boolean;
  isNonPerformance: boolean;
}

export interface WeekendShow {
  slug: string;
  name: string;
  startDate: string; // UTC ISO (midnight Z) as stored
  startTime: string | null;
  venueName: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  lineup: WeekendShowLineupEntry[];
}

export interface WeekendBucket {
  weekendStart: string; // YYYY-MM-DD (Friday)
  weekendEnd: string; // YYYY-MM-DD (Sunday)
  shows: WeekendShow[];
}

// --- Latest results (home centerpiece) ---------------------------------------

export interface LatestResultPlacement {
  rank: number | null;
  corps: string;
  corpsKey: string;
  division: string | null;
  total: number | null;
}

export interface LatestResults {
  slug: string;
  eventName: string;
  date: string;
  placements: LatestResultPlacement[];
}

/**
 * The most recently completed competition (any season) with released scores,
 * plus its top placements. Across all seasons so the home centerpiece always has
 * real data — pre-season it surfaces last season's finals; once 2026 events post
 * scores it naturally rolls to the newest one. `limit` caps the placements shown.
 */
export const buildLatestResults = async (
  db: Client,
  limit = 8
): Promise<LatestResults | null> => {
  const result = await db.execute(`
    SELECT slug, event_name, date
    FROM competitions
    WHERE scores_released = 1 AND date IS NOT NULL AND trim(date) != ''
    ORDER BY date DESC, slug DESC
    LIMIT 1
  `);
  const row = result.rows[0] as unknown as
    | { slug: string; event_name: string; date: string }
    | undefined;
  if (!row) return null;

  const recap = await buildEventRecap(db, row.slug);
  const placements: LatestResultPlacement[] = recap.scores
    .slice(0, limit)
    .map((s) => ({
      rank: s.rank ?? null,
      corps: s.corps,
      corpsKey: s.corps_key,
      division: s.division ?? null,
      total: s.total ?? null,
    }));

  return {
    slug: row.slug,
    eventName: recap.meta?.event_name ?? row.event_name,
    date: recap.meta?.date ?? row.date,
    placements,
  };
};

// --- Season standings (home snapshot) ----------------------------------------

export interface StandingRow {
  rank: number;
  corps: string;
  corpsKey: string;
  corpsSlug: string | null;
  best: number;
}

export interface SeasonStandings {
  season: string;
  standings: StandingRow[];
}

/**
 * Top World Class corps by season-best total for the latest season with released
 * scores. Pre-season this is last completed season; a leaderboard snapshot for
 * the home page. `limit` caps the rows.
 */
export const buildSeasonStandings = async (
  db: Client,
  limit = 8
): Promise<SeasonStandings | null> => {
  const result = await db.execute({
    sql: `
      WITH latest AS (
        SELECT MAX(comp.season) AS season FROM competitions comp WHERE comp.scores_released = 1
      )
      SELECT cs.corps_key, cs.corps_name, c.slug AS corps_slug, MAX(cs.total_score) AS best
      FROM corps_scores cs
      JOIN competitions comp ON comp.slug = cs.competition_slug
      LEFT JOIN corps c ON c.corps_key = cs.corps_key
      WHERE comp.season = (SELECT season FROM latest)
        AND cs.division_name = 'World Class'
        AND cs.total_score IS NOT NULL
      GROUP BY cs.corps_key
      ORDER BY best DESC
      LIMIT ?
    `,
    args: [limit],
  });
  const rows = result.rows as unknown as Array<{
    corps_key: string;
    corps_name: string;
    corps_slug: string | null;
    best: number;
  }>;
  if (rows.length === 0) return null;

  const seasonRes = await db.execute(
    `SELECT MAX(season) AS season FROM competitions WHERE scores_released = 1`
  );
  const season = String((seasonRes.rows[0] as any)?.season ?? '');

  return {
    season,
    standings: rows.map((r, i) => ({
      rank: i + 1,
      corps: r.corps_name,
      corpsKey: r.corps_key,
      corpsSlug: r.corps_slug,
      best: r.best,
    })),
  };
};

// --- Featured prediction (home ML hook) --------------------------------------

export interface PredictedPlacement {
  rank: number | null;
  corps: string;
  corpsKey: string | null;
  division: string | null;
  total: number | null;
}

export interface FeaturedPrediction {
  slug: string;
  eventName: string;
  startDate: string;
  predictedAt: string | null;
  placements: PredictedPlacement[];
}

const today = (now: Date) => now.toISOString().slice(0, 10);

// Top-N placements from a saved prediction's summary recap (the same shape the
// prediction page consumes).
const topPlacements = (recap: unknown[], limit: number): PredictedPlacement[] =>
  (recap as Array<Record<string, any>>).slice(0, limit).map((r) => ({
    rank: r.rank ?? null,
    corps: r.corps ?? r.corps_key ?? '',
    corpsKey: r.corps_key ?? null,
    division: r.division ?? null,
    total: typeof r.total === 'number' ? r.total : null,
  }));

/**
 * The featured prediction for the home page: the next upcoming 2026 event that
 * has a saved prediction (falls back to the most recent predicted event when
 * none are upcoming), with its predicted top-N. Selection happens from `now`, so
 * it stays correct against a stale read-model. Reuses model_event_prediction_runs
 * + events; the reader mirror reads rm_event_prediction + rm_events.
 */
export const buildFeaturedPrediction = async (
  db: Client,
  now: Date = new Date(),
  limit = 6
): Promise<FeaturedPrediction | null> => {
  const result = await db.execute({
    sql: `
      SELECT r.event_slug AS slug,
             e.start_date AS start_date,
             COALESCE(NULLIF(e.event_name, ''), e.name) AS event_name
      FROM model_event_prediction_runs r
      JOIN events e ON e.slug = r.event_slug
      WHERE r.season = '2026' AND e.start_date IS NOT NULL
      GROUP BY r.event_slug
    `,
  });
  const rows = result.rows as unknown as Array<{
    slug: string;
    start_date: string;
    event_name: string;
  }>;
  const picked = pickFeaturedEvent(rows, now);
  if (!picked) return null;

  const summary = await buildLatestPredictionSummary(db, picked.slug, '2026');
  if (!summary) return null;
  return {
    slug: picked.slug,
    eventName: picked.event_name,
    startDate: picked.start_date,
    predictedAt: summary.predicted_at,
    placements: topPlacements(summary.summary.recap, limit),
  };
};

// Pure selection shared by builder + reader: earliest upcoming (start_date >=
// today), else the most recent past. Tie-break by slug for determinism.
export const pickFeaturedEvent = <T extends { slug: string; start_date: string }>(
  rows: ReadonlyArray<T>,
  now: Date
): T | null => {
  if (rows.length === 0) return null;
  const t = today(now);
  const upcoming = rows
    .filter((r) => r.start_date.slice(0, 10) >= t)
    .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.slug.localeCompare(b.slug));
  if (upcoming.length > 0) return upcoming[0]!;
  return [...rows].sort(
    (a, b) => b.start_date.localeCompare(a.start_date) || a.slug.localeCompare(b.slug)
  )[0]!;
};

// --- Pure date helpers (UTC; SDK dates are midnight-Z). ----------------------

const DAY_MS = 24 * 60 * 60 * 1000;

const toYmd = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The Friday (weekend-start) a date belongs to, or null if the date is a
 * weekday (Mon–Thu) and therefore not part of a Fri–Sun weekend.
 */
export const weekendStartFor = (dateISO: string): string | null => {
  const ymd = dateISO.slice(0, 10);
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay(); // Sun=0 … Fri=5, Sat=6
  const offset =
    dow === 5 ? 0 : // Fri
    dow === 6 ? 1 : // Sat
    dow === 0 ? 2 : // Sun
    null; // Mon–Thu
  if (offset === null) return null;
  return toYmd(new Date(d.getTime() - offset * DAY_MS));
};

const weekendEndFor = (weekendStart: string): string =>
  toYmd(new Date(new Date(`${weekendStart}T00:00:00.000Z`).getTime() + 2 * DAY_MS));

/**
 * The Fri–Sun weekend a date belongs to for the "shows coming up" feature —
 * like {@link weekendStartFor}, but Mon–Thu map FORWARD to that same week's
 * upcoming Friday. This groups midweek shows with the weekend they lead into, so
 * the section spans today → the upcoming weekend instead of only Fri–Sun. The
 * request-time `today` filter (in home-shows.ts) then trims already-past shows.
 */
export const featureWeekendStartFor = (dateISO: string): string | null => {
  const ymd = dateISO.slice(0, 10);
  const d = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  const dow = d.getUTCDay(); // Sun=0 … Fri=5, Sat=6
  // Days to SUBTRACT to land on that week's Friday. Fri 0, Sat 1, Sun 2; Mon–Thu
  // are negative (Friday is ahead of them): Mon −4 … Thu −1.
  const offset = dow === 5 ? 0 : dow === 6 ? 1 : dow === 0 ? 2 : dow - 5;
  return toYmd(new Date(d.getTime() - offset * DAY_MS));
};

/**
 * Pick the weekend to feature for `now`: the current weekend if it has shows,
 * otherwise the next upcoming weekend that has shows (rolls past empty/pre-season
 * gaps). Returns null when the season is over (no weekend ends on/after today).
 */
export const chooseWeekend = (
  buckets: ReadonlyArray<WeekendBucket>,
  now: Date
): { bucket: WeekendBucket; isCurrentWeekend: boolean } | null => {
  const today = toYmd(now);
  const sorted = [...buckets].sort((a, b) => a.weekendStart.localeCompare(b.weekendStart));
  for (const bucket of sorted) {
    if (bucket.weekendEnd >= today && bucket.shows.length > 0) {
      const isCurrentWeekend = bucket.weekendStart <= today && today <= bucket.weekendEnd;
      return { bucket, isCurrentWeekend };
    }
  }
  return null;
};

// --- Builder -----------------------------------------------------------------

interface EventVenueRow {
  slug: string;
  name: string;
  start_date: string;
  start_time: string | null;
  venue_name: string | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  state: string | null;
}

// Full schedule for the show, mirroring the event Lineup table: performances,
// exhibitions, and non-performance segments (gates/anthem/intermission/encore)
// alike, each flagged so the card can style them like the table does.
const lineupForShow = async (db: Client, slug: string): Promise<WeekendShowLineupEntry[]> => {
  const schedule = await buildEventSchedule(db, slug);
  return schedule.map((r) => ({
    performanceOrder: r.performance_order,
    time: r.time,
    corpsName: r.unit_name,
    corpsKey: r.corps_key,
    divisionName: r.division_name,
    isExhibition: r.is_exhibition === 1,
    isNonPerformance: r.is_non_performance === 1,
  }));
};

/**
 * Weekend buckets of a season, each with its shows + lineups. Midweek (Mon–Thu)
 * events are grouped with their week's UPCOMING weekend (via
 * featureWeekendStartFor), so the home "shows coming up" section can span today →
 * the weekend rather than only Fri–Sun. Buckets stay non-time-relative (every
 * weekend is emitted); the request-time `today` filter picks the window.
 */
export const buildHomeWeekendShows = async (
  db: Client,
  season: string
): Promise<WeekendBucket[]> => {
  const result = await db.execute({
    sql: `
      WITH venues AS (
        SELECT event_slug,
               name AS venue_name,
               venue_latitude AS lat,
               venue_longitude AS lng,
               geocode_city AS city,
               geocode_state AS state,
               MIN(venue_id)
        FROM event_venues
        WHERE event_slug IS NOT NULL
        GROUP BY event_slug
      )
      SELECT
        e.slug,
        COALESCE(NULLIF(e.event_name, ''), e.name) AS name,
        e.start_date,
        COALESCE(e.start_time, e.web_start_time, e.edt_start_time) AS start_time,
        v.venue_name,
        v.lat,
        v.lng,
        COALESCE(v.city, NULLIF(e.location_city, '')) AS city,
        COALESCE(v.state, NULLIF(e.location_state, '')) AS state
      FROM events e
      LEFT JOIN venues v ON v.event_slug = e.slug
      WHERE (e.season = ? OR e.year = ? OR e.start_date LIKE ?)
        AND e.start_date IS NOT NULL
      ORDER BY e.start_date ASC, COALESCE(e.start_time, e.web_start_time, e.edt_start_time, '') ASC
    `,
    args: [season, season, `${season}%`],
  });
  const rows = result.rows as unknown as EventVenueRow[];

  // Group into weekend buckets — midweek shows join their week's upcoming weekend.
  const byWeekend = new Map<string, EventVenueRow[]>();
  for (const row of rows) {
    const ws = featureWeekendStartFor(row.start_date);
    if (!ws) continue;
    const list = byWeekend.get(ws) ?? [];
    list.push(row);
    byWeekend.set(ws, list);
  }

  const buckets: WeekendBucket[] = [];
  for (const [weekendStart, evRows] of [...byWeekend.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const shows: WeekendShow[] = [];
    for (const row of evRows) {
      shows.push({
        slug: row.slug,
        name: row.name,
        startDate: row.start_date,
        startTime: row.start_time,
        venueName: row.venue_name,
        city: row.city,
        state: row.state,
        lat: row.lat,
        lng: row.lng,
        lineup: await lineupForShow(db, row.slug),
      });
    }
    buckets.push({ weekendStart, weekendEnd: weekendEndFor(weekendStart), shows });
  }
  return buckets;
};
