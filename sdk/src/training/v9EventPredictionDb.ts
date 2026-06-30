import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
import { V9_CAPTIONS } from './v9Baselines.js';

/**
 * Canonical event-prediction input signature — the SINGLE source of the hashed
 * shape, shared by the predictor (which stamps it on a saved run) and the app's
 * freshness check (which recomputes it from current DB state). Keeping one
 * builder prevents the two from drifting: previously the app omitted
 * `same_season_breakdown_prior`, so an otherwise-identical cached prediction
 * always looked stale (review Medium #5). Field order/spelling here is the
 * contract — change it and both sides change together (bump the builder version).
 */
export interface EventPredictionSignatureInput {
  eventSlug: string;
  startDate: string;
  lineup: ReadonlyArray<{
    corps_key: unknown;
    unit_name: unknown;
    order: unknown;
    time: unknown;
    division: unknown;
  }>;
  // modelDir/modelStaticDim may be undefined on the app's freshness path (model
  // manifest not resolvable); JSON.stringify drops undefined keys, matching the
  // predictor side which always passes concrete values.
  modelDir: string | undefined;
  modelFingerprint: string | undefined;
  modelStaticDim: number | undefined;
  featureStaticDim: number;
  mode: string;
  division: string;
  percentThrough: number;
  sameSeasonHistory: number;
  judgeAssignments: number;
  sameSeasonBreakdownPrior: boolean;
  builderVersion: string;
}

export const eventPredictionInputSignature = (input: EventPredictionSignatureInput): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        event_slug: input.eventSlug,
        start_date: input.startDate,
        lineup: input.lineup.map((row) => ({
          corps_key: row.corps_key,
          unit_name: row.unit_name,
          order: row.order,
          time: row.time,
          division: row.division,
        })),
        model_dir: input.modelDir,
        model_fingerprint: input.modelFingerprint,
        model_static_dim: input.modelStaticDim,
        feature_static_dim: input.featureStaticDim,
        mode: input.mode,
        division: input.division,
        percent_through: Number(input.percentThrough.toFixed(3)),
        same_season_history: input.sameSeasonHistory,
        judge_assignments: input.judgeAssignments,
        same_season_breakdown_prior: input.sameSeasonBreakdownPrior,
        builder_version: input.builderVersion,
      })
    )
    .digest('hex');

export type ModelEventPredictionRun = {
  prediction_id: string;
  event_slug: string;
  competition_slug: string | null;
  season: string;
  predicted_at: string;
  model_dir: string;
  mode: string;
  input_signature?: string | null;
  builder_version?: string | null;
};

export type ModelEventPredictionActualRow = {
  corps_key: string;
  corps_name: string;
  division_name: string;
  rank: number;
  total_score: number;
  GE1: number | null;
  GE2: number | null;
  VP: number | null;
  VA: number | null;
  CG: number | null;
  MB: number | null;
  MA: number | null;
  MP: number | null;
};

type EventPredictionOutput = {
  generated_at: string;
  model_dir: string;
  event: {
    slug: string;
    season?: string | number | null;
    year?: string | number | null;
    start_date?: string | null;
  };
  competition?: { slug?: string | null } | null;
  readiness: {
    mode: string;
    percent_through: number;
    lineup_rows: number;
    matched_corps_keys: number;
    judge_assignments: number;
  };
  predictions: Array<Record<string, unknown>>;
  input_signature?: string;
  builder_version?: string;
  model_metadata?: unknown;
  input_audit?: unknown;
};

const captionKeys = [...V9_CAPTIONS];

export async function ensureEventPredictionTables(db: Client) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS model_event_prediction_runs (
      prediction_id TEXT PRIMARY KEY,
      event_slug TEXT NOT NULL,
      competition_slug TEXT,
      season TEXT NOT NULL,
      predicted_at TEXT NOT NULL,
      model_dir TEXT NOT NULL,
      mode TEXT NOT NULL,
      percent_through REAL NOT NULL,
      lineup_rows INTEGER NOT NULL,
      matched_corps_keys INTEGER NOT NULL,
      judge_assignments INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS model_event_prediction_rows (
      prediction_id TEXT NOT NULL,
      event_slug TEXT NOT NULL,
      competition_slug TEXT,
      corps_key TEXT,
      corps_name TEXT NOT NULL,
      division_name TEXT,
      predicted_rank INTEGER,
      predicted_total REAL,
      predicted_ge REAL,
      predicted_visual REAL,
      predicted_music REAL,
      predicted_captions_json TEXT NOT NULL,
      template_source TEXT,
      baseline_rank_source TEXT,
      actual_rank INTEGER,
      actual_total REAL,
      actual_ge REAL,
      actual_visual REAL,
      actual_music REAL,
      actual_captions_json TEXT,
      total_error REAL,
      abs_total_error REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (prediction_id, corps_name)
    )
  `);
  await addMissingColumns(db, 'model_event_prediction_runs', {
    division: 'TEXT',
    lineup_rows: 'INTEGER NOT NULL DEFAULT 0',
    matched_corps_keys: 'INTEGER NOT NULL DEFAULT 0',
    judge_assignments: 'INTEGER NOT NULL DEFAULT 0',
    payload_json: "TEXT NOT NULL DEFAULT '{}'",
    updated_at: "TEXT NOT NULL DEFAULT ''",
    readiness_json: "TEXT NOT NULL DEFAULT '{}'",
    metadata_json: "TEXT NOT NULL DEFAULT '{}'",
    output_json: "TEXT NOT NULL DEFAULT '{}'",
    input_signature: 'TEXT',
    builder_version: 'TEXT',
  });
  await addMissingColumns(db, 'model_event_prediction_rows', {
    event_slug: "TEXT NOT NULL DEFAULT ''",
    competition_slug: 'TEXT',
    template_source: 'TEXT',
    baseline_rank_source: 'TEXT',
    updated_at: "TEXT NOT NULL DEFAULT ''",
  });
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_model_event_predictions_event ON model_event_prediction_runs(event_slug, predicted_at)'
  );
  await db.execute(
    'CREATE INDEX IF NOT EXISTS idx_model_event_prediction_rows_event ON model_event_prediction_rows(event_slug, competition_slug)'
  );
}

async function addMissingColumns(db: Client, table: string, columns: Record<string, string>) {
  const info = await db.execute(`PRAGMA table_info(${table})`);
  const existing = new Set(info.rows.map((row: any) => String(row.name)));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
}

export async function saveEventPredictionRun(db: Client, output: EventPredictionOutput) {
  await ensureEventPredictionTables(db);
  const predictedAt = output.generated_at;
  const predictionId = `${output.event.slug}:${predictedAt}`;
  const now = new Date().toISOString();
  const division = String(
    (output.predictions.find((r) => (r as any).division) as any)?.division ?? 'World Class'
  );
  await db.execute({
    sql: `
      INSERT OR REPLACE INTO model_event_prediction_runs (
        prediction_id, event_slug, competition_slug, season, predicted_at, model_dir, mode,
        division, percent_through, lineup_rows, matched_corps_keys, judge_assignments, payload_json, updated_at,
        readiness_json, metadata_json, output_json, input_signature, builder_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      predictionId,
      output.event.slug,
      output.competition?.slug ?? null,
      String(
        output.event.season ?? output.event.year ?? output.event.start_date?.slice(0, 4) ?? ''
      ),
      predictedAt,
      output.model_dir,
      output.readiness.mode,
      division,
      output.readiness.percent_through,
      output.readiness.lineup_rows,
      output.readiness.matched_corps_keys,
      output.readiness.judge_assignments,
      JSON.stringify(output),
      now,
      JSON.stringify(output.readiness),
      JSON.stringify({
        builder_version: output.builder_version ?? null,
        input_signature: output.input_signature ?? null,
        model_metadata: output.model_metadata ?? null,
        input_audit: output.input_audit ?? null,
      }),
      '{}',
      output.input_signature ?? null,
      output.builder_version ?? null,
    ],
  });

  for (const row of output.predictions) {
    if (typeof row.total !== 'number') continue;
    const captions = Object.fromEntries(
      captionKeys.map((caption) => [caption, row[caption] ?? null])
    );
    await db.execute({
      sql: `
        INSERT OR REPLACE INTO model_event_prediction_rows (
          prediction_id, event_slug, competition_slug, corps_key, corps_name, division_name,
          predicted_rank, predicted_total, predicted_ge, predicted_visual, predicted_music,
          predicted_captions_json, template_source, baseline_rank_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        predictionId,
        output.event.slug,
        output.competition?.slug ?? null,
        String(row.corps_key ?? '') || null,
        String(row.corps),
        String(row.division ?? '') || null,
        typeof row.rank === 'number' ? row.rank : null,
        row.total,
        typeof row.GE === 'number' ? row.GE : null,
        typeof row.Visual === 'number' ? row.Visual : null,
        typeof row.Music === 'number' ? row.Music : null,
        JSON.stringify(captions),
        String(row.template_source ?? '') || null,
        String(row.baseline_rank_source ?? '') || null,
        now,
      ],
    });
  }
  return predictionId;
}

export async function latestEventPredictionRun(
  db: Client,
  eventSlug: string,
  predictionId?: string
): Promise<ModelEventPredictionRun | undefined> {
  await ensureEventPredictionTables(db);
  const sql = predictionId
    ? 'SELECT * FROM model_event_prediction_runs WHERE prediction_id = ? LIMIT 1'
    : 'SELECT * FROM model_event_prediction_runs WHERE event_slug = ? ORDER BY predicted_at DESC LIMIT 1';
  const result = await db.execute({ sql, args: [predictionId ?? eventSlug] });
  return result.rows[0] as unknown as ModelEventPredictionRun | undefined;
}

/**
 * All saved prediction runs for an event (newest first). Post-show actuals/error
 * backfill should fill EVERY snapshot, not just the latest — otherwise older
 * snapshots never learn how they actually did, undercutting prediction-history /
 * as-of analysis (review Medium #9). Pass a `predictionId` to scope to one run.
 */
export async function listEventPredictionRuns(
  db: Client,
  eventSlug: string,
  predictionId?: string
): Promise<ModelEventPredictionRun[]> {
  await ensureEventPredictionTables(db);
  const sql = predictionId
    ? 'SELECT * FROM model_event_prediction_runs WHERE prediction_id = ?'
    : 'SELECT * FROM model_event_prediction_runs WHERE event_slug = ? ORDER BY predicted_at DESC';
  const result = await db.execute({ sql, args: [predictionId ?? eventSlug] });
  return result.rows as unknown as ModelEventPredictionRun[];
}

const withAll = (values: Array<number | null>, fn: (values: number[]) => number) =>
  values.every((value) => typeof value === 'number') ? fn(values as number[]) : null;

export const actualCategoriesFromV9Row = (row: ModelEventPredictionActualRow) => ({
  ge: withAll([row.GE1, row.GE2], ([ge1, ge2]) => ge1 + ge2),
  visual: withAll([row.VP, row.VA, row.CG], ([vp, va, cg]) => (vp + va + cg) / 2),
  music: withAll([row.MB, row.MA, row.MP], ([mb, ma, mp]) => (mb + ma + mp) / 2),
});

export async function updateEventPredictionErrors(
  db: Client,
  run: ModelEventPredictionRun,
  actuals: ModelEventPredictionActualRow[],
  normalizeName: (value: string) => string
) {
  await ensureEventPredictionTables(db);
  const now = new Date().toISOString();
  let matched = 0;
  const predictions = await db.execute({
    sql: 'SELECT corps_name, corps_key, predicted_total FROM model_event_prediction_rows WHERE prediction_id = ?',
    args: [run.prediction_id],
  });

  for (const pred of predictions.rows as any[]) {
    const actual = actuals.find(
      (row) =>
        (pred.corps_key && row.corps_key === pred.corps_key) ||
        normalizeName(row.corps_name) === normalizeName(String(pred.corps_name))
    );
    if (!actual) continue;
    matched++;
    const cats = actualCategoriesFromV9Row(actual);
    const captions = Object.fromEntries(
      captionKeys.map((caption) => [caption, (actual as any)[caption] ?? null])
    );
    const error = Number(pred.predicted_total) - Number(actual.total_score);
    await db.execute({
      sql: `
        UPDATE model_event_prediction_rows
        SET actual_rank = ?,
            actual_total = ?,
            actual_ge = ?,
            actual_visual = ?,
            actual_music = ?,
            actual_captions_json = ?,
            total_error = ?,
            abs_total_error = ?,
            updated_at = ?
        WHERE prediction_id = ?
          AND corps_name = ?
      `,
      args: [
        actual.rank,
        actual.total_score,
        cats.ge,
        cats.visual,
        cats.music,
        JSON.stringify(captions),
        error,
        Math.abs(error),
        now,
        run.prediction_id,
        pred.corps_name,
      ],
    });
  }
  return { predicted: predictions.rows.length, actual: actuals.length, matched };
}

export async function summarizeEventPredictionErrors(db: Client, predictionId: string) {
  await ensureEventPredictionTables(db);
  const result = await db.execute({
    sql: `
      SELECT
        COUNT(*) AS matched,
        AVG(abs_total_error) AS mae_total,
        AVG(total_error) AS bias_total,
        MAX(abs_total_error) AS max_abs_total_error
      FROM model_event_prediction_rows
      WHERE prediction_id = ?
        AND actual_total IS NOT NULL
    `,
    args: [predictionId],
  });
  return result.rows[0] as any;
}
