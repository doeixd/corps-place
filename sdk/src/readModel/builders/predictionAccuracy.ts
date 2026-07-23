// Read-model builder for the public /accuracy page (prediction accuracy report).
//
// "What we said going in" = the LAST saved prediction run STRICTLY BEFORE each
// event's start (predicted_at < events.start_date) — that's what was actually
// served the night before the show, so it's leakage-safe (the model never saw
// the show). We join that run's predicted totals to the ground-truth actuals in
// corps_scores (competition_slug == event_slug, by corps_key), World + Open Class
// only (the models don't cover all-age). A secondary pass buckets the error of
// EVERY pre-show run by days-before-show to show forecasts sharpening near
// showtime.
//
// The whole page payload is computed here and frozen into a single rm_accuracy
// JSON shard keyed by season (one parse in the reader → a typed object for the
// route). Aggregates: overall summary, daily MAE/bias series, per-corps, per
// division, per model-era, lead-time buckets, signed-error histogram, per-event.

import type { Client } from '@libsql/client';

export interface AccuracySummary {
  n: number; // corps-events scored
  nShows: number; // distinct (event, division) shows with a callable winner
  mae: number;
  medianAbs: number;
  bias: number; // signed mean error (predicted - actual); negative = under-predict
  within1Pct: number;
  within2Pct: number;
  rankExactPct: number;
  meanRankDisp: number;
  winnerPct: number;
}
export interface AccuracyDaily { date: string; n: number; mae: number; bias: number }
export interface AccuracyCorps { corpsSlug: string; corpsName: string; n: number; mae: number; bias: number }
export interface AccuracyGroup { key: string; label: string; n: number; mae: number; bias: number }
export interface AccuracyLead { bucket: string; n: number; mae: number }
export interface AccuracyBin { binLo: number; binHi: number; center: number; count: number }
export interface AccuracyEvent {
  eventSlug: string;
  eventName: string;
  date: string;
  yearSlug: string;
  showSlug: string;
  division: string;
  n: number;
  mae: number;
  era: string;
  eraLabel: string;
  modelDir: string;
  biggestMissCorps: string;
  biggestMissSlug: string;
  biggestMissError: number; // signed
}
export interface AccuracyPayload {
  season: string;
  updatedAt: string;
  scope: string;
  summary: AccuracySummary;
  daily: AccuracyDaily[];
  perCorps: AccuracyCorps[];
  perDivision: AccuracyGroup[];
  perEra: AccuracyGroup[];
  leadTime: AccuracyLead[];
  histogram: AccuracyBin[];
  events: AccuracyEvent[];
  eras: { key: string; label: string; flipDate: string | null }[];
}

// model_dir → era key + friendly label, mirroring the prediction page's mapping
// (app/routes/events/$yearSlug/$slug/prediction.tsx PredictionDetails). 'shadow'
// in the v11 tag is a persistence artifact — v11 is the primary served model.
const eraOf = (modelDir: string): { key: string; label: string } => {
  const m = modelDir ?? '';
  if (/v11-fp/.test(m)) return { key: 'v11', label: 'v11 field-pace ensemble' };
  if (/fieldpace-recal/.test(m)) return { key: 'v10.5', label: 'v10.5 field-pace + recal' };
  if (/v10-ensemble/.test(m)) return { key: 'v10', label: 'v10 ensemble' };
  if (/final2/.test(m)) return { key: 'final2', label: 'final2 (v9)' };
  return { key: 'other', label: m.split(/[/\\]/).filter(Boolean).pop() ?? m };
};

// Known model-flip dates (era markers on the daily chart). Past-only.
const ERA_FLIPS: { key: string; label: string; flipDate: string | null }[] = [
  { key: 'final2', label: 'final2 (v9)', flipDate: null },
  { key: 'v10.5', label: 'v10.5 field-pace + recal', flipDate: '2026-07-20' },
  { key: 'v11', label: 'v11 field-pace ensemble', flipDate: '2026-07-22' },
];

interface DetailRow {
  eventSlug: string;
  eventName: string;
  showDate: string;
  division: string;
  modelDir: string;
  corpsKey: string;
  corpsSlug: string;
  corpsName: string;
  predictedTotal: number;
  predictedRank: number | null;
  actualTotal: number;
  actualRank: number | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const buildPredictionAccuracy = async (
  db: Client,
  season: string
): Promise<AccuracyPayload> => {
  // 1) Last-pre-show run per (event, division) joined to ground-truth actuals.
  const detailSql = `
    WITH lastrun AS (
      SELECT run.event_slug, run.prediction_id, run.model_dir, run.division,
             substr(e.start_date, 1, 10) AS show_date,
             ROW_NUMBER() OVER (
               PARTITION BY run.event_slug, run.division
               ORDER BY run.predicted_at DESC
             ) AS rn
      FROM model_event_prediction_runs run
      JOIN events e ON e.slug = run.event_slug
      WHERE run.season = ?1
        AND run.predicted_at < e.start_date
        AND EXISTS (
          SELECT 1 FROM competitions c
          WHERE c.slug = run.event_slug AND c.scores_released = 1
        )
    )
    SELECT lr.event_slug, lr.division, lr.model_dir, lr.show_date,
           COALESCE(ev.name, ev.event_name, lr.event_slug) AS event_name,
           r.corps_key, r.predicted_total, r.predicted_rank,
           cs.total_score AS actual_total, cs.rank AS actual_rank,
           cs.corps_name, co.slug AS corps_slug
    FROM lastrun lr
    JOIN model_event_prediction_rows r ON r.prediction_id = lr.prediction_id
    JOIN corps_scores cs
      ON cs.competition_slug = lr.event_slug AND cs.corps_key = r.corps_key
    LEFT JOIN corps co ON co.corps_key = r.corps_key
    LEFT JOIN events ev ON ev.slug = lr.event_slug
    WHERE lr.rn = 1
      AND r.predicted_total IS NOT NULL
      AND cs.total_score IS NOT NULL
      AND cs.division_name IN ('World Class', 'Open Class')
  `;
  const detailRes = await db.execute({ sql: detailSql, args: [season] });
  const rows: DetailRow[] = (detailRes.rows as any[]).map((x) => ({
    eventSlug: String(x.event_slug),
    eventName: String(x.event_name),
    showDate: String(x.show_date),
    division: String(x.division),
    modelDir: String(x.model_dir ?? ''),
    corpsKey: String(x.corps_key),
    corpsSlug: x.corps_slug ? String(x.corps_slug) : '',
    corpsName: String(x.corps_name ?? ''),
    predictedTotal: Number(x.predicted_total),
    predictedRank: x.predicted_rank == null ? null : Number(x.predicted_rank),
    actualTotal: Number(x.actual_total),
    actualRank: x.actual_rank == null ? null : Number(x.actual_rank),
  }));

  const err = (r: DetailRow) => r.predictedTotal - r.actualTotal;
  const abs = (r: DetailRow) => Math.abs(err(r));

  // ── Overall summary ────────────────────────────────────────────────────────
  const absErrs = rows.map(abs);
  const signed = rows.map(err);
  const rankPairs = rows.filter((r) => r.predictedRank != null && r.actualRank != null);
  const rankExact = rankPairs.filter((r) => r.predictedRank === r.actualRank).length;
  const rankDisp = rankPairs.map((r) => Math.abs((r.predictedRank as number) - (r.actualRank as number)));

  const showGroups = new Map<string, DetailRow[]>();
  for (const r of rows) {
    const k = `${r.eventSlug}::${r.division}`;
    (showGroups.get(k) ?? showGroups.set(k, []).get(k)!).push(r);
  }

  // Winner-called: per (event, division), the model's predicted #1 corps vs the
  // ACTUAL #1 corps — using the full predicted field and full scored field (not
  // just the matched intersection), so a champion the model omitted still counts
  // as a miss. Predicted winner = predicted_rank=1 in the last-pre-show run;
  // actual winner = corps_scores.rank=1.
  const winnerSql = `
    WITH lastrun AS (
      SELECT run.event_slug, run.prediction_id, run.division,
             ROW_NUMBER() OVER (
               PARTITION BY run.event_slug, run.division
               ORDER BY run.predicted_at DESC
             ) AS rn
      FROM model_event_prediction_runs run
      JOIN events e ON e.slug = run.event_slug
      WHERE run.season = ?1
        AND run.predicted_at < e.start_date
        AND EXISTS (
          SELECT 1 FROM competitions c
          WHERE c.slug = run.event_slug AND c.scores_released = 1
        )
    ),
    pw AS (
      SELECT lr.event_slug, lr.division, r.corps_key AS pk
      FROM lastrun lr
      JOIN model_event_prediction_rows r ON r.prediction_id = lr.prediction_id
      WHERE lr.rn = 1 AND r.predicted_rank = 1
    ),
    aw AS (
      SELECT cs.competition_slug, cs.division_name, cs.corps_key AS ak
      FROM corps_scores cs
      WHERE cs.rank = 1 AND cs.division_name IN ('World Class', 'Open Class')
    )
    SELECT pw.pk AS pk, aw.ak AS ak
    FROM pw
    JOIN aw ON aw.competition_slug = pw.event_slug AND aw.division_name = pw.division
  `;
  const winnerRes = await db.execute({ sql: winnerSql, args: [season] });
  let winnerHits = 0;
  let winnerShows = 0;
  for (const w of winnerRes.rows as any[]) {
    winnerShows++;
    if (String(w.pk) === String(w.ak)) winnerHits++;
  }

  const n = rows.length;
  const summary: AccuracySummary = {
    n,
    nShows: winnerShows,
    mae: r3(mean(absErrs)),
    medianAbs: r3(median(absErrs)),
    bias: r3(mean(signed)),
    within1Pct: n ? r2((100 * absErrs.filter((e) => e <= 1).length) / n) : 0,
    within2Pct: n ? r2((100 * absErrs.filter((e) => e <= 2).length) / n) : 0,
    rankExactPct: rankPairs.length ? r2((100 * rankExact) / rankPairs.length) : 0,
    meanRankDisp: r3(mean(rankDisp)),
    winnerPct: winnerShows ? r2((100 * winnerHits) / winnerShows) : 0,
  };

  // ── Daily series (by show date) ────────────────────────────────────────────
  const byDate = new Map<string, DetailRow[]>();
  for (const r of rows) (byDate.get(r.showDate) ?? byDate.set(r.showDate, []).get(r.showDate)!).push(r);
  const daily: AccuracyDaily[] = [...byDate.entries()]
    .map(([date, grp]) => ({
      date,
      n: grp.length,
      mae: r3(mean(grp.map(abs))),
      bias: r3(mean(grp.map(err))),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // ── Per corps (min n = 3) ──────────────────────────────────────────────────
  const byCorps = new Map<string, DetailRow[]>();
  for (const r of rows) {
    const k = r.corpsSlug || r.corpsKey;
    (byCorps.get(k) ?? byCorps.set(k, []).get(k)!).push(r);
  }
  const perCorps: AccuracyCorps[] = [...byCorps.entries()]
    .filter(([, grp]) => grp.length >= 3)
    .map(([, grp]) => ({
      corpsSlug: grp[0].corpsSlug,
      corpsName: grp[0].corpsName,
      n: grp.length,
      mae: r3(mean(grp.map(abs))),
      bias: r3(mean(grp.map(err))),
    }))
    .sort((a, b) => a.mae - b.mae);

  // ── Per division ───────────────────────────────────────────────────────────
  const byDiv = new Map<string, DetailRow[]>();
  for (const r of rows) (byDiv.get(r.division) ?? byDiv.set(r.division, []).get(r.division)!).push(r);
  const perDivision: AccuracyGroup[] = [...byDiv.entries()]
    .map(([division, grp]) => ({
      key: division,
      label: division,
      n: grp.length,
      mae: r3(mean(grp.map(abs))),
      bias: r3(mean(grp.map(err))),
    }))
    .sort((a, b) => b.n - a.n);

  // ── Per model era ──────────────────────────────────────────────────────────
  const byEra = new Map<string, { label: string; rows: DetailRow[] }>();
  for (const r of rows) {
    const e = eraOf(r.modelDir);
    const cur = byEra.get(e.key) ?? { label: e.label, rows: [] };
    cur.rows.push(r);
    byEra.set(e.key, cur);
  }
  const perEra: AccuracyGroup[] = [...byEra.entries()]
    .map(([key, v]) => ({
      key,
      label: v.label,
      n: v.rows.length,
      mae: r3(mean(v.rows.map(abs))),
      bias: r3(mean(v.rows.map(err))),
    }))
    .sort((a, b) => b.n - a.n);

  // ── Signed-error histogram (1-pt bins, clamped to [-8, 8]) ──────────────────
  const CLAMP = 8;
  const binCounts = new Map<number, number>();
  for (const e of signed) {
    const c = Math.max(-CLAMP, Math.min(CLAMP, e));
    const lo = Math.floor(c); // bucket [lo, lo+1)
    binCounts.set(lo, (binCounts.get(lo) ?? 0) + 1);
  }
  const histogram: AccuracyBin[] = [...binCounts.entries()]
    .map(([lo, count]) => ({ binLo: lo, binHi: lo + 1, center: lo + 0.5, count }))
    .sort((a, b) => a.binLo - b.binLo);

  // ── Per event (recent first) with biggest miss ─────────────────────────────
  const events: AccuracyEvent[] = [...showGroups.entries()]
    .map(([, grp]) => {
      const first = grp[0];
      const worst = grp.reduce((a, b) => (abs(b) > abs(a) ? b : a), grp[0]);
      const eStr = eraOf(first.modelDir);
      return {
        eventSlug: first.eventSlug,
        eventName: first.eventName,
        date: first.showDate,
        yearSlug: season,
        showSlug: first.eventSlug.replace(/^\d{4}-/, ''),
        division: first.division,
        n: grp.length,
        mae: r3(mean(grp.map(abs))),
        era: eStr.key,
        eraLabel: eStr.label,
        modelDir: first.modelDir,
        biggestMissCorps: worst.corpsName,
        biggestMissSlug: worst.corpsSlug,
        biggestMissError: r2(err(worst)),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.division.localeCompare(b.division));

  // 2) Lead-time buckets over EVERY pre-show run (error vs days-before-show).
  const leadSql = `
    WITH allruns AS (
      SELECT run.prediction_id, run.event_slug,
             (julianday(e.start_date) - julianday(run.predicted_at)) AS days_before
      FROM model_event_prediction_runs run
      JOIN events e ON e.slug = run.event_slug
      WHERE run.season = ?1
        AND run.predicted_at < e.start_date
        AND EXISTS (
          SELECT 1 FROM competitions c
          WHERE c.slug = run.event_slug AND c.scores_released = 1
        )
    )
    SELECT ar.days_before AS days_before,
           ABS(r.predicted_total - cs.total_score) AS ae
    FROM allruns ar
    JOIN model_event_prediction_rows r ON r.prediction_id = ar.prediction_id
    JOIN corps_scores cs
      ON cs.competition_slug = ar.event_slug AND cs.corps_key = r.corps_key
    WHERE r.predicted_total IS NOT NULL
      AND cs.division_name IN ('World Class', 'Open Class')
  `;
  const leadRes = await db.execute({ sql: leadSql, args: [season] });
  const buckets: { bucket: string; lo: number; hi: number; aes: number[] }[] = [
    { bucket: '0–1d', lo: 0, hi: 1, aes: [] },
    { bucket: '1–3d', lo: 1, hi: 3, aes: [] },
    { bucket: '3–7d', lo: 3, hi: 7, aes: [] },
    { bucket: '7–14d', lo: 7, hi: 14, aes: [] },
    { bucket: '14d+', lo: 14, hi: Infinity, aes: [] },
  ];
  for (const x of leadRes.rows as any[]) {
    const d = Number(x.days_before);
    const ae = Number(x.ae);
    const b = buckets.find((bk) => d >= bk.lo && d < bk.hi);
    if (b) b.aes.push(ae);
  }
  const leadTime: AccuracyLead[] = buckets.map((b) => ({
    bucket: b.bucket,
    n: b.aes.length,
    mae: r3(mean(b.aes)),
  }));

  return {
    season,
    updatedAt: new Date().toISOString(),
    scope: 'World Class + Open Class',
    summary,
    daily,
    perCorps,
    perDivision,
    perEra,
    leadTime,
    histogram,
    events,
    eras: ERA_FLIPS,
  };
};
