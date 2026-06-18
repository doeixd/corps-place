// Read-model builders for the event directory. These are framework-agnostic
// async functions: they take a libSQL Client and return plain rows, running the
// exact SQL/CTEs and JS post-processing the EventDirectoryService used to run
// inline. Both the live service (fallback mode) and the emitter call these, so
// the live query and the emitted read-model can never drift (READ_MODEL_PLAN §5).

import type { Client } from '@libsql/client';
import { RELATED_CORPS_CTES, buildCorpsCanonicalMap } from './corpsAliases.js';

export type EventDirectoryRow = {
  // Present on the all-seasons listing (slugs repeat across seasons, so event_id
  // is the stable key); omitted by the single-season 2026 query.
  event_id?: string;
  season?: string;
  slug: string;
  name: string;
  event_name: string | null;
  start_date: string;
  start_time: string | null;
  web_start_time: string | null;
  edt_start_time: string | null;
  timezone: string | null;
  location_city: string | null;
  location_state: string | null;
  venue_name: string | null;
  venue_address: string | null;
  event_image: string | null;
  event_image_thumb: string | null;
  competition_slug: string | null;
  scores_released: number;
  recap_released: number;
  lineup_entries: number;
  // 1 when the event has a lineup and *every* entry has a real time (no nulls,
  // blanks, or "TBD"); 0 otherwise. Drives the "Times" readiness chip.
  all_times_present: number;
  participant_entries: number;
  schedule_entries: number;
  judge_assignments: number;
  prediction_runs: number;
  latest_prediction_at: string | null;
};

export type EventSeasonOption = {
  season: string;
  slug: string;
  competition_slug: string | null;
  name: string;
  event_name: string | null;
  start_date: string;
  location_city: string | null;
  location_state: string | null;
};

// One row of the full event schedule (every entry, including non-performance
// segments like gates/anthem/intermission and exhibitions — each with its time).
export type EventScheduleRow = {
  performance_order: number | null;
  unit_name: string;
  time: string | null;
  division_name: string | null;
  is_non_performance: number;
  is_exhibition: number;
  corps_key: string | null;
};

// The event's "about" blurb — the most recently scraped non-empty `about_text`
// from the event page. Note this is often logistical (ticket/fee disclaimers,
// travel offers) rather than descriptive, and many events have none; callers
// should treat the result as optional.
export const buildEventAbout = async (db: Client, slug: string): Promise<string | null> => {
  const result = await db.execute({
    sql: `
      SELECT about_text
      FROM event_page_scrapes
      WHERE event_slug = ? AND about_text IS NOT NULL AND length(trim(about_text)) > 0
      ORDER BY scraped_at DESC
      LIMIT 1
    `,
    args: [slug],
  });
  const text = result.rows[0]?.about_text;
  return typeof text === 'string' ? text.trim() : null;
};

// Bulk variant of buildEventAbout: the latest non-empty about_text per event in
// ONE windowed query, returned as a Map<event_slug, text>. The emitter uses this
// to avoid an N+1 over event_page_scrapes (~1.4k round-trips → 1). Equivalent to
// calling buildEventAbout per slug (asserted by verifyReadModel).
export const buildAllEventAbouts = async (db: Client): Promise<Map<string, string>> => {
  const result = await db.execute(`
    SELECT event_slug, about_text FROM (
      SELECT event_slug, trim(about_text) AS about_text,
        row_number() OVER (PARTITION BY event_slug ORDER BY scraped_at DESC) AS rn
      FROM event_page_scrapes
      WHERE about_text IS NOT NULL AND length(trim(about_text)) > 0
    ) WHERE rn = 1
  `);
  const map = new Map<string, string>();
  for (const row of result.rows as unknown as { event_slug: string; about_text: string }[]) {
    if (typeof row.about_text === 'string' && row.about_text.length > 0)
      map.set(row.event_slug, row.about_text);
  }
  return map;
};

// The complete lineup/schedule for one event, sourced from event_lineup_entries
// (which carries a time for *every* row — performances and the ceremony/break
// segments alike), left-joined to corps for each performer's division/class.
export const buildEventSchedule = async (db: Client, slug: string): Promise<EventScheduleRow[]> => {
  // The `classified_event_lineup` VIEW materializes its exclusion-pattern CTE
  // over EVERY lineup entry in the DB before the outer `event_slug` filter
  // applies (~114ms for a 14-row result). Inline the same logic but scope the
  // pattern matching to this one event up front (`ev` CTE) — identical output,
  // ~1ms. (Verified row-for-row against the view across events.)
  const viewQuery = {
    sql: `
      WITH ev AS (
        SELECT * FROM event_lineup_entries WHERE event_slug = ?
      ),
      pattern_matches AS (
        SELECT
          ele.entry_id,
          p.category,
          row_number() OVER (
            PARTITION BY ele.entry_id
            ORDER BY
              CASE p.category
                WHEN 'schedule_item' THEN 0
                WHEN 'not_a_corps' THEN 1
                WHEN 'alumni' THEN 2
                WHEN 'exhibition' THEN 3
                WHEN 'model' THEN 4
                ELSE 99
              END,
              length(p.pattern) DESC,
              p.pattern
          ) AS match_rank
        FROM ev ele
        JOIN domain_event_exclusion_patterns p
          ON lower(ele.unit_name) LIKE p.pattern
      ),
      selected_pattern AS (
        SELECT entry_id, category FROM pattern_matches WHERE match_rank = 1
      )
      SELECT
        ele.performance_order,
        COALESCE(ca.canonical_name, ele.unit_name) AS unit_name,
        ele.time,
        CASE WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN 1
             ELSE ele.is_non_performance END AS is_non_performance,
        ele.is_exhibition,
        CASE WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
             ELSE COALESCE(cc.division_name, c.division_name) END AS division_name,
        CASE WHEN sp.category IN ('schedule_item', 'not_a_corps') THEN NULL
             ELSE COALESCE(cc.corps_key, ep.corps_key) END AS corps_key
      FROM ev ele
      LEFT JOIN event_participants ep
        ON ep.event_slug = ele.event_slug AND ep.participant_id = ele.participant_id
      LEFT JOIN corps c ON c.corps_key = ep.corps_key
      -- Canonicalize alias variants (corps_aliases): a lineup recorded under a
      -- sparse variant (e.g. "Skyliners") displays and links to the fleshed-out
      -- record ("New York Skyliners"). cc is the canonical corps record.
      LEFT JOIN corps_aliases ca ON lower(ca.alias_name) = lower(ele.unit_name)
      LEFT JOIN corps cc ON lower(cc.name) = lower(ca.canonical_name)
      LEFT JOIN selected_pattern sp ON sp.entry_id = ele.entry_id
      ORDER BY COALESCE(ele.performance_order, 999), ele.time, ele.unit_name
    `,
    args: [slug],
  };
  const fallbackQuery = {
    sql: `
      WITH classified_lineup AS (
        SELECT
          ele.*,
          EXISTS (
            SELECT 1
            FROM domain_event_exclusion_patterns p
            WHERE p.category IN ('schedule_item', 'not_a_corps')
              AND lower(ele.unit_name) LIKE p.pattern
          ) AS is_non_corps
        FROM event_lineup_entries ele
        WHERE ele.event_slug = ?
      )
      SELECT
        ele.performance_order,
        COALESCE(ca.canonical_name, ele.unit_name) AS unit_name,
        ele.time,
        CASE WHEN ele.is_non_corps THEN 1 ELSE ele.is_non_performance END AS is_non_performance,
        ele.is_exhibition,
        CASE WHEN ele.is_non_corps THEN NULL ELSE COALESCE(cc.division_name, c.division_name) END AS division_name,
        CASE WHEN ele.is_non_corps THEN NULL ELSE COALESCE(cc.corps_key, ep.corps_key) END AS corps_key
      FROM classified_lineup ele
      LEFT JOIN event_participants ep
        ON ep.event_slug = ele.event_slug AND ep.participant_id = ele.participant_id
      LEFT JOIN corps c ON c.corps_key = ep.corps_key
      -- Canonicalize alias variants (corps_aliases) — see the primary query.
      LEFT JOIN corps_aliases ca ON lower(ca.alias_name) = lower(ele.unit_name)
      LEFT JOIN corps cc ON lower(cc.name) = lower(ca.canonical_name)
      ORDER BY COALESCE(ele.performance_order, 999), ele.time, ele.unit_name
    `,
    args: [slug],
  };
  const result = await db.execute(viewQuery).catch((error) => {
    if (String(error).includes('classified_event_lineup')) {
      return db.execute(fallbackQuery);
    }
    throw error;
  });
  const rows = result.rows as unknown as EventScheduleRow[];

  // Resolve each performing corps to its canonical identity — the most complete
  // record in the alias group (slug + logo). The SQL canonicalizes the *name*
  // via corps_aliases, but that can land on a bare record (e.g. "Connecticut
  // Hurricanes" with no logo) when the fleshed-out record is the alias side.
  // Re-point corps_key + unit_name so the lineup shows the right picture/link.
  const canon = await buildCorpsCanonicalMap(db);
  return rows.map((r) => {
    if (!r.corps_key) return r;
    const rep = canon.get(r.corps_key);
    return rep ? { ...r, corps_key: rep.corps_key, unit_name: rep.name } : r;
  });
};

export const buildEventsForSeason = async (
  db: Client,
  season: string
): Promise<EventDirectoryRow[]> => {
  const result = await db.execute({
    sql: `
      WITH event_base AS (
        SELECT
          e.event_id,
          e.slug,
          e.name,
          e.event_name,
          e.start_date,
          e.start_time,
          e.web_start_time,
          e.edt_start_time,
          e.timezone,
          e.location_city,
          e.location_state,
          e.event_image,
          e.event_image_thumb
        FROM events e
        WHERE e.season = ?
           OR e.year = ?
           OR e.start_date LIKE ?
      ),
      competition_match AS (
        SELECT
          eb.slug AS event_slug,
          COALESCE(m.competition_slug, c.slug) AS competition_slug,
          MAX(COALESCE(c.scores_released, 0)) AS scores_released,
          MAX(COALESCE(c.recap_released, 0)) AS recap_released
  FROM event_base eb
        LEFT JOIN event_to_competition m ON m.event_slug = eb.slug
        LEFT JOIN competitions c
          ON c.slug = COALESCE(m.competition_slug, eb.slug)
        GROUP BY eb.slug
      ),
      lineup_counts AS (
        SELECT event_slug, COUNT(*) AS count
        FROM event_lineup_entries
        GROUP BY event_slug
      ),
      time_coverage AS (
        SELECT event_slug,
          CASE
            WHEN COUNT(*) > 0
              AND SUM(
                CASE WHEN time IS NULL OR trim(time) = '' OR upper(time) LIKE '%TBD%'
                  THEN 1 ELSE 0 END
              ) = 0
            THEN 1 ELSE 0
          END AS all_times_present
        FROM event_lineup_entries
        GROUP BY event_slug
      ),
      participant_counts AS (
        SELECT event_slug, COUNT(*) AS count
        FROM event_participants
        GROUP BY event_slug
      ),
      schedule_counts AS (
        SELECT event_id, COUNT(*) AS count
        FROM event_schedules
        GROUP BY event_id
      ),
      judge_counts AS (
        SELECT competition_slug, COUNT(DISTINCT normalized_caption_name) AS count
        FROM judge_assignments
        GROUP BY competition_slug
      ),
      prediction_counts AS (
        SELECT
          event_slug,
          COUNT(*) AS count,
          MAX(predicted_at) AS latest_prediction_at
        FROM model_event_prediction_runs
        WHERE season = ?
        GROUP BY event_slug
      ),
      venues AS (
        -- One venue per event, name + address taken from the same row. SQLite
        -- returns the other columns from the row holding MIN(venue_id), so the
        -- pair stays consistent even when an event has multiple venue rows.
        SELECT event_slug, name AS venue_name, address AS venue_address, MIN(venue_id)
        FROM event_venues
        WHERE event_slug IS NOT NULL
        GROUP BY event_slug
      )
      SELECT
        eb.slug,
        eb.name,
        eb.event_name,
        eb.start_date,
        eb.start_time,
        eb.web_start_time,
        eb.edt_start_time,
        eb.timezone,
        eb.location_city,
        eb.location_state,
        v.venue_name,
        v.venue_address,
        eb.event_image,
        eb.event_image_thumb,
        cm.competition_slug,
        COALESCE(cm.scores_released, 0) AS scores_released,
        COALESCE(cm.recap_released, 0) AS recap_released,
        COALESCE(lc.count, 0) AS lineup_entries,
        COALESCE(tc.all_times_present, 0) AS all_times_present,
        COALESCE(pc.count, 0) AS participant_entries,
        COALESCE(sc.count, 0) AS schedule_entries,
        COALESCE(jc.count, 0) AS judge_assignments,
        COALESCE(pr.count, 0) AS prediction_runs,
        pr.latest_prediction_at
      FROM event_base eb
      LEFT JOIN competition_match cm ON cm.event_slug = eb.slug
      LEFT JOIN lineup_counts lc ON lc.event_slug = eb.slug
      LEFT JOIN time_coverage tc ON tc.event_slug = eb.slug
      LEFT JOIN participant_counts pc ON pc.event_slug = eb.slug
      LEFT JOIN schedule_counts sc ON sc.event_id = eb.event_id
      LEFT JOIN judge_counts jc ON jc.competition_slug = cm.competition_slug
      LEFT JOIN prediction_counts pr ON pr.event_slug = eb.slug
      LEFT JOIN venues v ON v.event_slug = eb.slug
      ORDER BY eb.start_date ASC, COALESCE(eb.start_time, eb.web_start_time, eb.edt_start_time, '') ASC, eb.name ASC
    `,
    args: [season, season, `${season}%`],
  });
  return result.rows as unknown as EventDirectoryRow[];
};

// Event slugs a corps appears in (via its participant rows), resolved from the
// corps slug. Used to filter the all-events directory to a corps's appearances.
export const buildEventSlugsForCorps = async (db: Client, slug: string): Promise<Set<string>> => {
  const result = await db.execute({
    // Include appearances from every corps record aliased to this one, not
    // just the slug's own corps_key — duplicate/variant records (e.g. the
    // several "Alisal Union School District" programs unified via
    // corps_aliases) each hold their own participant rows. See corpsAliases.ts.
    sql: `
      WITH ${RELATED_CORPS_CTES}
      SELECT DISTINCT ep.event_slug
      FROM event_participants ep
      JOIN related_corps rc ON rc.corps_key = ep.corps_key
    `,
    args: [slug],
  });
  return new Set(
    result.rows.map((r) => String((r as unknown as { event_slug: string }).event_slug))
  );
};

// Every event across all seasons (keyed by event_id, since slugs repeat across
// seasons). `season` is derived for grouping/filtering in the UI. Competition
// matching is correlated per-event on its own season. Newest season first, then
// chronological within the season.
// `eventSlugs` (optional) restricts the whole query to those events — used by
// corps appearances so we don't run the full all-events directory (esp. the
// correlated competition_match) just to keep a handful of rows.
export const buildAllEvents = async (
  db: Client,
  eventSlugs?: readonly string[]
): Promise<EventDirectoryRow[]> => {
  const slugFilter =
    eventSlugs && eventSlugs.length > 0
      ? `WHERE e.slug IN (${eventSlugs.map(() => '?').join(', ')})`
      : '';
  const result = await db.execute({
    args: eventSlugs && eventSlugs.length > 0 ? [...eventSlugs] : [],
    sql: `
    WITH event_base AS (
      SELECT
        e.event_id,
        e.slug,
        e.name,
        e.event_name,
        e.start_date,
        e.start_time,
        e.web_start_time,
        e.edt_start_time,
        e.timezone,
        e.location_city,
        e.location_state,
        e.event_image,
        e.event_image_thumb,
        COALESCE(NULLIF(e.season, ''), NULLIF(e.year, ''), substr(e.start_date, 1, 4)) AS season
      FROM events e
      ${slugFilter}
    ),
    competition_resolution AS (
      -- Season-aware: event slugs repeat across seasons (e.g. "brass-impact"),
      -- so resolve to the competition in this event's own season. Prefer the
      -- season-prefixed slug, then a same-season exact slug, then a same-season
      -- event_to_competition mapping; never collapse onto another season.
      SELECT
        eb.event_id AS event_id,
        COALESCE(
          (SELECT cc.slug FROM competitions cc WHERE cc.slug = eb.season || '-' || eb.slug LIMIT 1),
          (SELECT cc.slug FROM competitions cc WHERE cc.slug = eb.slug AND cc.season = eb.season LIMIT 1),
          (SELECT m.competition_slug FROM event_to_competition m
             JOIN competitions cc ON cc.slug = m.competition_slug
            WHERE m.event_slug = eb.slug AND cc.season = eb.season LIMIT 1),
          eb.slug
        ) AS competition_slug
      FROM event_base eb
    ),
    competition_match AS (
      SELECT
        cr.event_id AS event_id,
        cr.competition_slug AS competition_slug,
        COALESCE(c.scores_released, 0) AS scores_released,
        COALESCE(c.recap_released, 0) AS recap_released
      FROM competition_resolution cr
      LEFT JOIN competitions c ON c.slug = cr.competition_slug
    ),
    lineup_counts AS (
      SELECT event_slug, COUNT(*) AS count FROM event_lineup_entries GROUP BY event_slug
    ),
    time_coverage AS (
      SELECT event_slug,
        CASE
          WHEN COUNT(*) > 0
            AND SUM(
              CASE WHEN time IS NULL OR trim(time) = '' OR upper(time) LIKE '%TBD%'
                THEN 1 ELSE 0 END
            ) = 0
          THEN 1 ELSE 0
        END AS all_times_present
      FROM event_lineup_entries
      GROUP BY event_slug
    ),
    participant_counts AS (
      SELECT event_slug, COUNT(*) AS count FROM event_participants GROUP BY event_slug
    ),
    schedule_counts AS (
      SELECT event_id, COUNT(*) AS count FROM event_schedules GROUP BY event_id
    ),
    judge_counts AS (
      SELECT competition_slug, COUNT(DISTINCT normalized_caption_name) AS count
      FROM judge_assignments GROUP BY competition_slug
    ),
    prediction_counts AS (
      SELECT event_slug, COUNT(*) AS count, MAX(predicted_at) AS latest_prediction_at
      FROM model_event_prediction_runs GROUP BY event_slug
    )
    SELECT
      eb.event_id,
      eb.slug,
      eb.name,
      eb.event_name,
      eb.start_date,
      eb.start_time,
      eb.web_start_time,
      eb.edt_start_time,
      eb.timezone,
      eb.location_city,
      eb.location_state,
      eb.event_image,
      eb.event_image_thumb,
      eb.season,
      cm.competition_slug,
      COALESCE(cm.scores_released, 0) AS scores_released,
      COALESCE(cm.recap_released, 0) AS recap_released,
      COALESCE(lc.count, 0) AS lineup_entries,
      COALESCE(tc.all_times_present, 0) AS all_times_present,
      COALESCE(pc.count, 0) AS participant_entries,
      COALESCE(sc.count, 0) AS schedule_entries,
      COALESCE(jc.count, 0) AS judge_assignments,
      COALESCE(pr.count, 0) AS prediction_runs,
      pr.latest_prediction_at
    FROM event_base eb
    LEFT JOIN competition_match cm ON cm.event_id = eb.event_id
    LEFT JOIN lineup_counts lc ON lc.event_slug = eb.slug
    LEFT JOIN time_coverage tc ON tc.event_slug = eb.slug
    LEFT JOIN participant_counts pc ON pc.event_slug = eb.slug
    LEFT JOIN schedule_counts sc ON sc.event_id = eb.event_id
    LEFT JOIN judge_counts jc ON jc.competition_slug = cm.competition_slug
    LEFT JOIN prediction_counts pr ON pr.event_slug = eb.slug
    ORDER BY
      eb.season DESC,
      eb.start_date ASC,
      COALESCE(eb.start_time, eb.web_start_time, eb.edt_start_time, '') ASC,
      eb.name ASC
  `,
  });
  return result.rows as unknown as EventDirectoryRow[];
};

// Lightweight event query for pages that only need basic info + readiness flags.
// Skips the heavy CTEs (venue, schedule counts, participant counts, etc.) that
// the full directory query computes. Used by the prediction page.
export const buildEventBasic = async (
  db: Client,
  slug: string
): Promise<EventDirectoryRow | null> => {
  const result = await db.execute({
    sql: `
      WITH event_base AS (
        SELECT
          e.slug,
          e.name,
          e.event_name,
          e.start_date,
          e.location_city,
          e.location_state
        FROM events e
        WHERE e.slug = ?
      ),
      competition_match AS (
        SELECT
          eb.slug AS event_slug,
          COALESCE(m.competition_slug, eb.slug) AS competition_slug,
          MAX(COALESCE(c.scores_released, 0)) AS scores_released
        FROM event_base eb
        LEFT JOIN event_to_competition m ON m.event_slug = eb.slug
        LEFT JOIN competitions c ON c.slug = COALESCE(m.competition_slug, eb.slug)
        GROUP BY eb.slug, COALESCE(m.competition_slug, eb.slug)
      ),
      lineup_counts AS (
        SELECT event_slug, COUNT(*) AS count,
          CASE
            WHEN COUNT(*) > 0
              AND SUM(
                CASE WHEN time IS NULL OR trim(time) = '' OR upper(time) LIKE '%TBD%'
                  THEN 1 ELSE 0 END
              ) = 0
            THEN 1 ELSE 0
          END AS all_times_present
        FROM event_lineup_entries
        WHERE event_slug = ?
        GROUP BY event_slug
      ),
      judge_counts AS (
        SELECT competition_slug, COUNT(DISTINCT normalized_caption_name) AS count
        FROM judge_assignments
        WHERE competition_slug = (
          SELECT COALESCE(m.competition_slug, e.slug)
          FROM events e
          LEFT JOIN event_to_competition m ON m.event_slug = e.slug
          WHERE e.slug = ?
        )
        GROUP BY competition_slug
      ),
      prediction_counts AS (
        SELECT event_slug, COUNT(*) AS count
        FROM model_event_prediction_runs
        WHERE event_slug = ? AND season = '2026'
        GROUP BY event_slug
      )
      SELECT
        eb.slug,
        eb.name,
        eb.event_name,
        eb.start_date,
        NULL AS start_time,
        NULL AS web_start_time,
        NULL AS edt_start_time,
        NULL AS timezone,
        eb.location_city,
        eb.location_state,
        NULL AS venue_name,
        NULL AS venue_address,
        NULL AS event_image,
        NULL AS event_image_thumb,
        cm.competition_slug,
        COALESCE(cm.scores_released, 0) AS scores_released,
        0 AS recap_released,
        COALESCE(lc.count, 0) AS lineup_entries,
        COALESCE(lc.all_times_present, 0) AS all_times_present,
        0 AS participant_entries,
        0 AS schedule_entries,
        COALESCE(jc.count, 0) AS judge_assignments,
        COALESCE(pr.count, 0) AS prediction_runs,
        NULL AS latest_prediction_at
      FROM event_base eb
      LEFT JOIN competition_match cm ON cm.event_slug = eb.slug
      LEFT JOIN lineup_counts lc ON lc.event_slug = eb.slug
      LEFT JOIN judge_counts jc ON jc.competition_slug = cm.competition_slug
      LEFT JOIN prediction_counts pr ON pr.event_slug = eb.slug
      LIMIT 1
    `,
    args: [slug, slug, slug, slug],
  });
  return (result.rows[0] ?? null) as unknown as EventDirectoryRow | null;
};

export const buildEventBySlug = async (
  db: Client,
  slug: string
): Promise<EventDirectoryRow | null> => {
  const events = await buildAllEvents(db, [slug]);
  return events[0] ?? null;
};

export const buildEventBySeasonAndSlug = async (
  db: Client,
  season: string,
  slug: string
): Promise<EventDirectoryRow | null> => {
  const unprefixedSlug = slug.replace(/^\d{4}-/, '');
  const prefixedSlug = `${season}-${unprefixedSlug}`;
  const events = await buildAllEvents(
    db,
    Array.from(new Set([slug, unprefixedSlug, prefixedSlug]))
  );
  return (
    events.find((event) => event.season === season && event.slug === slug) ??
    events.find((event) => event.season === season && event.slug === prefixedSlug) ??
    events.find((event) => event.season === season && event.slug === unprefixedSlug) ??
    null
  );
};

export type EventSeriesCandidate = EventSeasonOption & {
  kind: 'event' | 'competition';
};

const normalizeEventText = (value: string) =>
  value
    .toLowerCase()
    .replace(/^\d{4}[-\s]+/, '')
    .replace(/\b\d{4}\b/g, '')
    .replace(/^drum corps at the cinema[:\s-]*/g, '')
    .replace(/\btour of champions\b/g, '')
    .replace(/\bpresented by\b.*$/g, '')
    .replace(/\bthe\b/g, '')
    .replace(/\bpremiere\b/g, 'premier')
    .replace(/\bpremier\b/g, 'premier')
    .replace(/\bpreview\b/g, 'premier')
    .replace(/[^a-z0-9]+/g, '');

const knownSeriesKey = (value: string) => {
  const key = normalizeEventText(value);
  if (key.includes('dcitourpremier')) return 'dcitourpremier';
  if (key.includes('nightbeat')) return 'nightbeat';
  return key;
};

const eventSeriesKeys = (values: readonly (string | null | undefined)[]) =>
  new Set(values.map((value) => (value ? knownSeriesKey(value) : '')).filter(Boolean));

const eventCandidateScore = (
  candidate: EventSeriesCandidate,
  targetKeys: ReadonlySet<string>,
  targetSeason?: string
) => {
  const keys = eventSeriesKeys([candidate.slug, candidate.name, candidate.event_name]);
  if (![...keys].some((key) => targetKeys.has(key))) return 0;

  let score = 10;
  if (candidate.kind === 'event') score += 4;
  if (candidate.season === targetSeason) score += 4;
  if (
    /^drum-corps-at-the-cinema/i.test(candidate.slug) ||
    /drum corps at the cinema/i.test(candidate.name)
  ) {
    score -= 5;
  }
  if (candidate.slug.startsWith(`${candidate.season}-`)) score += 2;
  if (candidate.competition_slug) score += 2;
  if (candidate.location_city && candidate.location_city !== 'Multiple Cities') score += 1;
  return score;
};

const eventSeason = (row: { season: string | null; start_date: string | null }) =>
  row.season && row.season.trim() ? row.season : (row.start_date?.slice(0, 4) ?? '');

// The full cross-season candidate set (events + competitions). One UNION scan;
// exported so the emitter can fetch it ONCE and pass it to the per-slug builders
// below instead of re-scanning per slug (the N+1 the emitter avoids).
export const buildEventSeriesCandidates = async (db: Client) => {
  const result = await db.execute(`
    SELECT
      'event' AS kind,
      COALESCE(NULLIF(e.season, ''), NULLIF(e.year, ''), substr(e.start_date, 1, 4)) AS season,
      e.slug,
      COALESCE(
        CASE
          WHEN mc.season = COALESCE(NULLIF(e.season, ''), NULLIF(e.year, ''), substr(e.start_date, 1, 4))
          THEN m.competition_slug
          ELSE NULL
        END,
        c.slug
      ) AS competition_slug,
      e.name,
      e.event_name,
      e.start_date,
      e.location_city,
      e.location_state
    FROM events e
    LEFT JOIN event_to_competition m ON m.event_slug = e.slug
    LEFT JOIN competitions mc ON mc.slug = m.competition_slug
    LEFT JOIN competitions c
      ON c.season = COALESCE(NULLIF(e.season, ''), NULLIF(e.year, ''), substr(e.start_date, 1, 4))
     AND (
       c.slug = e.slug
       OR c.slug = (COALESCE(NULLIF(e.season, ''), NULLIF(e.year, ''), substr(e.start_date, 1, 4)) || '-' || e.slug)
       OR (date(c.date) = date(e.start_date) AND lower(c.event_name) = lower(COALESCE(e.event_name, e.name)))
     )
    WHERE e.slug IS NOT NULL
      AND e.start_date IS NOT NULL
    UNION ALL
    SELECT
      'competition' AS kind,
      c.season,
      c.slug,
      c.slug AS competition_slug,
      c.event_name AS name,
      c.event_name,
      c.date AS start_date,
      c.location AS location_city,
      NULL AS location_state
    FROM competitions c
    WHERE c.slug IS NOT NULL
      AND c.date IS NOT NULL
  `);
  return result.rows as unknown as EventSeriesCandidate[];
};

export const buildEventSeasonOptions = async (
  db: Client,
  slug: string,
  candidates?: EventSeriesCandidate[]
): Promise<EventSeasonOption[]> => {
  const rows = candidates ?? (await buildEventSeriesCandidates(db));
  const current = rows.find((row) => row.slug === slug || row.competition_slug === slug);
  if (!current) return [] as EventSeasonOption[];

  const targetKeys = eventSeriesKeys([current.slug, current.name, current.event_name]);
  const bySeason = new Map<string, EventSeasonOption>();
  for (const row of rows) {
    const season = eventSeason(row);
    if (!season) continue;
    const option = { ...row, season };
    const existing = bySeason.get(season);
    if (eventCandidateScore(option, targetKeys, current.season) === 0) continue;
    if (
      !existing ||
      eventCandidateScore(option, targetKeys, current.season) >
        eventCandidateScore({ ...existing, kind: 'event' }, targetKeys, current.season)
    ) {
      bySeason.set(season, option);
    }
  }

  return [...bySeason.values()].sort((a, b) => b.season.localeCompare(a.season));
};

export const buildCompetitionSlugForSeasonEvent = async (
  db: Client,
  season: string,
  slug: string,
  candidates?: EventSeriesCandidate[]
): Promise<string> => {
  const rows = candidates ?? (await buildEventSeriesCandidates(db));
  const unprefixedSlug = slug.replace(/^\d{4}-/, '');
  const directCompetition = rows.find(
    (row) =>
      row.kind === 'competition' &&
      row.season === season &&
      (row.slug === slug || row.slug === `${season}-${unprefixedSlug}`)
  );
  if (directCompetition?.competition_slug) return directCompetition.competition_slug;

  const current =
    rows.find((row) => row.season === season && row.slug === slug) ??
    rows.find((row) => row.season === season && row.slug === unprefixedSlug) ??
    rows.find((row) => row.slug === slug || row.competition_slug === slug);
  if (!current) return `${season}-${unprefixedSlug}`;

  const targetKeys = eventSeriesKeys([current.slug, current.name, current.event_name]);
  const matches = rows
    .filter((row) => row.season === season && row.competition_slug)
    .map((row) => ({
      row,
      score: eventCandidateScore(row, targetKeys, season),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return matches[0]?.row.competition_slug ?? `${season}-${unprefixedSlug}`;
};
