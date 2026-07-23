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
import { flaggedModelScore } from './predictions.js';
import {
  foldRecapRows,
  type RecapRowOut,
  type CaptionScoreRow,
  type CategoryScoreRow,
  type CorpsScoreRow,
} from './recap.js';
import { type V9Caption } from '../../training/v9Baselines.js';
// DISPLAY-ONLY division-aware baseline curves (NOT the model-serving
// referenceCurvesV4.json). Emitted by scripts/computeVsBaselineCurves.ts.
import vsBaselineCurves from '../vsBaselineCurves.json';

/** The full caption tree carried on every VS point (Total + 3 categories + 8
 *  sub-captions). `total` is always present; the rest are null when that caption
 *  has no data for the show (older seasons / missing panels) — the resolver
 *  drops null points, never plots 0. Keys match the app's VS_CAPTIONS. */
export interface VsCaptionValues {
  total: number;
  ge: number | null;
  visual: number | null;
  music: number | null;
  ge1: number | null;
  ge2: number | null;
  vp: number | null;
  va: number | null;
  cg: number | null;
  mb: number | null;
  ma: number | null;
  mp: number | null;
}

/** The ordered caption keys (also the read-model column names). */
export const VS_CAPTION_KEYS = [
  'total', 'ge', 'visual', 'music',
  'ge1', 'ge2', 'vp', 'va', 'cg', 'mb', 'ma', 'mp',
] as const;

/** Fold a recap row to the wide caption values (0/absent → null, except total). */
const captionsFromRecap = (r: RecapRowOut): VsCaptionValues => ({
  total: r.total,
  ge: r.GE || null,
  visual: r.Visual || null,
  music: r.Music || null,
  ge1: r.GE1 ?? null,
  ge2: r.GE2 ?? null,
  vp: r.VP ?? null,
  va: r.VA ?? null,
  cg: r.CG ?? null,
  mb: r.MB ?? null,
  ma: r.MA ?? null,
  mp: r.MP ?? null,
});

const nz = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : v == null ? null : Number(v);

/** One actual data point on a corps's season line. `pct` ∈ [0,100]. Carries all
 *  captions (Total + categories + sub-captions). */
export interface VsCorpsScorePoint extends VsCaptionValues {
  pct: number;
  date: string;
  eventLabel: string;
}

// Typical DCI first-show→finals span (≈6 weeks). A season whose released shows
// span fewer days than this is treated as IN PROGRESS: its stored
// percent_through normalizes to shows-so-far (so the latest released show reads
// 100%), which would make a corps with a couple of June shows span the whole
// axis. For those, position by date against this reference length instead, so
// early-season shows sit near 0% — a short segment, not a full line.
const REF_SEASON_DAYS = 40;

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

type SeasonSpan = { lo: string; inProgress: boolean };

/** Per-season released-show date range + in-progress flag. */
async function buildSeasonSpans(db: Client): Promise<Map<string, SeasonSpan>> {
  const r = await db.execute({
    sql: `SELECT season, MIN(date) AS lo, MAX(date) AS hi FROM competitions
          WHERE scores_released = 1 AND date IS NOT NULL GROUP BY season`,
  });
  const out = new Map<string, SeasonSpan>();
  for (const row of r.rows as unknown as Array<{
    season: string | null;
    lo: string | null;
    hi: string | null;
  }>) {
    if (!row.season || !row.lo || !row.hi) continue;
    out.set(String(row.season), {
      lo: row.lo,
      inProgress: daysBetween(row.lo, row.hi) < REF_SEASON_DAYS,
    });
  }
  return out;
}

/** Corrected % through season: the stored percent_through for a complete season,
 *  or date-vs-reference-length for an in-progress one. */
const seasonPct = (span: SeasonSpan | undefined, date: string, storedPct: number): number =>
  span?.inProgress && date
    ? Math.min(100, Math.max(0, (daysBetween(span.lo, date) / REF_SEASON_DAYS) * 100))
    : Math.min(100, Math.max(0, storedPct));

interface CompMeta {
  season: string;
  rawPct: number;
  date: string;
  label: string;
}

/**
 * Core: a corps's actual per-competition points WITH the full caption tree, for
 * one season or every season. Fetches the org's scores + caption + category rows
 * (alias-merged via RELATED_CORPS_CTES) and runs them through `foldRecapRows` —
 * the SAME canonical caption math as the recap table and rankings — so caption
 * values can't drift. One point per (season, corrected pct).
 */
async function foldVsCorpsPoints(
  db: Client,
  slug: string,
  season?: string
): Promise<Array<VsCorpsScorePoint & { season: string }>> {
  const lc = slug.trim().toLowerCase();
  const seasonClause = season ? 'AND c.season = ?' : '';
  const extra = season ? [season] : [];
  const [scoreRes, capRes, catRes] = await Promise.all([
    db.execute({
      sql: `WITH ${RELATED_CORPS_CTES}
        SELECT cs.competition_slug AS comp, cs.corps_key, cs.corps_name, cs.total_score,
               cs.rank, cs.division_name,
               c.season AS season, c.percent_through AS pct, c.date AS date, c.event_name AS label
        FROM corps_scores cs JOIN competitions c ON c.slug = cs.competition_slug
        WHERE cs.corps_key IN (SELECT corps_key FROM related_corps)
          AND cs.total_score IS NOT NULL AND c.percent_through IS NOT NULL ${seasonClause}`,
      args: [lc, ...extra],
    }),
    db.execute({
      sql: `WITH ${RELATED_CORPS_CTES}
        SELECT cap.competition_slug AS comp, cap.corps_key, cap.caption_name, cap.score
        FROM caption_scores cap JOIN competitions c ON c.slug = cap.competition_slug
        WHERE cap.corps_key IN (SELECT corps_key FROM related_corps) ${seasonClause}`,
      args: [lc, ...extra],
    }),
    db.execute({
      sql: `WITH ${RELATED_CORPS_CTES}
        SELECT cat.competition_slug AS comp, cat.corps_key, cat.category_name, cat.score
        FROM category_scores cat JOIN competitions c ON c.slug = cat.competition_slug
        WHERE cat.corps_key IN (SELECT corps_key FROM related_corps) ${seasonClause}`,
      args: [lc, ...extra],
    }),
  ]);

  const push = <T>(m: Map<string, T[]>, k: string, v: T) => {
    const a = m.get(k);
    if (a) a.push(v);
    else m.set(k, [v]);
  };
  const scoresByComp = new Map<string, CorpsScoreRow[]>();
  const capsByComp = new Map<string, CaptionScoreRow[]>();
  const catsByComp = new Map<string, CategoryScoreRow[]>();
  const metaByComp = new Map<string, CompMeta>();
  for (const r of scoreRes.rows as any[]) {
    const comp = String(r.comp);
    push(scoresByComp, comp, {
      corps_key: String(r.corps_key),
      corps_name: r.corps_name ?? null,
      total_score: nz(r.total_score),
      rank: r.rank == null ? null : Number(r.rank),
      division_name: r.division_name ?? null,
    });
    if (!metaByComp.has(comp))
      metaByComp.set(comp, {
        season: String(r.season),
        rawPct: Number(r.pct),
        date: r.date ?? '',
        label: r.label ?? '',
      });
  }
  for (const r of capRes.rows as any[])
    push(capsByComp, String(r.comp), {
      corps_key: String(r.corps_key),
      caption_name: String(r.caption_name),
      score: nz(r.score),
    });
  for (const r of catRes.rows as any[])
    push(catsByComp, String(r.comp), {
      corps_key: String(r.corps_key),
      category_name: String(r.category_name),
      score: nz(r.score),
    });

  const spans = await buildSeasonSpans(db);
  // One point per (season, corrected pct); last wins on a same-pct collision.
  const byKey = new Map<string, VsCorpsScorePoint & { season: string }>();
  for (const [comp, meta] of metaByComp) {
    const folded = foldRecapRows(
      scoresByComp.get(comp) ?? [],
      capsByComp.get(comp) ?? [],
      catsByComp.get(comp) ?? []
    );
    for (const r of folded) {
      if (typeof r.total !== 'number' || r.total <= 0) continue;
      const pct = seasonPct(spans.get(meta.season), meta.date, meta.rawPct);
      byKey.set(`${meta.season}~${pct}`, {
        season: meta.season,
        pct,
        date: meta.date,
        eventLabel: meta.label,
        ...captionsFromRecap(r),
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.season.localeCompare(b.season) || a.pct - b.pct
  );
}

/**
 * A corps's actual per-competition points (all captions) for a season, ordered by
 * % through the season. The alias-merge unions every corps_key for the org.
 */
export const buildVsCorpsScores = async (
  db: Client,
  slug: string,
  season: string
): Promise<VsCorpsScorePoint[]> =>
  (await foldVsCorpsPoints(db, slug, season)).map(({ season: _s, ...p }) => p);

/** Every (corps_slug, season) pair with plottable data — the dev/relational
 *  counterpart of `readVsCorpsSeasonAvailability`. */
export const buildVsSeasonAvailability = async (
  db: Client,
): Promise<Array<{ corps_slug: string; season: string }>> => {
  const r = await db.execute({
    sql: `SELECT DISTINCT co.slug AS corps_slug, c.season AS season
      FROM corps_scores cs
      JOIN competitions c ON c.slug = cs.competition_slug
      JOIN corps co ON co.corps_key = cs.corps_key
      WHERE cs.total_score IS NOT NULL AND c.percent_through IS NOT NULL AND co.slug IS NOT NULL`,
  });
  return (r.rows as unknown as Array<{ corps_slug: string | null; season: string | null }>)
    .filter((x) => x.corps_slug && x.season)
    .map((x) => ({ corps_slug: String(x.corps_slug), season: String(x.season) }));
};

/** The 2026 field (roster) — corps the model predicts for 2026 = competing this
 *  season. Dev/relational counterpart of `readVsActiveCorps`. */
export const buildVsActiveCorps = async (db: Client): Promise<string[]> => {
  // Model-agnostic on purpose: this is the /vs roster (which corps the model
  // forecasts at all this season = existence), not a served prediction number.
  // Any model's run qualifies a corps into the field; the actual numbers come
  // from the flag-filtered latest-forecast selection below.
  const r = await db.execute({
    sql: `SELECT DISTINCT co.slug AS slug
      FROM model_event_prediction_rows pr
      JOIN model_event_prediction_runs run ON run.prediction_id = pr.prediction_id
      JOIN corps co ON co.corps_key = pr.corps_key
      WHERE run.season = '2026' AND co.slug IS NOT NULL`,
  });
  return (r.rows as unknown as Array<{ slug: string | null }>)
    .map((x) => x.slug)
    .filter((s): s is string => !!s);
};

/** The seasons a corps actually competed (has scored points) — to constrain the
 *  builder's season chips so it never offers a season with no data. */
export const buildVsCorpsSeasons = async (db: Client, slug: string): Promise<string[]> => {
  const r = await db.execute({
    sql: `WITH ${RELATED_CORPS_CTES}
      SELECT DISTINCT c.season AS season
      FROM corps_scores cs
      JOIN competitions c ON c.slug = cs.competition_slug
      WHERE cs.corps_key IN (SELECT corps_key FROM related_corps)
        AND cs.total_score IS NOT NULL AND c.percent_through IS NOT NULL
      ORDER BY c.season DESC`,
    args: [slug.trim().toLowerCase()],
  });
  return (r.rows as unknown as Array<{ season: string | null }>)
    .map((x) => x.season)
    .filter((s): s is string => !!s);
};

/** 2026 prediction snapshot dates (distinct `predicted_at` days) for a corps —
 *  the valid as-of values the builder's date picker should offer. */
export const buildVs2026SnapshotDates = async (db: Client, slug: string): Promise<string[]> => {
  // Model-agnostic on purpose: these are the as-of scrubber dates (every day the
  // forecast was recomputed, by any model), not a current-forecast selection.
  const r = await db.execute({
    sql: `WITH ${RELATED_CORPS_CTES}
      SELECT DISTINCT substr(run.predicted_at, 1, 10) AS d
      FROM model_event_prediction_rows r
      JOIN model_event_prediction_runs run ON run.prediction_id = r.prediction_id
      WHERE run.season = '2026'
        AND r.corps_key IN (SELECT corps_key FROM related_corps)
        AND run.predicted_at IS NOT NULL
      ORDER BY d DESC`,
    args: [slug.trim().toLowerCase()],
  });
  return (r.rows as unknown as Array<{ d: string | null }>)
    .map((x) => x.d)
    .filter((d): d is string => !!d);
};

/** Emit-time variant: every season's actual points (all captions) for a corps in
 *  ONE pass (the live path filters by season; the emitter freezes all at once). */
export const buildVsCorpsScoresAllSeasons = (
  db: Client,
  slug: string
): Promise<Array<VsCorpsScorePoint & { season: string }>> => foldVsCorpsPoints(db, slug);

/** A point on the 2026 predicted-to-finals line, with all captions. */
export interface VsPredictedPoint extends VsCaptionValues {
  pct: number;
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
    // "latest" = the current forecast per event → flag-filtered (PREDICTION_MODEL):
    // prefer the flagged model's newest run, else fall back to newest-any so an
    // event the flagged model hasn't forecast yet still plots (never blank).
    sql: `WITH ${RELATED_CORPS_CTES},
      latest AS (
        SELECT prediction_id FROM (
          SELECT prediction_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY event_slug
                   ORDER BY ${flaggedModelScore('model_dir')} DESC, predicted_at DESC
                 ) AS rn
          FROM model_event_prediction_runs WHERE season = '2026'
        ) WHERE rn = 1
      )
      SELECT run.percent_through AS pct, r.predicted_total AS predicted,
             r.predicted_ge AS ge, r.predicted_visual AS visual, r.predicted_music AS music,
             r.predicted_captions_json AS caps
      FROM model_event_prediction_rows r
      JOIN model_event_prediction_runs run ON run.prediction_id = r.prediction_id
      JOIN latest l ON l.prediction_id = run.prediction_id
      WHERE run.season = '2026'
        AND r.corps_key IN (SELECT corps_key FROM related_corps)
        AND run.percent_through IS NOT NULL
        AND r.predicted_total IS NOT NULL
      ORDER BY run.percent_through ASC`,
    args: [slug.trim().toLowerCase()],
  });

  // One point per pct, keeping the highest predicted total (guards a corps_key
  // matching more than one prediction row — same rule as buildCorpsSeasonScores).
  const byPct = new Map<number, VsPredictedPoint>();
  for (const raw of result.rows as unknown as Array<{
    pct: number | null;
    predicted: number | null;
    ge: number | null;
    visual: number | null;
    music: number | null;
    caps: string | null;
  }>) {
    if (typeof raw.pct !== 'number' || typeof raw.predicted !== 'number') continue;
    const pct = Math.min(100, Math.max(0, raw.pct));
    const prev = byPct.get(pct);
    if (prev && prev.total >= raw.predicted) continue;
    // predicted_captions_json = {"GE1","GE2","VP","VA","CG","MB","MA","MP"}.
    let c: Record<string, number> = {};
    try {
      c = raw.caps ? JSON.parse(raw.caps) : {};
    } catch {
      c = {};
    }
    byPct.set(pct, {
      pct,
      total: raw.predicted,
      ge: nz(raw.ge),
      visual: nz(raw.visual),
      music: nz(raw.music),
      ge1: nz(c.GE1),
      ge2: nz(c.GE2),
      vp: nz(c.VP),
      va: nz(c.VA),
      cg: nz(c.CG),
      mb: nz(c.MB),
      ma: nz(c.MA),
      mp: nz(c.MP),
    });
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
 * Deliberately model-agnostic (no PREDICTION_MODEL filter): an as-of snapshot
 * replays whichever model's run was actually newest on that day.
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

/** Per-division baseline rank caps — where each division's clean-view data is
 *  actually real (see DATA_QUALITY_NOTES.md §11e / computeVsBaselineCurves.ts):
 *  World Class 1–20, Open Class 1–10 (OC thins hard past 6). Matches the artifact
 *  `maxRank`. Deeper ranks are sparse/finals-only and would render misleading
 *  flat lines. */
export const VS_BASELINE_DIVISIONS = ['World Class', 'Open Class'] as const;
export type VsBaselineDivision = (typeof VS_BASELINE_DIVISIONS)[number];
export const VS_BASELINE_MAX_RANK: Record<VsBaselineDivision, number> = {
  'World Class': 20,
  'Open Class': 10,
};
/** Percent buckets the reference curves are keyed on. */
export const VS_BASELINE_BUCKETS = Array.from({ length: 21 }, (_, i) => i * 5); // 0,5,…,100

export interface VsBaselinePoint extends VsCaptionValues {
  /** Competitive division the baseline is drawn from ('World Class' | 'Open
   *  Class'). Open Class scores sit distinctly lower, so the /vs picker offers
   *  each division's own Nth-place line. */
  division: string;
  rank: number;
  bucket: number;
}

const r3 = (n: number) => Number(n.toFixed(3));

/** A V9 caption record → the wide caption values. Category scores use the SAME
 *  DCI weighting as `totalOf` (GE = GE1+GE2; Visual/Music are half-summed) so a
 *  baseline category line sits on the same scale as the actual category_scores. */
const baselineCaptions = (c: Record<V9Caption, number>): VsCaptionValues => ({
  total: r3(totalOf(c)),
  ge: r3(c.GE1 + c.GE2),
  visual: r3((c.VP + c.VA + c.CG) / 2),
  music: r3((c.MB + c.MA + c.MP) / 2),
  ge1: r3(c.GE1),
  ge2: r3(c.GE2),
  vp: r3(c.VP),
  va: r3(c.VA),
  cg: r3(c.CG),
  mb: r3(c.MB),
  ma: r3(c.MA),
  mp: r3(c.MP),
});

/** The 8 caption slugs, in the artifact's canonical order. */
const V9_CAPTIONS: readonly V9Caption[] = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'];

/** The DISPLAY-ONLY division-aware baseline artifact (NOT the model-serving
 *  referenceCurvesV4.json). Emitted by scripts/computeVsBaselineCurves.ts from the
 *  clean view, keyed `Division → "rank-bucket" → { 8 captions }`. */
interface VsBaselineArtifact {
  curves: Record<string, Record<string, Partial<Record<V9Caption, number>>>>;
  maxRank?: Record<string, number>;
}

/**
 * Precompute the per-division Nth-place baseline curve (all captions) for every
 * (division, rank, bucket). Pure — sources ONLY the display artifact
 * vsBaselineCurves.json (division-keyed), so the emitted shard removes both the
 * file and the formula from the request path, and touches NO model-serving path.
 *
 * A per-division CROSS-RANK monotone clamp is the residual guard: within a
 * division and bucket, a better rank must never score below a worse rank. The
 * artifact stays honest (deep-field sparsity carries real non-monotonicity); we
 * enforce non-increasing values as the rank number grows via a running-min from
 * rank 1 downward, per caption, then recompute categories/total so caption,
 * category and total lines stay mutually self-consistent.
 */
export const buildVsBaselineCurve = (): VsBaselinePoint[] => {
  const artifact = vsBaselineCurves as unknown as VsBaselineArtifact;
  const out: VsBaselinePoint[] = [];

  for (const division of VS_BASELINE_DIVISIONS) {
    const divCurves = artifact.curves?.[division] ?? {};
    const maxRank = VS_BASELINE_MAX_RANK[division];
    const ranks = Array.from({ length: maxRank }, (_, i) => i + 1);

    for (const bucket of VS_BASELINE_BUCKETS) {
      const perRank: Record<V9Caption, number>[] = [];
      for (const rank of ranks) {
        const raw = (divCurves[`${rank}-${bucket}`] ?? {}) as Partial<Record<V9Caption, number>>;
        const captions = {} as Record<V9Caption, number>;
        for (const cap of V9_CAPTIONS) {
          const v = raw[cap];
          // Defensive: an absent caption falls back to VP (VA≈VP) or 0.
          captions[cap] = typeof v === 'number' ? v : (typeof raw.VP === 'number' ? raw.VP! : 0);
        }
        perRank.push(captions);
      }
      // Per-division cross-rank monotone clamp (running-min from rank 1 down).
      for (const cap of V9_CAPTIONS) {
        let running = Infinity;
        for (let i = 0; i < perRank.length; i++) {
          running = Math.min(running, perRank[i]![cap]);
          perRank[i]![cap] = running;
        }
      }
      for (let i = 0; i < ranks.length; i++) {
        out.push({ division, rank: ranks[i]!, bucket, ...baselineCaptions(perRank[i]!) });
      }
    }
  }
  // Stable emit: division-major, then rank, then bucket.
  out.sort(
    (a, b) =>
      VS_BASELINE_DIVISIONS.indexOf(a.division as VsBaselineDivision) -
        VS_BASELINE_DIVISIONS.indexOf(b.division as VsBaselineDivision) ||
      a.rank - b.rank ||
      a.bucket - b.bucket
  );
  return out;
};
