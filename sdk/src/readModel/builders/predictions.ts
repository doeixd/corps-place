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

// The latest saved prediction summary for one event (unhydrated). Returns null
// when no saved run exists.
export const buildLatestPredictionSummary = async (
  db: Client,
  eventSlug: string,
  season = '2026'
): Promise<LatestPredictionRow | null> => {
  const result = await db.execute({
    sql: `
      SELECT *
      FROM model_event_prediction_runs
      WHERE season = ?
        AND event_slug = ?
      ORDER BY predicted_at DESC
      LIMIT 1
    `,
    args: [season, eventSlug],
  });
  const run = result.rows[0] as any;
  if (!run) return null;
  const payload = JSON.parse(String(run.payload_json));
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
