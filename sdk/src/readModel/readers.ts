// Read-model readers (READ_MODEL_PLAN §8): the fast path. Each function reads the
// frozen rm_* tables with indexed SELECTs (no CTEs, no fuzzy matching) and returns
// the SAME shape the matching builder returns, so a service can swap builder →
// reader with no behavior change. Parity between the two is asserted by
// verifyReadModel.ts on every emit.
//
// JSON-column readers (corps detail, recap, judges, predictions) just parse what
// the emitter stored verbatim from the builder, so they are identical by
// construction.

import type { Client } from "@libsql/client";
import type {
  CorpsDetail,
  CorpsSeasonPoint,
  CorpsSeasonSnapshotRow,
  CorpsSummary,
} from "./builders/corps.js";
import type {
  EventDirectoryRow,
  EventScheduleRow,
  EventSeasonOption,
} from "./builders/events.js";
import type { EventRecap } from "./builders/recap.js";
import type { FullEventRecap } from "./builders/fullRecap.js";
import type { EventPreviousRecap } from "./builders/previousRecap.js";
import type { JudgeProfile, JudgeSummary } from "./builders/judges.js";
import type { StaffProfile, StaffSummary } from "./builders/staff.js";
import type { LatestPredictionRow, EventPredictionAsOf } from "./builders/predictions.js";
import type { ShowInfoSummary, ShowDetail } from "./builders/shows.js";
import type { VsCorpsScorePoint, VsBaselinePoint, VsPredictedPoint } from "./builders/vs.js";
import type { RankingScoreRow, RankMetric } from "./builders/rankings.js";
import type {
  WeekendBucket,
  WeekendShow,
  LatestResults,
  SeasonStandings,
  FeaturedPrediction,
} from "./builders/home.js";
import { pickFeaturedEvent } from "./builders/home.js";
import type {
  MerchProductSummary,
  MerchProductDetail,
  MerchStoreSummary,
  MerchFacets,
  CorpsMerchTeaser,
} from "./builders/merch.js";

// rm_events → EventDirectoryRow. `includeVenue` mirrors which builder we stand in
// for: buildEventsForSeason selects venues; buildAllEvents does not. Keeping the
// distinction makes the reader byte-identical to the builder it replaces.
const rmEventRow = (r: any, includeVenue: boolean): EventDirectoryRow => ({
  event_id: r.event_id,
  season: r.season ?? undefined,
  slug: r.slug,
  name: r.name,
  event_name: r.event_name,
  start_date: r.start_date,
  start_time: r.start_time,
  web_start_time: r.web_start_time,
  edt_start_time: r.edt_start_time,
  timezone: r.timezone,
  location_city: r.location_city,
  location_state: r.location_state,
  ...(includeVenue
    ? { venue_name: r.venue_name, venue_address: r.venue_address }
    : { venue_name: null, venue_address: null }),
  event_image: r.event_image,
  event_image_thumb: r.event_image_thumb,
  buy_tickets: r.buy_tickets ?? null,
  competition_slug: r.competition_slug,
  scores_released: Number(r.scores_released),
  recap_released: Number(r.recap_released),
  lineup_entries: Number(r.lineup_entries),
  all_times_present: Number(r.all_times_present),
  participant_entries: Number(r.participant_entries),
  schedule_entries: Number(r.schedule_entries),
  judge_assignments: Number(r.judge_assignments),
  prediction_runs: Number(r.prediction_runs),
  latest_prediction_at: r.latest_prediction_at,
});

// buildEventsForSeason ordering: start_date ASC, COALESCE(times) ASC, name ASC.
// It also scopes prediction counts to the season and omits event_id/season from
// the row object — match all three.
export const readEventsForSeason = async (
  db: Client,
  season: string,
): Promise<EventDirectoryRow[]> => {
  const r = await db.execute({
    sql: `SELECT * FROM rm_events WHERE season = ?
          ORDER BY start_date ASC,
            COALESCE(start_time, web_start_time, edt_start_time, '') ASC, name ASC`,
    args: [season],
  });
  return (r.rows as any[]).map((row) => {
    const e = rmEventRow(row, true);
    delete (e as any).event_id;
    delete (e as any).season;
    // Season-scoped prediction counts (see rm_events.season_prediction_runs).
    e.prediction_runs = Number(row.season_prediction_runs ?? 0);
    e.latest_prediction_at = row.season_latest_prediction_at ?? null;
    return e;
  });
};

// buildAllEvents ordering: season DESC, start_date ASC, COALESCE(times) ASC, name ASC.
export const readAllEvents = async (
  db: Client,
  eventSlugs?: readonly string[],
): Promise<EventDirectoryRow[]> => {
  const filter =
    eventSlugs && eventSlugs.length > 0
      ? `WHERE slug IN (${eventSlugs.map(() => "?").join(", ")})`
      : "";
  const r = await db.execute({
    sql: `SELECT * FROM rm_events ${filter}
          ORDER BY season DESC, start_date ASC,
            COALESCE(start_time, web_start_time, edt_start_time, '') ASC, name ASC`,
    args: eventSlugs && eventSlugs.length > 0 ? [...eventSlugs] : [],
  });
  return (r.rows as any[]).map((row) => rmEventRow(row, false));
};

export const readEventBySlug = async (
  db: Client,
  slug: string,
): Promise<EventDirectoryRow | null> => {
  const rows = await readAllEvents(db, [slug]);
  return rows[0] ?? null;
};

// Events by event_id (same ordering as readAllEvents) — for corps appearances,
// which the read-model stores as corps_slug → event_id rows.
export const readEventsByIds = async (
  db: Client,
  eventIds: readonly string[],
): Promise<EventDirectoryRow[]> => {
  if (eventIds.length === 0) return [];
  const r = await db.execute({
    sql: `SELECT * FROM rm_events WHERE event_id IN (${eventIds.map(() => "?").join(", ")})
          ORDER BY season DESC, start_date ASC,
            COALESCE(start_time, web_start_time, edt_start_time, '') ASC, name ASC`,
    args: [...eventIds],
  });
  return (r.rows as any[]).map((row) => rmEventRow(row, false));
};

// The frozen event_ids a corps appears in (replaces RELATED_CORPS_CTES at read time).
export const readCorpsAppearanceEventIds = async (
  db: Client,
  corpsSlug: string,
): Promise<string[]> => {
  const r = await db.execute({
    sql: `SELECT event_id FROM rm_corps_appearances WHERE corps_slug = ? ORDER BY sort_index`,
    args: [corpsSlug.trim().toLowerCase()],
  });
  return (r.rows as any[]).map((row) => String(row.event_id));
};

/** A corps's per-appearance result (total + place), keyed by event_id, for the
 *  profile's appearance cards. Mirrors buildCorpsAppearanceResults (the event
 *  slug is mapped to event_id at emit time). */
export const readCorpsAppearanceResults = async (
  db: Client,
  corpsSlug: string,
): Promise<
  { event_id: string; total: number | null; place: number | null }[]
> => {
  const r = await db.execute({
    sql: `SELECT event_id, total_score, place FROM rm_corps_appearance_results WHERE corps_slug = ?`,
    args: [corpsSlug.trim().toLowerCase()],
  });
  return (r.rows as any[]).map((row) => ({
    event_id: String(row.event_id),
    total: row.total_score == null ? null : Number(row.total_score),
    place: row.place == null ? null : Number(row.place),
  }));
};

export const readEventBySeasonAndSlug = async (
  db: Client,
  season: string,
  slug: string,
): Promise<EventDirectoryRow | null> => {
  const unprefixed = slug.replace(/^\d{4}-/, "");
  const prefixed = `${season}-${unprefixed}`;
  const events = await readAllEvents(
    db,
    Array.from(new Set([slug, unprefixed, prefixed])),
  );
  return (
    events.find((e) => e.season === season && e.slug === slug) ??
    events.find((e) => e.season === season && e.slug === prefixed) ??
    events.find((e) => e.season === season && e.slug === unprefixed) ??
    null
  );
};

// buildEventBasic returns the same EventDirectoryRow shape (a subset of columns,
// but the row object carries all keys with the unused ones null). rm_events has
// every column, so reuse readEventBySlug — its consumers only read the basic
// fields + readiness flags.
export const readEventBasic = readEventBySlug;

export const readEventAbout = async (
  db: Client,
  slug: string,
): Promise<string | null> => {
  const r = await db.execute({
    sql: `SELECT about_text FROM rm_events WHERE slug = ? AND about_text IS NOT NULL LIMIT 1`,
    args: [slug],
  });
  const t = r.rows[0]?.about_text;
  return typeof t === "string" ? t : null;
};

export const readEventSchedule = async (
  db: Client,
  slug: string,
): Promise<EventScheduleRow[]> => {
  const r = await db.execute({
    sql: `SELECT performance_order, unit_name, time, is_non_performance, is_exhibition,
                 division_name, corps_key
          FROM rm_event_schedule WHERE event_slug = ? ORDER BY sort_index`,
    args: [slug],
  });
  return (r.rows as any[]).map((row) => ({
    performance_order:
      row.performance_order === null ? null : Number(row.performance_order),
    unit_name: row.unit_name,
    time: row.time,
    division_name: row.division_name,
    is_non_performance: Number(row.is_non_performance),
    is_exhibition: Number(row.is_exhibition),
    corps_key: row.corps_key,
  }));
};

// rm_home_weekend_shows → WeekendBucket[] (identical to buildHomeWeekendShows by
// construction: shows_json is the verbatim bucket payload). Caller picks the
// weekend to feature via chooseWeekend(buckets, now).
export const readHomeWeekendShows = async (
  db: Client,
  season: string,
): Promise<WeekendBucket[]> => {
  const r = await db.execute({
    sql: `SELECT weekend_start, weekend_end, shows_json FROM rm_home_weekend_shows
          WHERE season = ? ORDER BY weekend_start`,
    args: [season],
  });
  return (r.rows as any[]).map((row) => ({
    weekendStart: row.weekend_start,
    weekendEnd: row.weekend_end,
    shows: JSON.parse(row.shows_json) as WeekendShow[],
  }));
};

// rm_home_latest_results → LatestResults | null (verbatim JSON; identical to
// buildLatestResults by construction).
export const readLatestResults = async (
  db: Client,
): Promise<LatestResults | null> => {
  const r = await db.execute(
    `SELECT results_json FROM rm_home_latest_results WHERE id = 1 LIMIT 1`,
  );
  const row = r.rows[0] as { results_json?: string } | undefined;
  return row?.results_json
    ? (JSON.parse(row.results_json) as LatestResults)
    : null;
};

// Featured prediction — mirror of buildFeaturedPrediction over the frozen
// rm_event_prediction (summary) + rm_events (dates). Selection (pickFeaturedEvent)
// is shared with the builder so the two return the same row for a given `now`.
export const readFeaturedPrediction = async (
  db: Client,
  now: Date = new Date(),
  limit = 6,
): Promise<FeaturedPrediction | null> => {
  const r = await db.execute({
    sql: `
      SELECT p.event_slug AS slug, e.start_date AS start_date,
             COALESCE(NULLIF(e.event_name, ''), e.name) AS event_name,
             p.predicted_at AS predicted_at, p.summary_json AS summary_json
      FROM rm_event_prediction p
      JOIN rm_events e ON e.slug = p.event_slug
      WHERE p.season = '2026' AND e.start_date IS NOT NULL
    `,
  });
  const rows = r.rows as unknown as Array<{
    slug: string;
    start_date: string;
    event_name: string;
    predicted_at: string | null;
    summary_json: string;
  }>;
  const picked = pickFeaturedEvent(rows, now);
  if (!picked) return null;

  const summary = JSON.parse(picked.summary_json) as { recap?: unknown[] };
  const recap = (summary.recap ?? []) as Array<Record<string, any>>;
  return {
    slug: picked.slug,
    eventName: picked.event_name,
    startDate: picked.start_date,
    predictedAt: picked.predicted_at,
    placements: recap.slice(0, limit).map((p) => ({
      rank: p.rank ?? null,
      corps: p.corps ?? p.corps_key ?? "",
      corpsKey: p.corps_key ?? null,
      division: p.division ?? null,
      total: typeof p.total === "number" ? p.total : null,
    })),
  };
};

// All events that have a stored prediction — for the Prediction Palette event
// picker. Ordered by show date ascending (earliest first; undated last).
export interface PredictedEventOption {
  slug: string;
  eventName: string;
  startDate: string | null;
  season: string;
}
export const listPredictedEvents = async (db: Client): Promise<PredictedEventOption[]> => {
  const r = await db.execute({
    sql: `
      SELECT p.event_slug AS slug,
             COALESCE(NULLIF(e.event_name, ''), e.name, p.event_slug) AS event_name,
             e.start_date AS start_date,
             p.season AS season
      FROM rm_event_prediction p
      JOIN rm_events e ON e.slug = p.event_slug
      ORDER BY (e.start_date IS NULL), e.start_date ASC, event_name ASC
    `,
  });
  return (r.rows as unknown as Array<Record<string, any>>).map((row) => ({
    slug: String(row.slug),
    eventName: String(row.event_name ?? row.slug),
    startDate: row.start_date ?? null,
    season: String(row.season ?? ""),
  }));
};

// All show titles across seasons (rm_show_titles) — for the /shows program
// directory. Newest season first; the route joins corpsKey → slug/name.
export const listAllShowTitles = async (
  db: Client
): Promise<{ season: string; corpsKey: string; title: string }[]> => {
  const r = await db.execute({
    sql: 'SELECT season, corps_key, title FROM rm_show_titles ORDER BY season DESC, title ASC',
  });
  return (r.rows as unknown as Array<Record<string, any>>).map((row) => ({
    season: String(row.season),
    corpsKey: String(row.corps_key),
    title: String(row.title),
  }));
};

// rm_home_standings → SeasonStandings | null (verbatim JSON).
export const readSeasonStandings = async (
  db: Client,
): Promise<SeasonStandings | null> => {
  const r = await db.execute(
    `SELECT standings_json FROM rm_home_standings WHERE id = 1 LIMIT 1`,
  );
  const row = r.rows[0] as { standings_json?: string } | undefined;
  return row?.standings_json
    ? (JSON.parse(row.standings_json) as SeasonStandings)
    : null;
};

export const readEventSeasonOptions = async (
  db: Client,
  slug: string,
): Promise<EventSeasonOption[]> => {
  const r = await db.execute({
    sql: `SELECT season, slug, competition_slug, name, event_name, start_date,
                 location_city, location_state
          FROM rm_event_season_options WHERE source_slug = ? ORDER BY sort_index`,
    args: [slug],
  });
  return r.rows as unknown as EventSeasonOption[];
};

export const readCompetitionSlugForSeasonEvent = async (
  db: Client,
  season: string,
  slug: string,
): Promise<string> => {
  const r = await db.execute({
    sql: `SELECT competition_slug FROM rm_event_competition_resolution WHERE season = ? AND slug = ?`,
    args: [season, slug],
  });
  const c = r.rows[0]?.competition_slug;
  // Mirror the builder's fallback when no resolution row exists.
  return typeof c === "string" ? c : `${season}-${slug.replace(/^\d{4}-/, "")}`;
};

// ── Corps ─────────────────────────────────────────────────────────────────
export const readCorpsDirectory = async (
  db: Client,
): Promise<CorpsSummary[]> => {
  const r = await db.execute("SELECT * FROM rm_corps ORDER BY sort_index");
  return (r.rows as any[]).map((row) => ({
    corps_key: row.corps_key,
    slug: row.slug,
    name: row.name,
    division_name: row.division_name,
    display_city: row.display_city,
    corps_logo: row.corps_logo,
    corps_logo_dark: Number(row.corps_logo_dark ?? 0),
    corps_logo_dark_url: row.corps_logo_dark_url ?? null,
    color_primary: row.color_primary ?? null,
    color_secondary: row.color_secondary ?? null,
    color_source: row.color_source ?? null,
    corps_photo: row.corps_photo ?? null,
    active: Number(row.active),
    performing: Number(row.performing),
    is_alumni: Number(row.is_alumni),
    aliases: JSON.parse(row.aliases_json),
  }));
};

// Read the directory rows for specific corps_keys from the read-model (rm_corps).
// Read-model fast path for buildCorpsByKeys — covers every corps in the directory
// (the prediction/schedule corps). Corps not materialized in rm_corps (rare,
// outside the directory) simply won't be returned, same as a missing row.
export const readCorpsByKeys = async (
  db: Client,
  corpsKeys: readonly string[],
): Promise<CorpsSummary[]> => {
  if (corpsKeys.length === 0) return [];
  const placeholders = corpsKeys.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT * FROM rm_corps WHERE corps_key IN (${placeholders})`,
    args: [...corpsKeys],
  });
  return (r.rows as any[]).map((row) => ({
    corps_key: row.corps_key,
    slug: row.slug,
    name: row.name,
    division_name: row.division_name,
    display_city: row.display_city,
    corps_logo: row.corps_logo,
    corps_logo_dark: Number(row.corps_logo_dark ?? 0),
    corps_logo_dark_url: row.corps_logo_dark_url ?? null,
    color_primary: row.color_primary ?? null,
    color_secondary: row.color_secondary ?? null,
    color_source: row.color_source ?? null,
    corps_photo: row.corps_photo ?? null,
    active: Number(row.active),
    performing: Number(row.performing),
    is_alumni: Number(row.is_alumni),
    aliases: JSON.parse(row.aliases_json),
  }));
};

export const readCorpsBySlug = async (
  db: Client,
  slug: string,
): Promise<CorpsDetail | null> => {
  const r = await db.execute({
    sql: `SELECT detail_json FROM rm_corps_detail WHERE slug = ? LIMIT 1`,
    args: [slug],
  });
  const j = r.rows[0]?.detail_json;
  return typeof j === "string" ? (JSON.parse(j) as CorpsDetail) : null;
};

export const readCorpsSeasonScores = async (
  db: Client,
  slug: string,
): Promise<CorpsSeasonPoint[]> => {
  const r = await db.execute({
    sql: `SELECT date, label, slug, predicted, actual, low, high
          FROM rm_corps_season_points WHERE corps_slug = ? ORDER BY sort_index`,
    args: [slug.trim().toLowerCase()],
  });
  return (r.rows as any[]).map((row) => ({
    date: row.date,
    label: row.label,
    slug: row.slug,
    predicted: row.predicted === null ? null : Number(row.predicted),
    actual: row.actual === null ? null : Number(row.actual),
    low: row.low === null ? null : Number(row.low),
    high: row.high === null ? null : Number(row.high),
  }));
};

/** The "prediction as of ___" history matrix (parity with buildCorpsSeasonSnapshots). */
export const readCorpsSeasonSnapshots = async (
  db: Client,
  slug: string,
): Promise<CorpsSeasonSnapshotRow[]> => {
  const r = await db.execute({
    sql: `SELECT snapshot_at, date, label, slug, pct, predicted, actual, low, high
          FROM rm_corps_prediction_snapshots WHERE corps_slug = ?
          ORDER BY snapshot_at, sort_index`,
    args: [slug.trim().toLowerCase()],
  });
  return (r.rows as any[]).map((row) => ({
    snapshot_at: row.snapshot_at,
    date: row.date,
    label: row.label,
    slug: row.slug,
    pct: Number(row.pct),
    predicted: row.predicted === null ? null : Number(row.predicted),
    actual: row.actual === null ? null : Number(row.actual),
    low: row.low === null ? null : Number(row.low),
    high: row.high === null ? null : Number(row.high),
  }));
};

/** The /vs as-of prediction read path: distinct snapshot dates for a corps,
 *  from the same matrix (read-model — so it works in prod, where the relational
 *  builder path doesn't). */
export const readVs2026SnapshotDates = async (db: Client, slug: string): Promise<string[]> => {
  const r = await db.execute({
    sql: `SELECT DISTINCT snapshot_at FROM rm_corps_prediction_snapshots
          WHERE corps_slug = ? AND season = '2026' ORDER BY snapshot_at DESC`,
    args: [slug.trim().toLowerCase()],
  });
  return (r.rows as any[]).map((row) => String(row.snapshot_at)).filter(Boolean);
};

/** A corps's predicted-to-finals curve AS OF a snapshot date (x = %-through),
 *  reconstructed from the corps snapshot matrix. Mirrors buildVsPredictionSnapshot's
 *  shape so the /vs loader can swap builder → reader with no behavior change. */
export const readVsCorps2026PredictedAsOf = async (
  db: Client,
  slug: string,
  asOf: string,
): Promise<Array<{ pct: number; predicted: number; date: string; eventLabel: string }>> => {
  const r = await db.execute({
    sql: `SELECT pct, predicted, date, label FROM rm_corps_prediction_snapshots
          WHERE corps_slug = ? AND season = '2026' AND snapshot_at = ? AND predicted IS NOT NULL
          ORDER BY pct ASC`,
    args: [slug.trim().toLowerCase(), asOf],
  });
  return (r.rows as any[]).map((row) => ({
    pct: Number(row.pct),
    predicted: Number(row.predicted),
    date: row.date ?? '',
    eventLabel: row.label ?? '',
  }));
};

// ── VS comparison chart ────────────────────────────────────────────────────
// Shared caption columns (match the builders' VsCaptionValues / emit schema).
const VS_CAPTION_COLS = 'total, ge, visual, music, ge1, ge2, vp, va, cg, mb, ma, mp';
const vsNum = (v: any): number | null => (v == null ? null : Number(v));
const vsCaptionsFromRow = (row: any) => ({
  total: Number(row.total),
  ge: vsNum(row.ge),
  visual: vsNum(row.visual),
  music: vsNum(row.music),
  ge1: vsNum(row.ge1),
  ge2: vsNum(row.ge2),
  vp: vsNum(row.vp),
  va: vsNum(row.va),
  cg: vsNum(row.cg),
  mb: vsNum(row.mb),
  ma: vsNum(row.ma),
  mp: vsNum(row.mp),
});

export const readVsCorpsScores = async (
  db: Client,
  slug: string,
  season: string,
): Promise<VsCorpsScorePoint[]> => {
  const r = await db.execute({
    sql: `SELECT pct, date, event_label, ${VS_CAPTION_COLS}
          FROM rm_vs_corps_scores WHERE corps_slug = ? AND season = ? ORDER BY pct`,
    args: [slug.trim().toLowerCase(), season],
  });
  return (r.rows as any[]).map((row) => ({
    pct: Number(row.pct),
    date: row.date ?? '',
    eventLabel: row.event_label ?? '',
    ...vsCaptionsFromRow(row),
  }));
};

export const readVsCorpsSeasons = async (db: Client, slug: string): Promise<string[]> => {
  const r = await db.execute({
    sql: `SELECT DISTINCT season FROM rm_vs_corps_scores WHERE corps_slug = ? ORDER BY season DESC`,
    args: [slug.trim().toLowerCase()],
  });
  return (r.rows as any[]).map((row) => String(row.season)).filter(Boolean);
};

/** Every (corps_slug, season) pair that has VS-plottable data — drives the VS
 *  builder's "greyed out when the corps didn't compete that season" affordance. */
export const readVsCorpsSeasonAvailability = async (
  db: Client,
): Promise<Array<{ corps_slug: string; season: string }>> => {
  const r = await db.execute({
    sql: `SELECT DISTINCT corps_slug, season FROM rm_vs_corps_scores`,
  });
  return (r.rows as any[]).map((x) => ({
    corps_slug: String(x.corps_slug),
    season: String(x.season),
  }));
};

export const readVsCorps2026Predicted = async (
  db: Client,
  slug: string,
): Promise<VsPredictedPoint[]> => {
  const r = await db.execute({
    sql: `SELECT pct, ${VS_CAPTION_COLS} FROM rm_vs_corps_predicted WHERE corps_slug = ? ORDER BY pct`,
    args: [slug.trim().toLowerCase()],
  });
  return (r.rows as any[]).map((row) => ({ pct: Number(row.pct), ...vsCaptionsFromRow(row) }));
};

export const readVsBaselines = async (db: Client): Promise<VsBaselinePoint[]> => {
  const r = await db.execute({
    sql: `SELECT rank, bucket, ${VS_CAPTION_COLS} FROM rm_vs_baselines ORDER BY rank, bucket`,
  });
  return (r.rows as any[]).map((row) => ({
    rank: Number(row.rank),
    bucket: Number(row.bucket),
    ...vsCaptionsFromRow(row),
  }));
};

/** The corps with a 2026 predicted curve = the active 2026 field (roster). Lets
 *  the VS corps lists restrict to who's actually competing in 2026. */
export const readVsActiveCorps = async (db: Client): Promise<string[]> => {
  const r = await db.execute({ sql: `SELECT DISTINCT corps_slug FROM rm_vs_corps_predicted` });
  return (r.rows as any[]).map((x) => String(x.corps_slug)).filter(Boolean);
};

// ── Rankings (/rankings page) ──────────────────────────────────────────────
export const readRankings = async (db: Client, season: string): Promise<RankingScoreRow[]> => {
  const r = await db.execute({
    sql: `SELECT season, competition_slug, date, corps_slug, corps_name, division, metric, score
          FROM rm_rankings WHERE season = ? ORDER BY date`,
    args: [season],
  });
  return (r.rows as any[]).map((row) => ({
    season: String(row.season),
    competitionSlug: String(row.competition_slug),
    date: String(row.date),
    corpsSlug: String(row.corps_slug),
    corpsName: String(row.corps_name),
    division: row.division ?? '',
    metric: String(row.metric) as RankMetric,
    score: Number(row.score),
  }));
};

export const readRankingSeasons = async (db: Client): Promise<string[]> => {
  const r = await db.execute({ sql: `SELECT DISTINCT season FROM rm_rankings ORDER BY season DESC` });
  return (r.rows as any[]).map((x) => String(x.season)).filter(Boolean);
};

// ── Recaps ───────────────────────────────────────────────────────────────
export const readEventRecap = async (
  db: Client,
  slug: string,
): Promise<EventRecap> => {
  // Resolve the event/URL slug → competition_slug the way the builder does: the
  // recap is keyed by competition_slug, which often differs from the event slug
  // (e.g. event "dci-tupelo" → competition "2022-dci-tupelo"). rm_events carries
  // the resolved competition_slug per event slug.
  const res = await db.execute({
    sql: `SELECT competition_slug FROM rm_events
          WHERE slug = ? AND competition_slug IS NOT NULL LIMIT 1`,
    args: [slug],
  });
  const comp = (res.rows[0]?.competition_slug as string | undefined) ?? slug;
  const r = await db.execute({
    sql: `SELECT meta_json, scores_json FROM rm_event_recap
          WHERE competition_slug = ? OR competition_slug = ? OR event_slug = ? LIMIT 1`,
    args: [comp, slug, slug],
  });
  const row = r.rows[0] as any;
  if (!row) return { meta: null, scores: [] };
  return {
    meta: JSON.parse(row.meta_json),
    scores: JSON.parse(row.scores_json),
  };
};

export const readEventFullRecap = async (
  db: Client,
  slug: string,
): Promise<FullEventRecap> => {
  const res = await db.execute({
    sql: `SELECT competition_slug FROM rm_events
          WHERE slug = ? AND competition_slug IS NOT NULL LIMIT 1`,
    args: [slug],
  });
  const comp = (res.rows[0]?.competition_slug as string | undefined) ?? slug;
  const r = await db.execute({
    sql: `SELECT full_json FROM rm_event_full_recap
          WHERE competition_slug = ? OR competition_slug = ? OR event_slug = ? LIMIT 1`,
    args: [comp, slug, slug],
  });
  const row = r.rows[0] as any;
  if (!row) return { meta: null, corps: [] };
  return JSON.parse(row.full_json) as FullEventRecap;
};

// Per-corps "previous show" recap for the Diff "vs Previous" basis. Keyed like
// the recap tables (competition_slug PK + event_slug), resolved from the app's
// event slug via rm_events. Absent → empty (season opener / no prior shows).
export const readEventPreviousRecap = async (
  db: Client,
  slug: string,
): Promise<EventPreviousRecap> => {
  const res = await db.execute({
    sql: `SELECT competition_slug FROM rm_events
          WHERE slug = ? AND competition_slug IS NOT NULL LIMIT 1`,
    args: [slug],
  });
  const comp = (res.rows[0]?.competition_slug as string | undefined) ?? slug;
  const r = await db.execute({
    sql: `SELECT rows_json, sources_json FROM rm_event_previous_recap
          WHERE competition_slug = ? OR competition_slug = ? OR event_slug = ? LIMIT 1`,
    args: [comp, slug, slug],
  });
  const row = r.rows[0] as any;
  if (!row) return { rows: [], sources: {} };
  return {
    rows: JSON.parse(row.rows_json),
    sources: JSON.parse(row.sources_json),
  };
};

// Composite payload for the PAST-SEASON prediction/recap page. Mirrors the
// past-season branch of getHybridEventPredictionPageData (app/lib/server-fns/
// hybrid.ts) exactly, composing the same readers the services delegate to — so a
// static shard built from this can't drift from the live loader. The 2026 branch
// is intentionally NOT covered here: its `prediction` is live-regenerable (reads
// the big DB, never the read-model) and must stay dynamic.
export interface PredictionPageData {
  prediction: null;
  event: EventDirectoryRow | null;
  schedule: EventScheduleRow[];
  corps: CorpsSummary[];
  recap: { meta: EventRecap["meta"]; scores: EventRecap["scores"] } | null;
  seasonOptions: EventSeasonOption[];
  showTitles: Record<string, string>;
  showInfo: Record<string, ShowInfoSummary>;
}

const uniqueStrings = (values: readonly unknown[]): string[] =>
  Array.from(
    new Set(
      values.filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  );

export const readPredictionPageData = async (
  db: Client,
  yearSlug: string,
  slug: string,
): Promise<PredictionPageData> => {
  const competitionSlug = await readCompetitionSlugForSeasonEvent(
    db,
    yearSlug,
    slug,
  );
  const [event, fallbackSchedule, seasonOptions] = await Promise.all([
    readEventBasic(db, slug),
    readEventSchedule(db, slug),
    readEventSeasonOptions(db, slug),
  ]);
  const [recap, primarySchedule, fullRecap] = await Promise.all([
    readEventRecap(db, competitionSlug),
    readEventSchedule(db, competitionSlug),
    // The page also renders the full (judge-level) recap, which can cover more
    // corps than the compact recap — e.g. a two-night event whose full recap
    // merges both nights. Union its corps so every rendered row has a directory
    // row for its logo/link/class chip (otherwise it degrades to a monogram).
    readEventFullRecap(db, slug),
  ]);
  const schedule =
    primarySchedule.length > 0 ? primarySchedule : fallbackSchedule;
  const corpsKeys = uniqueStrings([
    ...recap.scores.map((row: any) => row.corps_key),
    ...schedule.map((row) => row.corps_key),
    ...fullRecap.corps.map((c) => c.corpsKey),
  ]);
  const corps = await readCorpsByKeys(db, corpsKeys);
  const showInfo = await readShowInfoForSeason(db, yearSlug);
  return {
    prediction: null,
    event,
    schedule,
    corps,
    recap: { meta: recap.meta, scores: recap.scores },
    seasonOptions,
    showTitles: Object.fromEntries(
      Object.entries(showInfo).map(([corpsKey, info]) => [
        corpsKey,
        info.title,
      ]),
    ),
    showInfo,
  };
};

// ── Judges ─────────────────────────────────────────────────────────────────
// Placeholder/unresolved-attribution rows that are not real people; excluded
// from the directory (also filtered in buildJudgeDirectory for the dev path).
const EXCLUDED_JUDGE_IDS = new Set(["unknown-unknown-1", "j-missing-1", "ovr-unknown-1"]);

export const readJudgeDirectory = async (
  db: Client,
): Promise<JudgeSummary[]> => {
  const r = await db.execute("SELECT summary_json FROM rm_judges");
  return (r.rows as any[])
    .map((row) => JSON.parse(row.summary_json) as JudgeSummary)
    .filter((j) => !EXCLUDED_JUDGE_IDS.has(j.judge_id));
};

export const readJudgeProfile = async (
  db: Client,
  judgeId: string,
): Promise<JudgeProfile | null> => {
  const r = await db.execute({
    sql: `SELECT detail_json FROM rm_judge_detail WHERE judge_id = ? LIMIT 1`,
    args: [judgeId],
  });
  const j = r.rows[0]?.detail_json;
  return typeof j === "string" ? (JSON.parse(j) as JudgeProfile) : null;
};

// ── Staff ──────────────────────────────────────────────────────────────────
export const readStaffDirectory = async (db: Client): Promise<StaffSummary[]> => {
  const r = await db.execute("SELECT summary_json FROM rm_staff");
  return (r.rows as any[]).map((row) => {
    const s = JSON.parse(row.summary_json) as StaffSummary & {
      // Pre-v14 rows carried full groups[] instead of corps_names[]; normalize so
      // the slimmed directory code works against a not-yet-re-emitted read-model.
      groups?: ReadonlyArray<{ corps_name: string }>;
    };
    if (!s.corps_names && s.groups) {
      s.corps_names = [...new Set(s.groups.map((g) => g.corps_name))];
    }
    delete s.groups;
    return s as StaffSummary;
  });
};

export const readStaffProfile = async (
  db: Client,
  personId: string,
): Promise<StaffProfile | null> => {
  const r = await db.execute({
    sql: `SELECT detail_json FROM rm_staff_detail WHERE person_id = ? LIMIT 1`,
    args: [personId],
  });
  const s = r.rows[0]?.detail_json;
  return typeof s === "string" ? (JSON.parse(s) as StaffProfile) : null;
};

// ── Show titles ──────────────────────────────────────────────────────────
export const readShowTitlesForSeason = async (
  db: Client,
  season: string,
): Promise<Record<string, string>> => {
  let rows: { corps_key: string; title: string }[];
  try {
    const r = await db.execute({
      sql: "SELECT corps_key, title FROM rm_show_titles WHERE season = ?",
      args: [season],
    });
    rows = r.rows as unknown as { corps_key: string; title: string }[];
  } catch {
    // A read-model emitted before rm_show_titles existed (schema < v2). Titles
    // are optional UI; degrade to none rather than 500 until the next emit.
    return {};
  }
  const titles: Record<string, string> = {};
  for (const row of rows) {
    if (row.corps_key && row.title) titles[row.corps_key] = row.title;
  }
  return titles;
};

export const readShowInfoForSeason = async (
  db: Client,
  season: string,
): Promise<Record<string, ShowInfoSummary>> => {
  let rows: { corps_key: string; info_json: string }[];
  try {
    const r = await db.execute({
      sql: "SELECT corps_key, info_json FROM rm_show_info WHERE season = ?",
      args: [season],
    });
    rows = r.rows as unknown as { corps_key: string; info_json: string }[];
  } catch {
    const titles = await readShowTitlesForSeason(db, season);
    return Object.fromEntries(
      Object.entries(titles).map(([corpsKey, title]) => [
        corpsKey,
        {
          title,
          subtitle: null,
          description: null,
          sourceUrl: null,
          repertoire: [],
        },
      ]),
    );
  }

  const info: Record<string, ShowInfoSummary> = {};
  for (const row of rows) {
    if (!row.corps_key || !row.info_json) continue;
    try {
      info[row.corps_key] = JSON.parse(row.info_json) as ShowInfoSummary;
    } catch {
      // Optional show context should never break a scores page.
    }
  }
  return info;
};

// Every (corps_key, season) pair the read-model has a show for — the sitemap maps
// corps_key → slug and emits /shows/<slug>/<season>. rm_show_info is the complete
// set (one row per show); rm_show_detail is a superset of *enriched* shows only.
// Degrades to [] if the table predates this emit, matching the other readers.
export const readAllShows = async (
  db: Client,
): Promise<{ corpsKey: string; season: string }[]> => {
  try {
    const r = await db.execute(
      "SELECT DISTINCT corps_key, season FROM rm_show_info WHERE corps_key IS NOT NULL AND season IS NOT NULL",
    );
    return (r.rows as any[]).map((row) => ({
      corpsKey: String(row.corps_key),
      season: String(row.season),
    }));
  } catch {
    return [];
  }
};

// Full show detail for one show, by its stable (corps_key, season) key. Reads the
// emitted rm_show_detail shard; degrades gracefully when the table predates this
// emit (schema < v9) by upgrading the lightweight rm_show_info summary into a
// ShowDetail with empty related collections, so the page still renders.
export const readShowDetail = async (
  db: Client,
  corpsKey: string,
  season: string,
): Promise<ShowDetail | null> => {
  try {
    const r = await db.execute({
      sql: "SELECT detail_json FROM rm_show_detail WHERE season = ? AND corps_key = ? LIMIT 1",
      args: [season, corpsKey],
    });
    const s = r.rows[0]?.detail_json;
    if (typeof s !== "string") return null;
    return JSON.parse(s) as ShowDetail;
  } catch {
    const info = (await readShowInfoForSeason(db, season))[corpsKey];
    if (!info) return null;
    return {
      showId: "",
      corpsKey,
      corpsName: null,
      season,
      title: info.title,
      subtitle: info.subtitle,
      description: info.description,
      premiereDate: null,
      venue: null,
      tagline: null,
      designerNotes: null,
      sourceUrl: info.sourceUrl,
      tags: [],
      repertoire: info.repertoire.map((p) => ({
        workTitle: p.workTitle,
        composer: p.composer,
        arranger: p.arranger,
        description: null,
        hyperlink: null,
        relatedCorpsKey: null,
        notes: null,
      })),
      designers: [],
      movements: [],
      media: [],
      reviews: [],
    };
  }
};

// ── Predictions ──────────────────────────────────────────────────────────
export const readLatestPredictionSummary = async (
  db: Client,
  eventSlug: string,
): Promise<LatestPredictionRow | null> => {
  const r = await db.execute({
    sql: `SELECT event_slug, season, predicted_at, summary_json
          FROM rm_event_prediction WHERE event_slug = ? LIMIT 1`,
    args: [eventSlug],
  });
  const row = r.rows[0] as any;
  if (!row) return null;
  return {
    event_slug: row.event_slug,
    season: row.season,
    predicted_at: row.predicted_at,
    summary: JSON.parse(row.summary_json),
  };
};

// Forecast-as-of: prediction history for an event (rm_event_prediction_snapshots).
// Distinct snapshot days, and the recap as of one day. Keyed by event_slug (like
// rm_event_prediction). Callers wrap in `.catch(() => …)` so a read-model without
// the table (pre-emit) degrades to no scrubber.
export const readEventPredictionSnapshotDates = async (
  db: Client,
  eventSlug: string,
): Promise<string[]> => {
  const r = await db.execute({
    sql: `SELECT snapshot_at, recap_json FROM rm_event_prediction_snapshots
          WHERE event_slug = ? ORDER BY snapshot_at ASC`,
    args: [eventSlug],
  });
  // Consecutive days with an IDENTICAL forecast collapse to the run's first day —
  // nightly regens often change nothing, and duplicate pills in the as-of scrubber
  // are dead weight. recap_json is the emit's JSON.stringify of the same builder
  // output, so string equality mirrors buildEventPredictionSnapshotDates exactly
  // (parity-checked by verifyReadModel).
  const kept: string[] = [];
  let prevRecap: string | null = null;
  for (const row of r.rows as unknown as { snapshot_at: string | null; recap_json: string | null }[]) {
    if (!row.snapshot_at) continue;
    const recap = row.recap_json ?? '';
    if (recap !== prevRecap) kept.push(row.snapshot_at);
    prevRecap = recap;
  }
  return kept.reverse(); // newest first (existing contract)
};

export const readEventPredictionAsOf = async (
  db: Client,
  eventSlug: string,
  date: string,
): Promise<EventPredictionAsOf | null> => {
  const r = await db.execute({
    sql: `SELECT recap_json, predicted_at, percent_through
          FROM rm_event_prediction_snapshots
          WHERE event_slug = ? AND snapshot_at = ? LIMIT 1`,
    args: [eventSlug, date],
  });
  const row = r.rows[0] as any;
  if (!row) return null;
  return {
    recap: JSON.parse(row.recap_json),
    predicted_at: row.predicted_at ?? null,
    percent_through: typeof row.percent_through === 'number' ? row.percent_through : null,
  };
};

// Merch read-model (rm_merch_*). Returns the same aggregate shape the builders
// produce so MerchDirectoryService can swap builder → reader with no behavior
// change. Tolerant of a pre-v10 read-model (tables absent) → empty merch, so a
// container reading rm_merch before the Turso DB has been re-emitted degrades to
// an empty catalog rather than throwing.
export interface MerchSnapshot {
  index: MerchProductSummary[];
  facets: MerchFacets;
  stores: MerchStoreSummary[];
  details: Map<string, MerchProductDetail>;
  teasers: Map<string, CorpsMerchTeaser>;
}

const EMPTY_FACETS: MerchFacets = {
  platforms: [],
  stores: [],
  priceBuckets: [],
  categories: [],
  total: 0,
};

const safeRows = async (db: Client, sql: string): Promise<any[]> => {
  try {
    return (await db.execute(sql)).rows as any[];
  } catch {
    return []; // table missing (pre-v10 read-model)
  }
};

export const readMerchSnapshot = async (db: Client): Promise<MerchSnapshot> => {
  const metaRow = (
    await safeRows(
      db,
      "SELECT index_json, facets_json, stores_json FROM rm_merch_meta WHERE id = 1 LIMIT 1",
    )
  )[0];
  const index: MerchProductSummary[] = metaRow
    ? JSON.parse(metaRow.index_json)
    : [];
  const facets: MerchFacets = metaRow
    ? JSON.parse(metaRow.facets_json)
    : EMPTY_FACETS;
  const stores: MerchStoreSummary[] = metaRow
    ? JSON.parse(metaRow.stores_json)
    : [];

  const details = new Map<string, MerchProductDetail>();
  for (const r of await safeRows(
    db,
    "SELECT product_id, detail_json FROM rm_merch_product",
  )) {
    details.set(String(r.product_id), JSON.parse(r.detail_json));
  }
  const teasers = new Map<string, CorpsMerchTeaser>();
  for (const r of await safeRows(
    db,
    "SELECT slug, teaser_json FROM rm_merch_corps_teaser",
  )) {
    teasers.set(String(r.slug), JSON.parse(r.teaser_json));
  }
  return { index, facets, stores, details, teasers };
};
