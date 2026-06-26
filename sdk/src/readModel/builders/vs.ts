// Read-model builders for the VS Comparison Chart (VS_COMPARISON_CHART_PLAN.md).
// Two shards, both prod-serviceable from the read-model so /vs works without the
// 3.6 GB relational DB on the request path:
//
//   1. rm_vs_corps_scores — a corps's ACTUAL total per competition, for EVERY
//      season (2013–2026), keyed by (corps_slug, season). x = competitions.
//      percent_through (date-linear, 0=first show, 100=finals — identical across
//      seasons, so cross-season lines align). This is a plain corps_scores →
//      competitions join (no prediction tables, which are 2026-only).
//   2. rm_vs_baselines — the generic Nth-place reference curve (rank 1–25 ×
//      percent bucket 0,5,…,100 → OVERALL TOTAL), precomputed from the V9
//      reference curves so the request path never touches the file or the formula.
//
// Shared by the live VS service (fallback) and emitReadModel, like every builder.
import type { Client } from '@libsql/client';
import { RELATED_CORPS_CTES } from './corpsAliases.js';
import { getV9CaptionBaseline, type V9Caption } from '../../training/v9Baselines.js';
import referenceCurvesV4 from '../../training/referenceCurvesV4.json';

/** One actual data point on a corps's season line. `pct` ∈ [0,100]. */
export interface VsCorpsScorePoint {
  pct: number;
  total: number;
  date: string;
  eventLabel: string;
}

/**
 * A corps's actual total per competition for a season, ordered by % through the
 * season. Works for any season — historical actuals need no prediction run. The
 * alias-merge (RELATED_CORPS_CTES) unions every corps_key that maps to this org.
 */
export const buildVsCorpsScores = async (
  db: Client,
  slug: string,
  season: string
): Promise<VsCorpsScorePoint[]> => {
  const result = await db.execute({
    sql: `WITH ${RELATED_CORPS_CTES}
      SELECT c.percent_through AS pct,
             c.date           AS date,
             c.event_name     AS label,
             cs.total_score   AS total
      FROM corps_scores cs
      JOIN competitions c ON c.slug = cs.competition_slug
      WHERE cs.corps_key IN (SELECT corps_key FROM related_corps)
        AND c.season = ?
        AND cs.total_score IS NOT NULL
        AND c.percent_through IS NOT NULL
      ORDER BY c.percent_through ASC`,
    args: [slug.trim().toLowerCase(), season],
  });

  // One point per pct (a corps can't score twice at the same % point); last wins
  // on the rare same-day collision, matching the single-corps chart's dedupe.
  const byPct = new Map<number, VsCorpsScorePoint>();
  for (const raw of result.rows as unknown as Array<{
    pct: number | null;
    date: string | null;
    label: string | null;
    total: number | null;
  }>) {
    if (typeof raw.pct !== 'number' || typeof raw.total !== 'number') continue;
    const pct = Math.min(100, Math.max(0, raw.pct));
    byPct.set(pct, {
      pct,
      total: Number(raw.total),
      date: raw.date ?? '',
      eventLabel: raw.label ?? '',
    });
  }
  return [...byPct.values()].sort((a, b) => a.pct - b.pct);
};

/** Emit-time variant: every season's actual points for a corps in ONE query
 *  (the live path filters by season; the emitter freezes all seasons at once). */
export const buildVsCorpsScoresAllSeasons = async (
  db: Client,
  slug: string
): Promise<Array<VsCorpsScorePoint & { season: string }>> => {
  const result = await db.execute({
    sql: `WITH ${RELATED_CORPS_CTES}
      SELECT c.season         AS season,
             c.percent_through AS pct,
             c.date           AS date,
             c.event_name     AS label,
             cs.total_score   AS total
      FROM corps_scores cs
      JOIN competitions c ON c.slug = cs.competition_slug
      WHERE cs.corps_key IN (SELECT corps_key FROM related_corps)
        AND cs.total_score IS NOT NULL
        AND c.percent_through IS NOT NULL
      ORDER BY c.season ASC, c.percent_through ASC`,
    args: [slug.trim().toLowerCase()],
  });

  // Dedupe within each season by pct (last wins).
  const bySeasonPct = new Map<string, VsCorpsScorePoint & { season: string }>();
  for (const raw of result.rows as unknown as Array<{
    season: string | null;
    pct: number | null;
    date: string | null;
    label: string | null;
    total: number | null;
  }>) {
    if (!raw.season || typeof raw.pct !== 'number' || typeof raw.total !== 'number') continue;
    const pct = Math.min(100, Math.max(0, raw.pct));
    bySeasonPct.set(`${raw.season}~${pct}`, {
      season: raw.season,
      pct,
      total: Number(raw.total),
      date: raw.date ?? '',
      eventLabel: raw.label ?? '',
    });
  }
  return [...bySeasonPct.values()].sort(
    (a, b) => a.season.localeCompare(b.season) || a.pct - b.pct
  );
};

/** A point on the 2026 predicted-to-finals line. */
export interface VsPredictedPoint {
  pct: number;
  predicted: number;
}

/**
 * The 2026 model's predicted total per event by % through season (the dashed
 * "predicted-to-finals" overlay for a current-season corps line). Predictions
 * exist only for 2026, so this is current-season only. Latest run per event,
 * mirroring buildCorpsSeasonScores.
 */
export const buildVsCorps2026Predicted = async (
  db: Client,
  slug: string
): Promise<VsPredictedPoint[]> => {
  const result = await db.execute({
    sql: `WITH ${RELATED_CORPS_CTES},
      latest AS (
        SELECT event_slug, MAX(predicted_at) AS pa
        FROM model_event_prediction_runs WHERE season = '2026' GROUP BY event_slug
      )
      SELECT run.percent_through AS pct, r.predicted_total AS predicted
      FROM model_event_prediction_rows r
      JOIN model_event_prediction_runs run ON run.prediction_id = r.prediction_id
      JOIN latest l ON l.event_slug = run.event_slug AND l.pa = run.predicted_at
      WHERE run.season = '2026'
        AND r.corps_key IN (SELECT corps_key FROM related_corps)
        AND run.percent_through IS NOT NULL
        AND r.predicted_total IS NOT NULL
      ORDER BY run.percent_through ASC`,
    args: [slug.trim().toLowerCase()],
  });

  // One point per pct, keeping the highest predicted (guards a corps_key matching
  // more than one prediction row — same rule as buildCorpsSeasonScores).
  const byPct = new Map<number, VsPredictedPoint>();
  for (const raw of result.rows as unknown as Array<{
    pct: number | null;
    predicted: number | null;
  }>) {
    if (typeof raw.pct !== 'number' || typeof raw.predicted !== 'number') continue;
    const pct = Math.min(100, Math.max(0, raw.pct));
    const prev = byPct.get(pct);
    if (!prev || raw.predicted > prev.predicted) byPct.set(pct, { pct, predicted: raw.predicted });
  }
  return [...byPct.values()].sort((a, b) => a.pct - b.pct);
};

/** A point on a prediction-as-of snapshot line. */
export interface VsSnapshotPoint {
  pct: number;
  predicted: number;
  date: string;
  eventLabel: string;
}

/**
 * A 2026 prediction snapshot as-of a date: for each event, the latest run with
 * `predicted_at <= asOf`, plotting predicted_total by % through season. Dynamic
 * in `asOf`, so this is a live (relational) read — never a frozen shard. 2026
 * only (no historical prediction snapshots exist).
 */
export const buildVsPredictionSnapshot = async (
  db: Client,
  slug: string,
  asOf: string
): Promise<VsSnapshotPoint[]> => {
  const result = await db.execute({
    sql: `WITH ${RELATED_CORPS_CTES},
      latest AS (
        SELECT event_slug, MAX(predicted_at) AS pa
        FROM model_event_prediction_runs
        WHERE season = '2026' AND predicted_at <= ?
        GROUP BY event_slug
      )
      SELECT run.percent_through AS pct,
             r.predicted_total   AS predicted,
             e.start_date        AS date,
             COALESCE(e.event_name, e.name, run.event_slug) AS label
      FROM model_event_prediction_rows r
      JOIN model_event_prediction_runs run ON run.prediction_id = r.prediction_id
      JOIN latest l ON l.event_slug = run.event_slug AND l.pa = run.predicted_at
      LEFT JOIN events e ON e.slug = run.event_slug
      WHERE run.season = '2026'
        AND r.corps_key IN (SELECT corps_key FROM related_corps)
        AND run.percent_through IS NOT NULL
        AND r.predicted_total IS NOT NULL
      ORDER BY run.percent_through ASC`,
    args: [slug.trim().toLowerCase(), asOf],
  });

  const byPct = new Map<number, VsSnapshotPoint>();
  for (const raw of result.rows as unknown as Array<{
    pct: number | null;
    predicted: number | null;
    date: string | null;
    label: string | null;
  }>) {
    if (typeof raw.pct !== 'number' || typeof raw.predicted !== 'number') continue;
    const pct = Math.min(100, Math.max(0, raw.pct));
    const prev = byPct.get(pct);
    if (!prev || raw.predicted > prev.predicted)
      byPct.set(pct, { pct, predicted: raw.predicted, date: raw.date ?? '', eventLabel: raw.label ?? '' });
  }
  return [...byPct.values()].sort((a, b) => a.pct - b.pct);
};

// ── Baselines ────────────────────────────────────────────────────────────────

/** The single OVERALL TOTAL formula (DCI weighting) — kept here so baseline,
 *  actual, and predicted totals are all comparable. Mirrors `totalFromV9Captions`
 *  (sdk/src/training/v9PredictionFeatures.ts) without importing that DB-heavy
 *  module into the read-model path. */
const totalOf = (c: Record<V9Caption, number>) =>
  c.GE1 + c.GE2 + (c.VP + c.VA + c.CG) / 2 + (c.MB + c.MA + c.MP) / 2;

/** Effective baseline ranks (curves are division-agnostic; see plan). Capped at
 *  24: rank 25's reference curve is degenerate (flat ~73 all season) in the
 *  source data, so it would render a misleading horizontal line. */
export const VS_BASELINE_RANKS = Array.from({ length: 24 }, (_, i) => i + 1);
/** Percent buckets the reference curves are keyed on. */
export const VS_BASELINE_BUCKETS = Array.from({ length: 21 }, (_, i) => i * 5); // 0,5,…,100

export interface VsBaselinePoint {
  rank: number;
  bucket: number;
  total: number;
}

/**
 * Precompute the generic Nth-place total curve for every (rank, bucket). Pure —
 * sources only the V9 reference curves file (read once by getV9CaptionBaseline),
 * so the emitted shard removes both the file and the formula from the request
 * path. `getV9CaptionBaseline` fills any missing caption (e.g. VA) with its own
 * fallback, so every total is complete.
 */
export const buildVsBaselineCurve = (referenceCurvesPath?: string): VsBaselinePoint[] => {
  const out: VsBaselinePoint[] = [];
  // Raw entries (legacy `rank-bucket` keys, division-agnostic) — used only to
  // detect a genuinely-missing VA so we can impute it from VP below.
  const curvesByKey = (referenceCurvesV4 as { curves?: Record<string, unknown> }).curves ?? {};
  for (const rank of VS_BASELINE_RANKS) {
    for (const bucket of VS_BASELINE_BUCKETS) {
      const r = getV9CaptionBaseline({
        mode: 'preseason_forecast',
        division: 'World Class',
        percentThrough: bucket,
        seedRank: rank,
        referenceCurvesPath,
      });
      const captions = { ...(r.captions as Record<V9Caption, number>) };
      // VA is absent in ~170/551 curve entries. getV9CaptionBaseline blunt-fills
      // those with 15; VA tracks VP closely, so impute VA from VP where the curve
      // entry genuinely lacks it — a better total than the flat 15 (plan §data).
      const raw = (curvesByKey as Record<string, Partial<Record<V9Caption, number>>>)[
        `${rank}-${bucket}`
      ];
      if (raw && typeof raw.VA !== 'number') captions.VA = captions.VP;
      out.push({ rank, bucket, total: Number(totalOf(captions).toFixed(3)) });
    }
  }
  return out;
};
