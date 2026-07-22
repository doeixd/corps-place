// Read-model builder for the prediction *read* shape (READ_MODEL_PLAN §6, §4).
//
// The on-demand generation path (freshness check + spawned child process) stays
// in app/lib/event-prediction-api.ts untouched. This builder only snapshots the
// latest saved run's `summary_json` — the fast "cache-only" read shape — so the
// emitter can freeze it into rm_event_prediction. No hydration, no freshness
// recompute: the emitter persists exactly what summarizePayload produces.

import type { Client } from '@libsql/client';

export interface PredictionSummary {
  source: 'cache';
  prediction_id: string;
  generated_at: unknown;
  model_dir: unknown;
  event: unknown;
  competition: unknown;
  readiness: unknown;
  input_audit: unknown;
  model_metadata: unknown;
  builder_version: unknown;
  caveats: unknown[];
  recap: unknown[];
}

export interface LatestPredictionRow {
  event_slug: string;
  season: string;
  predicted_at: string | null;
  summary: PredictionSummary;
}

// Mirror of summarizePayload() in event-prediction-api.ts (kept in sync — this is
// the frozen read shape). `source` is always 'cache' for a read-model snapshot.
const summarizePayload = (payload: any, prediction_id: string): PredictionSummary => ({
  source: 'cache',
  prediction_id,
  generated_at: payload?.generated_at,
  model_dir: payload?.model_dir,
  event: payload?.event,
  competition: payload?.competition,
  readiness: payload?.readiness,
  input_audit: payload?.input_audit,
  model_metadata: payload?.model_metadata,
  builder_version: payload?.builder_version,
  caveats: payload?.caveats ?? [],
  recap: payload?.predictions ?? [],
});

// Canonical corps identity (alias name + canonical name → corps_key/slug), so a
// prediction generated off an aliased lineup unit (e.g. "Hurricanes" → key
// "hurricanes") gets remapped to the real corps ("Connecticut Hurricanes" → key
// "0015b00002eebx5aaf"). Without this the diff view's outer-join on corps_key
// can't merge the predicted row with the scored row → the corps shows twice (one
// without a logo). Loaded once per process.
let corpsCanonCache: Map<string, { name: string; corps_key: string | null }> | null = null;
const loadCorpsCanon = async (db: Client) => {
  if (corpsCanonCache) return corpsCanonCache;
  const map = new Map<string, { name: string; corps_key: string | null }>();
  // Resolve corps_key from corps_scores (corps_name → corps_key); the `corps`
  // table is intentionally NOT used here (libsql rejects its `name` column in this
  // emit context). Two layers: alias_name → canonical, and canonical name → key.
  const res = await db.execute(`
    SELECT a.alias_name AS lookup, a.canonical_name AS name,
           (SELECT cs.corps_key FROM corps_scores cs
            WHERE cs.corps_name = a.canonical_name AND cs.corps_key IS NOT NULL LIMIT 1) AS corps_key
    FROM corps_aliases a
    UNION ALL
    SELECT corps_name AS lookup, corps_name AS name, corps_key
    FROM (SELECT corps_name, corps_key FROM corps_scores
          WHERE corps_name IS NOT NULL AND corps_key IS NOT NULL GROUP BY corps_name)
  `);
  for (const r of res.rows as any[]) {
    const lookup = typeof r.lookup === 'string' ? r.lookup.trim().toLowerCase() : '';
    if (lookup && !map.has(lookup))
      map.set(lookup, { name: String(r.name), corps_key: r.corps_key ?? null });
  }
  corpsCanonCache = map;
  return map;
};

const canonicalizePredictions = (payload: any, canon: Map<string, { name: string; corps_key: string | null }>) => {
  if (!Array.isArray(payload?.predictions)) return;
  payload.predictions = payload.predictions.map((p: any) => {
    const hit = typeof p?.corps === 'string' ? canon.get(p.corps.trim().toLowerCase()) : undefined;
    if (!hit) return p;
    return { ...p, corps: hit.name, corps_key: hit.corps_key ?? p.corps_key };
  });
};

// The latest saved prediction summary for one event (unhydrated). Returns null
// when no saved run exists.
// Feature flag: which model's predictions the site serves. Default 'final2' (the
// current production model). Set PREDICTION_MODEL=v10 to flip to the clean-v10
// ensemble; 'any' restores the legacy newest-run-wins behaviour. Selection is by
// model_dir, so both models can write runs freely (shadow/A-B) and only the flagged
// one is served — flip/rollback is just this env var + a read-model republish, fully
// reversible with no data change. Falls back to newest-any if the flagged model has
// no run for an event (never blank).
export const PREDICTION_MODEL = (process.env.PREDICTION_MODEL ?? 'final2').toLowerCase();

// The bare SQL predicate (referencing an unqualified `model_dir` column) that
// matches the flagged model's runs, or '' for 'any' (legacy newest-wins). This is
// the single source of truth every prediction-consuming builder derives its
// model filter from — see modelDirFilter / flaggedModelScore below.
const MODEL_DIR_PREDICATE =
  PREDICTION_MODEL === 'v11'
    ? "model_dir LIKE '%v11-fp-shadow%'" // v11 = identity-dropout-0.5 field-pace ensemble + division recal (tag clean-v11-fp-shadow)
    : PREDICTION_MODEL === 'v10.5'
    ? "model_dir LIKE '%fieldpace-recal%'" // v10.5 = field-pace ensemble + division recal
    : PREDICTION_MODEL === 'v10'
      ? "(model_dir LIKE '%clean-v10%' OR model_dir LIKE '%ensemble%')"
      : PREDICTION_MODEL === 'final2'
        ? "model_dir LIKE '%final2%'"
        : ''; // 'any' → legacy newest-wins

/** `AND <flagged-model predicate>` (or '' for 'any'), appended to a WHERE clause
 *  that already filters season/event. Used where a single flagged-or-nothing row
 *  is picked with an explicit newest-any fallback (buildLatestPredictionSummary). */
export const modelDirFilter = MODEL_DIR_PREDICATE ? `AND ${MODEL_DIR_PREDICATE}` : '';

/**
 * A 0/1 SQL scoring expression for prefer-flagged ORDER BY: 1 when the row is the
 * flagged model, else 0 (always 0 for 'any'). Feeds
 * `ORDER BY <score> DESC, predicted_at DESC` so a per-event pick prefers the
 * flagged model's newest run but falls back to newest-any when the flagged model
 * has no run for that event — the never-blank semantics of buildLatestPredictionSummary
 * expressed inside a single latest-CTE. `col` names the model_dir column (aliased
 * as `run.model_dir` in the /vs and corps builders).
 */
export const flaggedModelScore = (col = 'model_dir'): string =>
  MODEL_DIR_PREDICATE
    ? `(CASE WHEN ${MODEL_DIR_PREDICATE.replaceAll('model_dir', col)} THEN 1 ELSE 0 END)`
    : '0';

export const buildLatestPredictionSummary = async (
  db: Client,
  eventSlug: string,
  season = '2026'
): Promise<LatestPredictionRow | null> => {
  const pick = async (filter: string) =>
    (
      await db.execute({
        sql: `SELECT * FROM model_event_prediction_runs
              WHERE season = ? AND event_slug = ? ${filter}
              ORDER BY predicted_at DESC LIMIT 1`,
        args: [season, eventSlug],
      })
    ).rows[0] as any;
  // Prefer the flagged model; fall back to newest-any so an event the flagged model
  // hasn't forecast yet still shows a prediction rather than nothing. A flagged run
  // with EMPTY predictions (e.g. an all-age/SoundSport event V10 can't score) is
  // treated as no-run so we fall through to final2 instead of blanking the prediction.
  const hasPredictions = (r: any) => {
    try {
      return (JSON.parse(String(r?.payload_json))?.predictions?.length ?? 0) > 0;
    } catch {
      return false;
    }
  };
  const flagged = modelDirFilter ? await pick(modelDirFilter) : null;
  const run = flagged && hasPredictions(flagged) ? flagged : await pick('');
  if (!run) return null;
  const payload = JSON.parse(String(run.payload_json));
  // Remap aliased corps identities to canonical so the diff view merges the
  // predicted + scored rows for the same corps.
  canonicalizePredictions(payload, await loadCorpsCanon(db));
  const predictionId =
    run.prediction_id ??
    `${payload?.event?.slug ?? 'unknown'}:${payload?.generated_at ?? 'unknown'}`;
  return {
    event_slug: eventSlug,
    season: String(run.season ?? season),
    predicted_at: run.predicted_at ?? null,
    summary: summarizePayload(payload, predictionId),
  };
};

// All event slugs in a season that have at least one saved prediction run — the
// emitter iterates these to snapshot summaries.
export const buildPredictedEventSlugs = async (
  db: Client,
  season = '2026'
): Promise<string[]> => {
  const result = await db.execute({
    sql: `
      SELECT DISTINCT event_slug
      FROM model_event_prediction_runs
      WHERE season = ?
      ORDER BY event_slug
    `,
    args: [season],
  });
  return (result.rows as unknown as { event_slug: string }[]).map((r) => r.event_slug);
};

// ── Forecast-as-of (prediction history) ──────────────────────────────────────
// The model re-forecasts an event periodically; each run stamps `predicted_at`.
// A "snapshot" is the recap as it stood on a given day, so scrubbing the date
// replays how the forecast converged. See FORECAST_AS_OF_PREDICTION_PAGE_PLAN.md.

/** One event's prediction recap as of a snapshot date, plus run context. */
export interface EventPredictionAsOf {
  /** The predictions array (same RecapRow shape as the latest recap), canonicalized.
   *  Heterogeneous model rows — typed `any[]` like the rest of the prediction path. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recap: any[];
  /** Timestamp of the resolved run (the latest on/before the requested day). */
  predicted_at: string | null;
  /** Season progress of that run (0–100), for labeling. */
  percent_through: number | null;
}

/**
 * Distinct snapshot days (YYYY-MM-DD) that have a saved prediction run for this
 * event, newest first. Consecutive days whose as-of recap is IDENTICAL collapse
 * to the run's first day (nightly regens often change nothing; duplicate pills in
 * the as-of scrubber are dead weight). Compared as JSON.stringify(recap) — the
 * exact string the emit stores in rm_event_prediction_snapshots.recap_json, so
 * the reader's dedupe over stored rows matches this list (verifyReadModel parity).
 * Empty when no run exists (e.g. non-2026 or not predicted).
 */
export const buildEventPredictionSnapshotDates = async (
  db: Client,
  eventSlug: string,
  season = '2026'
): Promise<string[]> => {
  const r = await db.execute({
    sql: `
      SELECT DISTINCT substr(predicted_at, 1, 10) AS d
      FROM model_event_prediction_runs
      WHERE season = ? AND event_slug = ? AND predicted_at IS NOT NULL
      ORDER BY d ASC
    `,
    args: [season, eventSlug],
  });
  const datesAsc = (r.rows as unknown as { d: string | null }[])
    .map((x) => x.d)
    .filter((d): d is string => !!d);
  const kept: string[] = [];
  let prevRecap: string | null = null;
  for (const date of datesAsc) {
    const asof = await buildEventPredictionAsOf(db, eventSlug, date, season);
    if (!asof) continue; // mirrors the emit's `if (asof)` row skip
    const recap = JSON.stringify(asof.recap);
    if (recap !== prevRecap) kept.push(date);
    prevRecap = recap;
  }
  return kept.reverse(); // newest first (existing contract)
};

/**
 * The event's prediction recap AS OF a date (YYYY-MM-DD): the latest run whose
 * `predicted_at` is on or before the end of that day. Same latest-on/before rule
 * as `buildCorpsSeasonSnapshots` / `buildVsPredictionSnapshot`, so the event page
 * and the /vs chart can't disagree. The recap is canonicalized (alias → corps_key)
 * exactly like `buildLatestPredictionSummary`, so the diff view's outer-join still
 * merges predicted + scored rows for older snapshots. Returns null when no run is
 * that old. Deliberately model-agnostic (no PREDICTION_MODEL filter): an as-of
 * snapshot replays whichever model's run was actually newest on that day.
 */
export const buildEventPredictionAsOf = async (
  db: Client,
  eventSlug: string,
  date: string,
  season = '2026'
): Promise<EventPredictionAsOf | null> => {
  const cutoff = `${date}T23:59:59.999Z`;
  const result = await db.execute({
    sql: `
      SELECT * FROM model_event_prediction_runs
      WHERE season = ? AND event_slug = ? AND predicted_at <= ?
      ORDER BY predicted_at DESC
      LIMIT 1
    `,
    args: [season, eventSlug, cutoff],
  });
  const run = result.rows[0] as any;
  if (!run) return null;
  const payload = JSON.parse(String(run.payload_json));
  canonicalizePredictions(payload, await loadCorpsCanon(db));
  return {
    recap: Array.isArray(payload?.predictions) ? payload.predictions : [],
    predicted_at: run.predicted_at ?? null,
    percent_through: typeof run.percent_through === 'number' ? run.percent_through : null,
  };
};
