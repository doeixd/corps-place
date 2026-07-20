import { createClient, type Client } from '@libsql/client';
import { Context, Effect, Layer, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sdkChildEnv } from '@/lib/sdk-process';
import {
  ensureEventPredictionTables,
  eventPredictionInputSignature,
  type ModelEventPredictionRun,
} from '@sdk/src/training/v9EventPredictionDb.js';
import { V9_RAW_STATIC_DIM } from '@sdk/src/training/v9FeatureModes.js';
import { findLatestV9SubcaptionModelDir } from '@sdk/src/training/v9ModelPaths.js';

import type { RecapRow } from '@/lib/prediction-scenario';

/**
 * A prediction recap row as consumed by the app — typed on the fields the UI
 * and server-fn boundary actually read (RecapRow's knowns + corps_key); the
 * model's many extra fields flow through via RecapRow's index signature.
 * This is the type that catches loader/shard row-shape drift.
 */
export interface PredictionRecapRow extends RecapRow {
  corps_key: string;
  // `any`, not RecapRow's `unknown`: createServerFn's serializable-return
  // constraint rejects unknown-valued index signatures.
  [key: string]: any;
}

/**
 * The prediction summary served to routes (== summarizePayload / the frozen
 * rm_event_prediction summary_json). Scalar fields + recap rows are typed;
 * the model-internal sub-objects stay loose on purpose — the app treats them
 * as opaque display blobs and their shape belongs to the model pipeline.
 */
export interface EventPredictionSummary {
  source: 'cache' | 'generated';
  prediction_id: string;
  generated_at?: string;
  model_dir?: string;
  event?: Record<string, any> | null;
  competition?: Record<string, any> | null;
  readiness?: Record<string, any> | null;
  input_audit?: Record<string, any> | null;
  model_metadata?: Record<string, any> | null;
  builder_version?: string;
  caveats: any[];
  recap: PredictionRecapRow[];
}

export type EventPredictionRequest = {
  slug: string;
  force?: boolean;
  refresh?: boolean;
  modelDir?: string;
  mode?: string;
  division?: string;
  percentThrough?: string;
};

export type ParsedPredictionQuery = Omit<EventPredictionRequest, 'slug'>;

export class EventPredictionBadRequest extends Schema.TaggedErrorClass<EventPredictionBadRequest>()(
  'EventPredictionBadRequest',
  {
    message: Schema.String,
  }
) {}

export class EventPredictionNotFound extends Schema.TaggedErrorClass<EventPredictionNotFound>()(
  'EventPredictionNotFound',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

export class EventPredictionConflict extends Schema.TaggedErrorClass<EventPredictionConflict>()(
  'EventPredictionConflict',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

export class EventPredictionGenerationFailed extends Schema.TaggedErrorClass<EventPredictionGenerationFailed>()(
  'EventPredictionGenerationFailed',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

export class EventPredictionDataError extends Schema.TaggedErrorClass<EventPredictionDataError>()(
  'EventPredictionDataError',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

export type EventPredictionError =
  | EventPredictionBadRequest
  | EventPredictionNotFound
  | EventPredictionConflict
  | EventPredictionGenerationFailed
  | EventPredictionDataError;

// Resolved lazily (not at module top level) so importing this server module is
// safe in the Vite dev client bundle, where `node:path`/`process` are externalized
// and a top-level `path.resolve`/`process.cwd()` call would throw. These are only
// ever invoked from server-side Service methods.
let _sdkDir: string | undefined;
const sdkDir = () => (_sdkDir ??= path.resolve(process.cwd(), 'sdk'));
let _dbUrl: string | undefined;
const dbUrl = () =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(sdkDir(), 'dci-relational.db')}`);
const CURRENT_EVENT_PREDICTION_BUILDER_VERSION = 'v10-event-prediction-all-age-baselines';

const allowedModes = new Set([
  'auto',
  'as_of_show_date',
  'preseason_forecast',
  'panel_unknown',
  'lineup_unknown',
]);

export const eventPredictionJsonResponse = (body: unknown, init?: ResponseInit) => {
  // Merge via Headers so any HeadersInit form (object, Headers, or [k,v][])
  // is handled — object-spreading the array/Headers forms silently drops them.
  // Caller-supplied headers override the defaults.
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  return new Response(JSON.stringify(body, null, 2), { ...init, headers });
};

const boolParam = (url: URL, key: string) => {
  const value = url.searchParams.get(key);
  return value === '1' || value === 'true';
};

const validate2026EventSlug = (slug: string) =>
  Effect.gen(function* () {
    const normalized = slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,180}$/.test(normalized)) {
      return yield* Effect.fail(new EventPredictionBadRequest({ message: 'Invalid event slug.' }));
    }
    return normalized;
  });

export const parsePredictionSearchParams = (url: URL) =>
  Effect.gen(function* () {
    const mode = url.searchParams.get('mode') ?? undefined;
    if (mode && !allowedModes.has(mode)) {
      return yield* Effect.fail(
        new EventPredictionBadRequest({ message: `Invalid mode '${mode}'.` })
      );
    }
    const percentThrough =
      url.searchParams.get('percentThrough') ??
      url.searchParams.get('percent_through') ??
      undefined;
    if (percentThrough != null && !Number.isFinite(Number(percentThrough))) {
      return yield* Effect.fail(
        new EventPredictionBadRequest({ message: 'percentThrough must be numeric.' })
      );
    }
    return {
      force: boolParam(url, 'force'),
      refresh: boolParam(url, 'refresh'),
      modelDir: url.searchParams.get('modelDir') ?? url.searchParams.get('model_dir') ?? undefined,
      mode,
      division: url.searchParams.get('division') ?? undefined,
      percentThrough,
    } satisfies ParsedPredictionQuery;
  });

const classifyGenerationFailure = (
  stdout: string,
  stderr: string,
  fallbackMessage: string
): EventPredictionError => {
  const text = `${stderr}\n${stdout}`;
  const details = { stdout, stderr };
  if (/Event '.+' not found for 2026/i.test(text)) {
    return new EventPredictionNotFound({ message: 'Event not found for 2026.', details });
  }
  if (/Cannot predict without lineup rows/i.test(text)) {
    return new EventPredictionConflict({
      message:
        'Event lineup is missing; refresh or ingest event-page lineup data before prediction.',
      details,
    });
  }
  if (/No V9 model found/i.test(text)) {
    return new EventPredictionGenerationFailed({
      message: 'No V9 prediction model was found.',
      details,
    });
  }
  return new EventPredictionGenerationFailed({ message: fallbackMessage, details });
};

const runCommand = (cmd: string, args: string[], cwd: string) =>
  Effect.callback<{ stdout: string; stderr: string }, EventPredictionError>((resume) => {
    const child = spawn(cmd, args, {
      cwd,
      env: sdkChildEnv(),
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resume(Effect.succeed({ stdout, stderr }));
      } else {
        resume(
          Effect.fail(
            classifyGenerationFailure(
              stdout,
              stderr,
              `Prediction generation failed with exit code ${code}.`
            )
          )
        );
      }
    });
    child.on('error', (error) => {
      resume(
        Effect.fail(
          new EventPredictionGenerationFailed({
            message: 'Prediction generation failed to start.',
            details: String(error),
          })
        )
      );
    });
  });

// One shared client per process. libsql clients are safe to reuse and are meant
// to be long-lived; opening/closing a connection on every read added avoidable
// latency. (Writes happen out-of-band via the generation child process.)
let sharedDb: Client | null = null;
const getDb = () => (sharedDb ??= createClient({ url: dbUrl() }));

const withDb = <A, E>(use: (db: Client) => Effect.Effect<A, E>) =>
  Effect.suspend(() => use(getDb()));

const resolveRequestedModelDir = (modelDir: string | undefined) => {
  if (!modelDir || modelDir === 'latest') {
    return findLatestV9SubcaptionModelDir(path.resolve(sdkDir(), 'models', 'v9_subcaption_fixed'));
  }
  return path.isAbsolute(modelDir) ? modelDir : path.resolve(sdkDir(), modelDir);
};

const modelFileFingerprint = (modelDir: string | undefined) => {
  if (!modelDir) return undefined;
  const modelPath = path.join(modelDir, 'model.json');
  const weightsPath = path.join(modelDir, 'weights.bin');
  if (!fs.existsSync(modelPath)) return undefined;
  const modelStat = fs.statSync(modelPath);
  const weightsStat = fs.existsSync(weightsPath) ? fs.statSync(weightsPath) : undefined;
  return createHash('sha256')
    .update(
      JSON.stringify({
        model_json_mtime_ms: Math.round(modelStat.mtimeMs),
        model_json_size: modelStat.size,
        weights_mtime_ms: weightsStat ? Math.round(weightsStat.mtimeMs) : null,
        weights_size: weightsStat?.size ?? null,
      })
    )
    .digest('hex');
};

const modelStaticDimFromManifest = (modelDir: string | undefined) => {
  if (!modelDir) return undefined;
  const modelPath = path.join(modelDir, 'model.json');
  if (!fs.existsSync(modelPath)) return undefined;
  const manifest = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
  const layers = manifest?.modelTopology?.config?.layers ?? [];
  const staticLayer = layers.find(
    (layer: any) => layer?.name === 'static' || layer?.config?.name === 'static'
  );
  const shape = staticLayer?.config?.batch_input_shape;
  const dim = Array.isArray(shape) ? Number(shape.at(-1)) : undefined;
  return Number.isFinite(dim) ? dim : undefined;
};

const currentJudgeAssignmentCount = async (db: Client, competitionSlug: string | undefined) => {
  if (!competitionSlug) return 0;
  const mapPath = path.resolve(sdkDir(), 'src', 'training', 'judgeIndexMap.json');
  const judgeMap = fs.existsSync(mapPath)
    ? (JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, number>)
    : {};
  const result = await db
    .execute({
      sql: `
      SELECT normalized_caption_name, judge_id
      FROM judge_assignments
      WHERE competition_slug = ?
        AND judge_id IS NOT NULL
        AND judge_id NOT LIKE '%unknown%'
    `,
      args: [competitionSlug],
    })
    .catch(() => ({ rows: [] as any[] }));
  return new Set(
    result.rows
      .filter((row: any) => (judgeMap[row.judge_id] ?? 0) > 0)
      .map((row: any) => row.normalized_caption_name)
  ).size;
};

const currentSameSeasonHistoryCount = async (
  db: Client,
  season: string,
  targetDate: string | undefined
) => {
  if (!targetDate) return 0;
  const result = await db
    .execute({
      sql: `
      SELECT COUNT(*) AS count
      FROM ml_sequence_rows_v9_subcaption
      WHERE season = ?
        AND competition_date < ?
    `,
      args: [season, targetDate],
    })
    .catch(() => ({ rows: [] as any[] }));
  return Number((result.rows[0] as any)?.count ?? 0);
};

const loadEventInfo = async (db: Client, eventSlug: string) => {
  const result = await db
    .execute({
      sql: `
      SELECT event_id, name, slug, edt_start_time, location_city, location_state, venue_city, venue_state,
             timezone, buy_tickets, buy_tickets_text, live_stream_link, event_image_thumb,
             ticket_watermark, start_date, end_date, web_start_time, notes_general,
             min_ticket_price, max_ticket_price, event_image, ticketing_map_image,
             meta_description, meta_title, notes_lineup_times, event_name, description,
             season, year, start_time, street_map_image
      FROM events
      WHERE slug = ?
      LIMIT 1
    `,
      args: [eventSlug],
    })
    .catch(() => ({ rows: [] as any[] }));
  return result.rows[0] as any | undefined;
};

const hydratePayloadEventInfo = async (db: Client, eventSlug: string, payload: any) => {
  const eventInfo = await loadEventInfo(db, eventSlug);
  if (!eventInfo) return payload;
  return {
    ...payload,
    event: {
      ...eventInfo,
      ...payload?.event,
      event_image: payload?.event?.event_image ?? eventInfo.event_image,
      event_image_thumb: payload?.event?.event_image_thumb ?? eventInfo.event_image_thumb,
      ticket_watermark: payload?.event?.ticket_watermark ?? eventInfo.ticket_watermark,
      buy_tickets: payload?.event?.buy_tickets ?? eventInfo.buy_tickets,
      buy_tickets_text: payload?.event?.buy_tickets_text ?? eventInfo.buy_tickets_text,
      live_stream_link: payload?.event?.live_stream_link ?? eventInfo.live_stream_link,
      description: payload?.event?.description ?? eventInfo.description,
      meta_description: payload?.event?.meta_description ?? eventInfo.meta_description,
      notes_general: payload?.event?.notes_general ?? eventInfo.notes_general,
      notes_lineup_times: payload?.event?.notes_lineup_times ?? eventInfo.notes_lineup_times,
      min_ticket_price: payload?.event?.min_ticket_price ?? eventInfo.min_ticket_price,
      max_ticket_price: payload?.event?.max_ticket_price ?? eventInfo.max_ticket_price,
      venue_city: payload?.event?.venue_city ?? eventInfo.venue_city,
      venue_state: payload?.event?.venue_state ?? eventInfo.venue_state,
    },
  };
};

// The prediction tables are created once per process; the DDL is idempotent but
// re-running it on every read adds avoidable round-trips.
let tablesEnsured: Promise<void> | null = null;
const ensureTablesOnce = (db: Client) => {
  if (!tablesEnsured) {
    tablesEnsured = Promise.resolve(ensureEventPredictionTables(db)).catch((cause) => {
      tablesEnsured = null; // let the next call retry instead of caching the failure
      throw cause;
    });
  }
  return tablesEnsured;
};

// Which model to serve (mirrors the read-model builder flag). Default 'final2';
// PREDICTION_MODEL=v10 flips to the clean-v10 ensemble; 'any' = newest-run-wins.
const PREDICTION_MODEL = (process.env.PREDICTION_MODEL ?? 'final2').toLowerCase();
const PREDICTION_MODEL_FILTER =
  PREDICTION_MODEL === 'v10.5'
    ? "AND model_dir LIKE '%fieldpace-recal%'" // v10.5 = field-pace ensemble + division recal
    : PREDICTION_MODEL === 'v10'
      ? "AND (model_dir LIKE '%clean-v10%' OR model_dir LIKE '%ensemble%')"
      : PREDICTION_MODEL === 'final2'
        ? "AND model_dir LIKE '%final2%'"
        : '';

const latestSavedPrediction = (db: Client, eventSlug: string, hydrate = true) =>
  Effect.tryPromise({
    try: async (): Promise<{ run: ModelEventPredictionRun; payload: any } | undefined> => {
      await ensureTablesOnce(db);
      const pick = async (filter: string) =>
        db.execute({
          sql: `SELECT * FROM model_event_prediction_runs
                WHERE season = '2026' AND event_slug = ? ${filter}
                ORDER BY predicted_at DESC LIMIT 1`,
          args: [eventSlug],
        });
      // Prefer the flagged model; fall back to newest-any so nothing goes blank. A
      // flagged run with EMPTY predictions (e.g. an all-age/SoundSport event V10 can't
      // score) is treated as no-run so we fall through to final2 rather than blanking.
      const nonEmpty = (r: any) => {
        try {
          return (JSON.parse(String(r?.payload_json))?.predictions?.length ?? 0) > 0;
        } catch {
          return false;
        }
      };
      let result = PREDICTION_MODEL_FILTER ? await pick(PREDICTION_MODEL_FILTER) : await pick('');
      if (PREDICTION_MODEL_FILTER && !nonEmpty(result.rows[0])) result = await pick('');
      const run = result.rows[0] as unknown as ModelEventPredictionRun | undefined;
      if (!run) return undefined;
      const parsed = JSON.parse(String((result.rows[0] as any).payload_json));
      // Hydration overlays fresh event metadata (tickets/images) with an extra
      // query — skip it for the fast read path that doesn't need those fields.
      const payload = hydrate ? await hydratePayloadEventInfo(db, eventSlug, parsed) : parsed;
      return { run, payload };
    },
    catch: (cause) =>
      new EventPredictionDataError({
        message: 'Could not read cached event prediction.',
        details: String(cause),
      }),
  });

const currentPredictionInputSignature = (
  db: Client,
  eventSlug: string,
  payload: any,
  modelDir: string | undefined,
  request: EventPredictionRequest
) =>
  Effect.tryPromise({
    try: async () => {
      const event = payload?.event;
      if (!event?.slug || !event?.start_date) return undefined;
      const mode =
        request.mode && request.mode !== 'auto'
          ? request.mode
          : (payload?.readiness?.mode ?? 'auto');
      const percentThrough =
        request.percentThrough != null
          ? Number(request.percentThrough)
          : Number(payload?.readiness?.percent_through ?? 0);
      const division = request.division ?? 'auto';
      const competitionSlug = payload?.competition?.slug;
      const judgeAssignments = await currentJudgeAssignmentCount(db, competitionSlug);
      const season = String(
        payload?.event?.season ?? payload?.event?.year ?? event.start_date.slice(0, 4)
      );
      const sameSeasonHistory = await currentSameSeasonHistoryCount(db, season, event.start_date);
      const lineup = await db
        .execute({
          sql: `
          SELECT corps_key, unit_name, performance_order, time, division_name
          FROM scored_event_lineup
          WHERE event_slug = ?
          ORDER BY COALESCE(performance_order, 999), time, unit_name
        `,
          args: [eventSlug],
        })
        .catch(() => ({ rows: [] as any[] }));
      if (lineup.rows.length === 0) return undefined;
      // Use the SAME canonical signature builder the predictor stamps, so the
      // shape can't drift (review Medium #5). same_season_breakdown_prior is
      // false here because the app's regeneration path never passes
      // --same-season-breakdown-prior; previously this field was omitted entirely,
      // which made every otherwise-identical cached prediction look stale.
      return eventPredictionInputSignature({
        eventSlug: event.slug,
        startDate: event.start_date,
        lineup: lineup.rows.map((row: any) => ({
          corps_key: row.corps_key,
          unit_name: row.unit_name,
          order: row.performance_order,
          time: row.time,
          division: row.division_name,
        })),
        modelDir,
        modelFingerprint: modelFileFingerprint(modelDir),
        modelStaticDim: modelStaticDimFromManifest(modelDir),
        featureStaticDim: V9_RAW_STATIC_DIM,
        mode,
        division,
        percentThrough,
        sameSeasonHistory,
        judgeAssignments,
        sameSeasonBreakdownPrior: false,
        builderVersion: CURRENT_EVENT_PREDICTION_BUILDER_VERSION,
      });
    },
    catch: (cause) =>
      new EventPredictionDataError({
        message: 'Could not compute current prediction input signature.',
        details: String(cause),
      }),
  });

const isCachedPredictionFresh = (
  db: Client,
  eventSlug: string,
  cached: { run: ModelEventPredictionRun; payload: any },
  desiredModelDir: string | undefined,
  request: EventPredictionRequest
) =>
  Effect.gen(function* () {
    const savedSignature = cached.payload?.input_signature ?? (cached.run as any).input_signature;
    const savedBuilderVersion =
      cached.payload?.builder_version ?? (cached.run as any).builder_version;
    if (!savedSignature || !savedBuilderVersion) return false;
    if (savedBuilderVersion !== CURRENT_EVENT_PREDICTION_BUILDER_VERSION) return false;
    const currentSignature = yield* currentPredictionInputSignature(
      db,
      eventSlug,
      cached.payload,
      desiredModelDir,
      request
    );
    return currentSignature === savedSignature;
  }).pipe(Effect.catch(() => Effect.succeed(false)));

const generatePrediction = (
  request: Required<Pick<EventPredictionRequest, 'slug'>> & EventPredictionRequest
) => {
  const args = [
    '--yes',
    'tsx',
    'scripts/predictEventRecap.ts',
    '--event',
    request.slug,
    '--season',
    '2026',
    '--save-db',
    '--model-dir',
    request.modelDir ?? 'latest',
  ];

  if (request.refresh) args.push('--refresh');
  if (request.force) args.push('--force-refresh');
  if (request.mode) args.push('--mode', request.mode);
  if (request.division) args.push('--division', request.division);
  if (request.percentThrough) args.push('--percent-through', request.percentThrough);

  return runCommand('npx', args, sdkDir());
};

const summarizePayload = (
  payload: any,
  source: 'cache' | 'generated',
  run?: ModelEventPredictionRun
): EventPredictionSummary => ({
  source,
  prediction_id:
    run?.prediction_id ??
    `${payload?.event?.slug ?? 'unknown'}:${payload?.generated_at ?? 'unknown'}`,
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

// Read a pre-generated prediction summary from the read-model
// (rm_event_prediction; summary_json == exactly summarizePayload()). Shared by
// the loader's cache lookup and getOrCreate so prod SSR never needs the
// relational DB. Deliberately uses only already-imported modules
// (createClient/fs/path) — do NOT add a top-level import for this: under
// effect@4 beta the resulting chunk reorder runs Schema.TaggedErrorClass()
// before Schema is initialized ("not a function"). Resolves the A/B active
// slot like read-model-db does.
const readRmPredictionSummary = (rmUrl: string, slug: string) =>
  Effect.tryPromise({
    try: async () => {
      const base = rmUrl.replace(/^file:/, '');
      let active = base;
      try {
        const dir = path.dirname(base);
        const stem = path.basename(base).replace(/\.db$/i, '');
        const slot = fs.readFileSync(path.join(dir, `${stem}.active`), 'utf8').trim();
        if (slot === 'a' || slot === 'b') {
          const f = path.join(dir, `${stem}.${slot}.db`);
          if (fs.existsSync(f)) active = f;
        }
      } catch {
        // no pointer (legacy single-file layout) — use the base path
      }
      const client = createClient({ url: `file:${active}` });
      try {
        const r = await client.execute({
          sql: `SELECT summary_json FROM rm_event_prediction WHERE event_slug = ? LIMIT 1`,
          args: [slug],
        });
        const row = r.rows[0] as { summary_json?: string } | undefined;
        return row?.summary_json
          ? (JSON.parse(String(row.summary_json)) as EventPredictionSummary)
          : null;
      } finally {
        client.close?.();
      }
    },
    catch: (e) =>
      new EventPredictionDataError({
        message: `read-model prediction read failed: ${String(e)}`,
      }),
  });

const makeEventPredictionService = Effect.gen(function* () {
  const getOrCreate2026EventPrediction = Effect.fn(
    'EventPredictionService.getOrCreate2026EventPrediction'
  )(function* (request: EventPredictionRequest) {
    yield* Effect.annotateCurrentSpan('slug', request.slug);
    yield* Effect.annotateCurrentSpan('force', request.force);
    yield* Effect.annotateCurrentSpan('refresh', request.refresh);
    const slug = yield* validate2026EventSlug(request.slug);

    // Read-model fast path (prod / read-only serve): predictions are
    // pre-generated into rm_event_prediction by the emitter, with summary_json
    // = exactly summarizePayload(). When the read-model is the active source and
    // this isn't an explicit regenerate, serve the frozen summary and NEVER spawn
    // the ML generator (the serving host has no relational DB / model — generation
    // lives only on the builder). Falls through only on a genuine miss.
    const rmUrl = process.env.READ_MODEL_DB_URL;
    if (rmUrl && !request.force && !request.refresh) {
      const summary = yield* readRmPredictionSummary(rmUrl, slug);
      if (summary) return { ...summary, source: 'cache' as const };
    }

    return yield* withDb((db) =>
      Effect.gen(function* () {
        const desiredModelDir = resolveRequestedModelDir(request.modelDir);
        if (!request.force && !request.refresh) {
          const cached = yield* latestSavedPrediction(db, slug);
          if (
            cached &&
            (yield* isCachedPredictionFresh(db, slug, cached, desiredModelDir, request))
          ) {
            return summarizePayload(cached.payload, 'cache', cached.run);
          }
        }

        // Snapshot the latest saved run before generating so we can detect
        // whether this run actually produced a *new* prediction.
        const prior = yield* latestSavedPrediction(db, slug, false);
        const priorAt = prior?.run.predicted_at ?? null;

        // The SDK child can exit non-zero *after* it has already committed the
        // prediction to SQLite — e.g. a throw during teardown (db.close()
        // racing the server's open connection) or a dangling tfjs handle. That
        // surfaced to users as "generation failed" even though a reload then
        // found the saved row. So capture the result rather than failing
        // immediately, and prefer a freshly-saved prediction over the error.
        const generation = yield* Effect.result(
          generatePrediction({
            ...request,
            slug,
            modelDir: desiredModelDir ?? request.modelDir ?? 'latest',
          })
        );

        const cached = yield* latestSavedPrediction(db, slug);
        const producedFresh = cached != null && cached.run.predicted_at !== priorAt;
        if (producedFresh) {
          return summarizePayload(cached.payload, 'generated', cached.run);
        }
        // No new prediction landed — surface the real generation error if there
        // was one, otherwise report the (rarer) "succeeded but nothing saved".
        if (generation._tag === 'Failure') {
          return yield* Effect.fail(generation.failure);
        }
        return cached
          ? summarizePayload(cached.payload, 'generated', cached.run)
          : yield* Effect.fail(
              new EventPredictionDataError({
                message: 'Prediction generation completed, but no saved prediction was found.',
              })
            );
      })
    );
  });

  // Cache-only lookup: returns a fresh cached prediction if one exists, else
  // null — never generates. Used by the route loader so navigation is instant
  // (SSR the cache when present, otherwise let the client kick off generation
  // behind a loader) instead of blocking on the heavy ML op.
  const getCached2026EventPrediction = Effect.fn(
    'EventPredictionService.getCached2026EventPrediction'
  )(function* (request: EventPredictionRequest) {
    yield* Effect.annotateCurrentSpan('slug', request.slug);
    const slug = yield* validate2026EventSlug(request.slug);
    // Read-model fast path first — on prod this is the ONLY available source
    // (no relational DB on the serving host), and it's what makes SSR'd
    // prediction pages instant. A miss with the read-model active returns null
    // rather than touching the (absent) relational DB.
    const rmUrl = process.env.READ_MODEL_DB_URL;
    if (rmUrl) {
      const summary = yield* readRmPredictionSummary(rmUrl, slug).pipe(
        Effect.catch(() => Effect.succeed(null))
      );
      return summary ? { ...summary, source: 'cache' as const } : null;
    }
    return yield* withDb((db) =>
      Effect.gen(function* () {
        // Fast read for instant display: return the latest saved prediction as-is
        // and skip both the freshness check (3 extra queries + model-file hashing)
        // and event-info hydration (another query). Deciding whether a cache is
        // stale and needs regenerating is `getOrCreate`'s job — via Refresh.
        const cached = yield* latestSavedPrediction(db, slug, false);
        return cached ? summarizePayload(cached.payload, 'cache', cached.run) : null;
      })
    );
  });

  return {
    getOrCreate2026EventPrediction,
    getCached2026EventPrediction,
    parsePredictionSearchParams,
  };
});

export class EventPredictionService extends Context.Service<
  EventPredictionService,
  Effect.Success<typeof makeEventPredictionService>
>()('EventPredictionService') {}

export const EventPredictionServiceLive = Layer.effect(
  EventPredictionService,
  makeEventPredictionService
);

export const errorStatus = (error: EventPredictionError) => {
  switch (error._tag) {
    case 'EventPredictionBadRequest':
      return 400;
    case 'EventPredictionNotFound':
      return 404;
    case 'EventPredictionConflict':
      return 409;
    default:
      return 500;
  }
};
