// Read-model builders for the corps directory & detail pages. Framework-agnostic
// async functions sharing one definition between the live CorpsDirectoryService
// (fallback mode) and the emitter (READ_MODEL_PLAN §5). The alias-merge and
// uncertainty-band JS post-processing lives here so it cannot drift.

import type { Client } from '@libsql/client';
import { ACTIVE_CORPS_CTE, LATEST_LINEUP_SEASON_CTE } from './activeCorps.js';
import { RELATED_CORPS_CTES } from './corpsAliases.js';

// A card-sized summary for the corps directory grid.
export type CorpsSummary = {
  corps_key: string;
  slug: string | null;
  name: string;
  division_name: string | null;
  display_city: string | null;
  corps_logo: string | null;
  // 1 iff the logo is "primarily dark/grey" (derived flag set by sdk
  // flagDarkLogos.ts): its dark-mode source is an auto-recolored variant of
  // corps_logo. Overridden by corps_logo_dark_url when that is present.
  corps_logo_dark: number;
  // Optional hand-made dark-background logo asset (curated; empty for now).
  corps_logo_dark_url: string | null;
  active: number;
  // 1 iff the corps performs at any event in the current season (broader than
  // `active`, which is competing-in-a-scored-lineup): includes exhibition,
  // alumni, legacy and guest performers. Drives default directory visibility so
  // every corps appearing at a 2026 event shows under "All".
  performing: number;
  // 1 iff the corps is an alumni/legacy unit (derived from name patterns +
  // corps.type), gated to corps without a real competitive division so the
  // SoundSport "Legacy Drum & Bugle Corps" isn't mistagged. Drives the "Alumni"
  // directory filter/badge.
  is_alumni: number;
  // Two brand accent colors (hex '#rrggbb'); the UI derives every per-corps accent
  // / chart color from these via sdk/src/corpsColors.ts. Auto-extracted from the
  // logo (scripts/extractCorpsColors.ts) or hand-set by the color editor.
  // color_secondary is null for single-hue marks; both null when never extracted.
  color_primary: string | null;
  color_secondary: string | null;
  color_source: string | null; // 'auto' | 'manual' | null
  aliases: readonly string[];
};

// The full record for a corps detail page.
export type CorpsDetail = CorpsSummary & {
  about: string | null;
  description: string | null;
  corps_photo: string | null;
  website: string | null;
  facebook: string | null;
  twitter: string | null;
  instagram: string | null;
  youtube: string | null;
  linked_in: string | null;
  dcx_museum_url: string | null;
  phone: string | null;
  main_phone: string | null;
  main_email: string | null;
  primary_email: string | null;
  contact_email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
};

// One event on a corps's season timeline. `predicted` is the latest prediction
// for that event; `actual` is the real score once released. `low`/`high` are a
// derived uncertainty band (model interval CIs aren't persisted), narrowing as
// the season progresses (via the run's percent_through).
export type CorpsSeasonPoint = {
  date: string;
  label: string;
  slug: string;
  predicted: number | null;
  actual: number | null;
  low: number | null;
  high: number | null;
};

export const normalizeCorpsName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\bthe\b/g, '')
    .replace(/\band\b/g, '')
    .replace(/\bdrum\b/g, '')
    .replace(/\bbugle\b/g, '')
    .replace(/\bcorps\b/g, '')
    .replace(/[^a-z0-9]+/g, '');

// The divisions/classes we list. Other `division_name` values in the table are
// noise for a corps directory (show names, year-prefixed entries, exhibition
// groups, "intermission"/"halftime", individuals, etc.).
export const CORPS_DIVISIONS = [
  'World Class',
  'Open Class',
  'All Age Class',
  'International Class',
  'SoundSport',
] as const;
export type CorpsDivision = (typeof CORPS_DIVISIONS)[number];

type CorpsAliasRow = {
  alias_key: string;
  alias_name: string;
  canonical_name: string;
};

const rowCompleteness = (row: Omit<CorpsSummary, 'aliases'>): number =>
  (row.slug ? 16 : 0) +
  (row.corps_logo ? 8 : 0) +
  (row.display_city ? 4 : 0) +
  (row.active || row.performing ? 2 : 0) +
  (row.division_name ? 1 : 0);

const mergeDirectoryRows = (
  rows: ReadonlyArray<Omit<CorpsSummary, 'aliases'>>,
  aliasesByName: ReadonlyMap<string, ReadonlySet<string>>
): CorpsSummary[] => {
  const byName = new Map<string, { row: Omit<CorpsSummary, 'aliases'>; aliases: Set<string> }>();
  const canonicalByAlias = new Map<string, string>();

  for (const [canonicalKey, aliases] of aliasesByName) {
    for (const alias of aliases) {
      const aliasKey = normalizeCorpsName(alias);
      if (aliasKey) canonicalByAlias.set(aliasKey, canonicalKey);
    }
  }

  for (const row of rows) {
    const nameKey = normalizeCorpsName(row.name);
    const key = canonicalByAlias.get(nameKey) ?? nameKey;
    const existing = byName.get(key);
    const inheritedAliases = aliasesByName.get(key) ?? new Set<string>();
    if (!existing) {
      byName.set(key, { row, aliases: new Set(inheritedAliases) });
      continue;
    }

    const keep = rowCompleteness(row) > rowCompleteness(existing.row) ? row : existing.row;
    const aliasSource = keep === row ? existing.row : row;
    const aliases = new Set([...existing.aliases, ...inheritedAliases]);
    if (aliasSource.name.trim().toLowerCase() !== keep.name.trim().toLowerCase()) {
      aliases.add(aliasSource.name.trim());
    }
    byName.set(key, { row: keep, aliases });
  }

  return [...byName.values()].map(({ row, aliases }) => ({
    ...row,
    aliases: [...aliases]
      .filter((alias) => alias.trim().toLowerCase() !== row.name.trim().toLowerCase())
      .sort((a, b) => a.localeCompare(b)),
  }));
};

export const buildCorpsDirectory = async (db: Client): Promise<CorpsSummary[]> => {
  const [corpsResult, aliasResult] = await Promise.all([
    db.execute({
      sql: `
      -- "Active" is derived from real performance lineups, not the stale
      -- corps.active column (see activeCorps.ts for the canonical definition).
      WITH ${LATEST_LINEUP_SEASON_CTE},
      ${ACTIVE_CORPS_CTE},
      -- Corps performing at any event in the current season (broader than
      -- active_corps): includes exhibition/alumni/legacy/guest units. Reads
      -- season_performing_corps, whose schedule-item filtering is driven by the
      -- domain_event_exclusion_patterns table (see sdk/src/lineupClassification).
      performing_corps AS (
        SELECT spc.corps_key
        FROM season_performing_corps spc
        JOIN current_season cs ON spc.season = cs.season
      )
      SELECT c.corps_key, c.slug, c.name, c.division_name, c.display_city, c.corps_logo,
        COALESCE(c.corps_logo_dark, 0) AS corps_logo_dark, c.corps_logo_dark_url,
        c.color_primary, c.color_secondary, c.color_source,
        CASE WHEN ac.corps_key IS NOT NULL THEN 1 ELSE 0 END AS active,
        CASE WHEN pc.corps_key IS NOT NULL THEN 1 ELSE 0 END AS performing,
        -- Alumni/legacy facet: matched via the 'alumni' patterns on the
        -- name or the type field. This intentionally wins even when DCI or
        -- SoundSport stores the unit's division_name as SoundSport.
        CASE WHEN lower(c.name) <> 'legacy drum & bugle corps'
          AND (
            EXISTS (
              SELECT 1 FROM domain_event_exclusion_patterns p
              WHERE p.category = 'alumni' AND lower(c.name) LIKE p.pattern
            )
            OR lower(COALESCE(c.type, '')) LIKE '%alumni%'
          )
        THEN 1 ELSE 0 END AS is_alumni
      FROM corps c
      LEFT JOIN active_corps ac ON ac.corps_key = c.corps_key
      LEFT JOIN performing_corps pc ON pc.corps_key = c.corps_key
      -- List corps in a known class/division, plus any corps performing at a
      -- current-season event regardless of division — so every corps appearing
      -- at a 2026 event shows up under "All", even with a blank/non-standard
      -- division_name.
      WHERE c.division_name IN (?, ?, ?, ?)
        OR c.division_name LIKE 'SoundSport%'
        OR pc.corps_key IS NOT NULL
      ORDER BY
        CASE
          WHEN c.division_name = ? THEN 0
          WHEN c.division_name = ? THEN 1
          WHEN c.division_name = ? THEN 2
          WHEN c.division_name = ? THEN 3
          WHEN c.division_name LIKE 'SoundSport%' THEN 4
          ELSE 5
        END,
        c.name COLLATE NOCASE ASC
    `,
      args: [...CORPS_DIVISIONS.slice(0, 4), ...CORPS_DIVISIONS.slice(0, 4)],
    }),
    db.execute({
      sql: `
        SELECT alias_key, alias_name, canonical_name
        FROM corps_aliases
      `,
      args: [],
    }),
  ]);

  // Group aliases by normalized corps name so spelling variants attach to
  // every matching directory row, including duplicate legacy entries.
  const aliasesByName = new Map<string, Set<string>>();
  for (const row of aliasResult.rows as unknown as CorpsAliasRow[]) {
    const key = normalizeCorpsName(row.canonical_name);
    if (!key) continue;
    const alias = row.alias_name.trim();
    if (!alias) continue;
    const set = aliasesByName.get(key) ?? new Set<string>();
    if (alias.toLowerCase() !== row.canonical_name.trim().toLowerCase()) {
      set.add(alias);
    }
    aliasesByName.set(key, set);
  }

  return mergeDirectoryRows(
    corpsResult.rows as unknown as Array<Omit<CorpsSummary, 'aliases'>>,
    aliasesByName
  );
};

export const buildCorpsSeasonScores = async (
  db: Client,
  slug: string,
  season = '2026'
): Promise<CorpsSeasonPoint[]> => {
  const result = await db.execute({
    // One row per event: the latest prediction run for that event, joined to
    // this corps's predicted/actual totals.
    sql: `
      WITH ${RELATED_CORPS_CTES},
      latest AS (
        SELECT event_slug, MAX(predicted_at) AS pa
        FROM model_event_prediction_runs
        WHERE season = ?
        GROUP BY event_slug
      )
      SELECT
        e.start_date AS date,
        COALESCE(e.event_name, e.name, run.event_slug) AS label,
        run.event_slug AS slug,
        r.predicted_total AS predicted,
        r.actual_total AS actual,
        run.percent_through AS percent_through
      FROM model_event_prediction_rows r
      JOIN model_event_prediction_runs run ON run.prediction_id = r.prediction_id
      JOIN latest l ON l.event_slug = run.event_slug AND l.pa = run.predicted_at
      LEFT JOIN events e ON e.slug = run.event_slug
      -- Union prediction rows across every corps record aliased to this org
      -- (see corpsAliases.ts), not just the slug's own corps_key.
      WHERE run.season = ? AND r.corps_key IN (SELECT corps_key FROM related_corps)
        -- Only surface a season timeline for an org actually competing this
        -- season. The model seeds future-event predictions from prior-season
        -- finalist ranks, so a corps on hiatus (e.g. Mandarins in 2026) still
        -- gets stale prediction rows; gating on real lineup presence keeps the
        -- corps page consistent with the directory's lineup-derived "active".
        AND EXISTS (
          SELECT 1 FROM scored_event_lineup sel
          JOIN events ev ON ev.slug = sel.event_slug
          WHERE ev.season = ? AND sel.corps_key IN (SELECT corps_key FROM related_corps)
        )
      ORDER BY e.start_date ASC
    `,
    args: [slug.trim().toLowerCase(), season, season, season],
  });

  // Dedupe to one point per event (guard against a corps_key matching more
  // than one prediction row), keeping the highest predicted total.
  const byEvent = new Map<string, CorpsSeasonPoint>();
  for (const raw of result.rows as unknown as Array<{
    date: string | null;
    label: string;
    slug: string;
    predicted: number | null;
    actual: number | null;
    percent_through: number | null;
  }>) {
    const predicted = typeof raw.predicted === 'number' ? raw.predicted : null;
    const pt = typeof raw.percent_through === 'number' ? raw.percent_through : 0;
    // Margin shrinks from ~4 pts early to ~1.5 pts near finals.
    const margin = 1.5 + 2.5 * (1 - Math.min(Math.max(pt, 0), 100) / 100);
    const point: CorpsSeasonPoint = {
      date: raw.date ?? '',
      label: raw.label,
      slug: raw.slug,
      predicted,
      actual: typeof raw.actual === 'number' ? raw.actual : null,
      low: predicted != null ? Number((predicted - margin).toFixed(2)) : null,
      high: predicted != null ? Number((predicted + margin).toFixed(2)) : null,
    };
    const existing = byEvent.get(raw.slug);
    if (!existing || (point.predicted ?? -Infinity) > (existing.predicted ?? -Infinity))
      byEvent.set(raw.slug, point);
  }
  return Array.from(byEvent.values()).sort((a, b) => a.date.localeCompare(b.date));
};

/** One season point as-of a specific snapshot date. */
export type CorpsSeasonSnapshotRow = CorpsSeasonPoint & { snapshot_at: string };

/**
 * The "prediction as of ___" matrix: buildCorpsSeasonScores generalized across
 * every snapshot date. For each distinct prediction date `d` (the discrete
 * recalc snapshots) and each event, picks the latest run with predicted_at ≤ end
 * of `d` and joins this corps's predicted/actual totals — so a chart can replay
 * what the forecast looked like at any past date. The LATEST snapshot's rows are
 * byte-equal to buildCorpsSeasonScores (same latest-per-event selection), which
 * is the back-compat / parity invariant the verifier checks (review High #3 /
 * SEASON_INGEST_AND_PREDICTION_HISTORY_PLAN M3).
 */
export const buildCorpsSeasonSnapshots = async (
  db: Client,
  slug: string,
  season = '2026'
): Promise<CorpsSeasonSnapshotRow[]> => {
  const result = await db.execute({
    sql: `
      WITH ${RELATED_CORPS_CTES},
      snaps AS (
        SELECT DISTINCT substr(run.predicted_at, 1, 10) AS snap
        FROM model_event_prediction_rows r
        JOIN model_event_prediction_runs run ON run.prediction_id = r.prediction_id
        WHERE run.season = ? AND r.corps_key IN (SELECT corps_key FROM related_corps)
          AND run.predicted_at IS NOT NULL
      ),
      asof AS (
        SELECT s.snap AS snap, run.event_slug AS event_slug, MAX(run.predicted_at) AS pa
        FROM snaps s
        JOIN model_event_prediction_runs run
          ON run.season = ? AND run.predicted_at <= s.snap || 'T23:59:59.999Z'
        GROUP BY s.snap, run.event_slug
      )
      SELECT
        a.snap AS snapshot_at,
        e.start_date AS date,
        COALESCE(e.event_name, e.name, run.event_slug) AS label,
        run.event_slug AS slug,
        r.predicted_total AS predicted,
        r.actual_total AS actual,
        run.percent_through AS percent_through
      FROM asof a
      JOIN model_event_prediction_runs run
        ON run.event_slug = a.event_slug AND run.predicted_at = a.pa AND run.season = ?
      JOIN model_event_prediction_rows r ON r.prediction_id = run.prediction_id
      LEFT JOIN events e ON e.slug = run.event_slug
      WHERE r.corps_key IN (SELECT corps_key FROM related_corps)
        AND EXISTS (
          SELECT 1 FROM scored_event_lineup sel
          JOIN events ev ON ev.slug = sel.event_slug
          WHERE ev.season = ? AND sel.corps_key IN (SELECT corps_key FROM related_corps)
        )
      ORDER BY a.snap ASC, e.start_date ASC
    `,
    args: [slug.trim().toLowerCase(), season, season, season, season],
  });

  // Dedupe to one point per (snapshot, event), highest predicted — the same rule
  // and shrinking low/high margin buildCorpsSeasonScores uses.
  const byKey = new Map<string, CorpsSeasonSnapshotRow>();
  for (const raw of result.rows as unknown as Array<{
    snapshot_at: string;
    date: string | null;
    label: string;
    slug: string;
    predicted: number | null;
    actual: number | null;
    percent_through: number | null;
  }>) {
    const predicted = typeof raw.predicted === 'number' ? raw.predicted : null;
    const pt = typeof raw.percent_through === 'number' ? raw.percent_through : 0;
    const margin = 1.5 + 2.5 * (1 - Math.min(Math.max(pt, 0), 100) / 100);
    const row: CorpsSeasonSnapshotRow = {
      snapshot_at: raw.snapshot_at,
      date: raw.date ?? '',
      label: raw.label,
      slug: raw.slug,
      predicted,
      actual: typeof raw.actual === 'number' ? raw.actual : null,
      low: predicted != null ? Number((predicted - margin).toFixed(2)) : null,
      high: predicted != null ? Number((predicted + margin).toFixed(2)) : null,
    };
    const key = `${raw.snapshot_at}|${raw.slug}`;
    const existing = byKey.get(key);
    if (!existing || (row.predicted ?? -Infinity) > (existing.predicted ?? -Infinity))
      byKey.set(key, row);
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.snapshot_at.localeCompare(b.snapshot_at) || a.date.localeCompare(b.date)
  );
};

export type CorpsAppearanceResult = {
  /** The event slug this result belongs to (mapped from competition_slug). */
  event_slug: string;
  /** The raw competition slug (pre-mapping) — lets the emit reconcile a result to
   *  the event the corps actually appears at when duplicate events are
   *  cross-linked in event_to_competition. */
  competition_slug: string;
  total: number | null;
  place: number | null;
};

/**
 * A corps's finalized result — total score + overall placement — at each event it
 * competed in, across all seasons. Sourced from the authoritative `corps_scores`
 * table (stored `total_score` + `rank`), keyed by event slug via
 * `event_to_competition`. Unioned across every corps record aliased to this org
 * (see corpsAliases.ts), and de-duped to one row per event: multi-round events
 * (prelims/finals share an event slug) keep the highest total (finals). Used to
 * annotate the corps profile's appearance cards; events without released scores
 * simply don't appear here.
 */
export const buildCorpsAppearanceResults = async (
  db: Client,
  slug: string
): Promise<CorpsAppearanceResult[]> => {
  const result = await db.execute({
    sql: `
      WITH ${RELATED_CORPS_CTES}
      SELECT COALESCE(m.event_slug, cs.competition_slug) AS event_slug,
             cs.competition_slug AS competition_slug,
             cs.total_score AS total,
             cs.rank AS place
      FROM corps_scores cs
      JOIN related_corps rc ON rc.corps_key = cs.corps_key
      LEFT JOIN event_to_competition m ON m.competition_slug = cs.competition_slug
      WHERE cs.total_score IS NOT NULL OR cs.rank IS NOT NULL
    `,
    args: [slug.trim().toLowerCase()],
  });

  const byEvent = new Map<string, CorpsAppearanceResult>();
  for (const raw of result.rows as unknown as Array<{
    event_slug: string;
    competition_slug: string;
    total: number | null;
    place: number | null;
  }>) {
    const row: CorpsAppearanceResult = {
      event_slug: String(raw.event_slug),
      competition_slug: String(raw.competition_slug),
      total: typeof raw.total === 'number' ? raw.total : null,
      place: typeof raw.place === 'number' ? raw.place : null,
    };
    const existing = byEvent.get(row.event_slug);
    if (!existing || (row.total ?? -Infinity) > (existing.total ?? -Infinity))
      byEvent.set(row.event_slug, row);
  }
  return Array.from(byEvent.values());
};

// Lightweight corps lookup for a specific set of corps_keys.
// Returns just slug + logo + name for building links in prediction recaps.
// Much faster than loading the entire directory when you only need a subset.
export const buildCorpsByKeys = async (
  db: Client,
  corpsKeys: readonly string[]
): Promise<CorpsSummary[]> => {
  if (corpsKeys.length === 0) return [] as CorpsSummary[];
  const placeholders = corpsKeys.map(() => '?').join(', ');
  const result = await db.execute({
    sql: `
      SELECT corps_key, slug, name, division_name, display_city, corps_logo,
             COALESCE(corps_logo_dark, 0) AS corps_logo_dark, corps_logo_dark_url,
             color_primary, color_secondary, color_source,
             active, 0 AS performing, 0 AS is_alumni
      FROM corps
      WHERE corps_key IN (${placeholders})
    `,
    args: [...corpsKeys],
  });
  return (result.rows as unknown as Array<Omit<CorpsSummary, 'aliases'>>).map((row) => ({
    ...row,
    aliases: [],
  }));
};

export const buildCorpsBySlug = async (
  db: Client,
  slug: string
): Promise<CorpsDetail | null> => {
  const result = await db.execute({
    sql: `
      SELECT corps_key, slug, name, division_name, display_city, corps_logo,
             COALESCE(corps_logo_dark, 0) AS corps_logo_dark, corps_logo_dark_url,
             color_primary, color_secondary, color_source, active,
             0 AS performing,
             CASE WHEN lower(name) <> 'legacy drum & bugle corps'
               AND (
                 EXISTS (
                   SELECT 1 FROM domain_event_exclusion_patterns p
                   WHERE p.category = 'alumni' AND lower(name) LIKE p.pattern
                 )
                 OR lower(COALESCE(type, '')) LIKE '%alumni%'
               )
             THEN 1 ELSE 0 END AS is_alumni,
             about, description, corps_photo, website, facebook, twitter, instagram, youtube,
             linked_in, dcx_museum_url, phone, main_phone, main_email, primary_email, contact_email,
             address, city, state, zip, country
      FROM corps
      WHERE slug = ?
      LIMIT 1
    `,
    args: [slug],
  });
  const row = result.rows[0] as unknown as CorpsDetail | undefined;
  return row ? { ...row, aliases: [] } : null;
};
