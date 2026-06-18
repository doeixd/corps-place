import { createClient, type Client } from '@libsql/client';
import { Context, Effect, Layer, Schema } from 'effect';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { sdkChildEnv } from '@/lib/sdk-process';
import { todayYmd } from '@/lib/date';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import {
  buildAllEvents,
  buildCompetitionSlugForSeasonEvent,
  buildEventAbout,
  buildEventBasic,
  buildEventBySeasonAndSlug,
  buildEventBySlug,
  buildEventSchedule,
  buildEventSeasonOptions,
  buildEventSlugsForCorps,
  buildEventsForSeason,
  type EventDirectoryRow,
  type EventScheduleRow,
  type EventSeasonOption,
} from '@sdk/src/readModel/builders/events.js';
import { buildCorpsAppearanceResults } from '@sdk/src/readModel/builders/corps.js';
import {
  readAllEvents,
  readCompetitionSlugForSeasonEvent,
  readCorpsAppearanceEventIds,
  readCorpsAppearanceResults,
  readEventAbout,
  readEventBasic,
  readEventBySeasonAndSlug,
  readEventBySlug,
  readEventSchedule,
  readEventSeasonOptions,
  readEventsByIds,
  readEventsForSeason,
} from '@sdk/src/readModel/readers.js';

export type { EventDirectoryRow, EventScheduleRow, EventSeasonOption };

export class EventDirectoryDataError extends Schema.TaggedErrorClass<EventDirectoryDataError>()(
  'EventDirectoryDataError',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

export class EventDirectoryRefreshError extends Schema.TaggedErrorClass<EventDirectoryRefreshError>()(
  'EventDirectoryRefreshError',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

export type EventDirectoryRefreshRun = {
  refresh_id: string;
  season: string;
  status: 'running' | 'success' | 'failed';
  started_at: string;
  finished_at: string | null;
  event_count: number | null;
  stdout: string | null;
  stderr: string | null;
  error_message: string | null;
};

// Resolved lazily (not at module top level) so importing this server module is
// browser-safe in the Vite dev client bundle (node:path/process are externalized
// there). Only invoked from server-side Service methods.
let _sdkDir: string | undefined;
const sdkDir = () => (_sdkDir ??= path.resolve(process.cwd(), 'sdk'));
let _dbUrl: string | undefined;
const dbUrl = () =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(sdkDir(), 'dci-relational.db')}`);
let _progressDbUrl: string | undefined;
const progressDbUrl = () =>
  (_progressDbUrl ??=
    process.env.EVENT_PROGRESS_DB_URL ?? `file:${path.resolve(sdkDir(), 'event-progress.db')}`);

let sharedDb: Client | null = null;
const getDb = () => (sharedDb ??= createClient({ url: dbUrl() }));

let sharedProgressDb: Client | null = null;
const getProgressDb = () => (sharedProgressDb ??= createClient({ url: progressDbUrl() }));

const withDb = <A, E>(use: (db: Client) => Effect.Effect<A, E>) =>
  Effect.suspend(() => use(getDb()));

const withProgressDb = <A, E>(use: (db: Client) => Effect.Effect<A, E>) =>
  Effect.suspend(() => use(getProgressDb()));

// Read-model fast path (READ_MODEL_PLAN §8): when READ_MODEL_DB_URL is set, page
// reads come from the tiny precomputed read-model.db via indexed lookups; when
// unset (dev / missing artifact) they fall back to the shared builders against
// the big DB. Both share one definition so they can't drift (verified by
// verifyReadModel.ts). The shared client reconnects after a re-emit.
const withReadDb = <A, E>(use: (db: Client) => Effect.Effect<A, E>) =>
  Effect.suspend(() => use(getReadModelClient()));

const ensureEventDirectoryTables = (db: Client) =>
  Effect.tryPromise({
    try: () =>
      db.execute(`
      CREATE TABLE IF NOT EXISTS event_directory_refresh_runs (
        refresh_id TEXT PRIMARY KEY,
        season TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        event_count INTEGER,
        stdout TEXT,
        stderr TEXT,
        error_message TEXT
      )
    `),
    catch: (cause) =>
      new EventDirectoryDataError({
        message: 'Could not ensure event refresh log table.',
        details: String(cause),
      }),
  }).pipe(Effect.asVoid);

const startRefreshRun = (db: Client, refreshId: string, season: string, startedAt: string) =>
  Effect.tryPromise({
    try: () =>
      db.execute({
        sql: `
        INSERT INTO event_directory_refresh_runs (refresh_id, season, status, started_at)
        VALUES (?, ?, 'running', ?)
      `,
        args: [refreshId, season, startedAt],
      }),
    catch: (cause) =>
      new EventDirectoryDataError({
        message: 'Could not save event refresh start.',
        details: String(cause),
      }),
  }).pipe(Effect.asVoid);

const finishRefreshRun = (
  db: Client,
  input: {
    refreshId: string;
    status: 'success' | 'failed';
    eventCount?: number;
    stdout?: string;
    stderr?: string;
    errorMessage?: string;
  }
) =>
  Effect.tryPromise({
    try: () =>
      db.execute({
        sql: `
        UPDATE event_directory_refresh_runs
        SET status = ?,
            finished_at = ?,
            event_count = ?,
            stdout = ?,
            stderr = ?,
            error_message = ?
        WHERE refresh_id = ?
      `,
        args: [
          input.status,
          new Date().toISOString(),
          input.eventCount ?? null,
          input.stdout ?? null,
          input.stderr ?? null,
          input.errorMessage ?? null,
          input.refreshId,
        ],
      }),
    catch: (cause) =>
      new EventDirectoryDataError({
        message: 'Could not save event refresh completion.',
        details: String(cause),
      }),
  }).pipe(Effect.asVoid);

const appendRefreshRunOutput = (
  db: Client,
  refreshId: string,
  stream: 'stdout' | 'stderr',
  chunk: string
) =>
  Effect.tryPromise({
    try: () =>
      db.execute({
        sql: `
        UPDATE event_directory_refresh_runs
        SET ${stream} = COALESCE(${stream}, '') || ?
        WHERE refresh_id = ?
      `,
        args: [chunk, refreshId],
      }),
    catch: (cause) =>
      new EventDirectoryDataError({
        message: 'Could not append event refresh output.',
        details: String(cause),
      }),
  }).pipe(Effect.asVoid);

const latestRefreshRun = (db: Client, season: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await db.execute({
        sql: `
          SELECT *
          FROM event_directory_refresh_runs
          WHERE season = ?
          ORDER BY started_at DESC
          LIMIT 1
        `,
        args: [season],
      });
      return result.rows[0] as unknown as EventDirectoryRefreshRun | undefined;
    },
    catch: (cause) =>
      new EventDirectoryDataError({
        message: 'Could not load latest event refresh run.',
        details: String(cause),
      }),
  });

const refreshRunById = (db: Client, refreshId: string) =>
  Effect.tryPromise({
    try: async () => {
      const result = await db.execute({
        sql: `
          SELECT *
          FROM event_directory_refresh_runs
          WHERE refresh_id = ?
          LIMIT 1
        `,
        args: [refreshId],
      });
      return result.rows[0] as unknown as EventDirectoryRefreshRun | undefined;
    },
    catch: (cause) =>
      new EventDirectoryDataError({
        message: 'Could not load event refresh run.',
        details: String(cause),
      }),
  });

const runCommand = (cmd: string, args: string[], cwd: string) =>
  Effect.callback<{ stdout: string; stderr: string }, EventDirectoryRefreshError>((resume) => {
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
            new EventDirectoryRefreshError({
              message: `2026 event refresh failed with exit code ${code}.`,
              details: { stdout, stderr },
            })
          )
        );
      }
    });
    child.on('error', (error) => {
      resume(
        Effect.fail(
          new EventDirectoryRefreshError({
            message: '2026 event refresh failed to start.',
            details: String(error),
          })
        )
      );
    });
  });

const updateRefreshInBackground = async (
  refreshId: string,
  status: 'success' | 'failed',
  eventCount: number | null,
  errorMessage?: string
) => {
  await getProgressDb().execute({
    sql: `
      UPDATE event_directory_refresh_runs
      SET status = ?,
          finished_at = ?,
          event_count = ?,
          error_message = ?
      WHERE refresh_id = ?
    `,
    args: [status, new Date().toISOString(), eventCount, errorMessage ?? null, refreshId],
  });
};

const appendRefreshOutputInBackground = async (
  refreshId: string,
  stream: 'stdout' | 'stderr',
  chunk: string
) => {
  await getProgressDb().execute({
    sql: `
      UPDATE event_directory_refresh_runs
      SET ${stream} = COALESCE(${stream}, '') || ?
      WHERE refresh_id = ?
    `,
    args: [chunk, refreshId],
  });
};

const count2026EventsInBackground = async () => {
  const result = await getDb().execute({
    sql: "SELECT COUNT(*) AS count FROM events WHERE season = '2026' OR year = '2026' OR start_date LIKE '2026%'",
  });
  return Number((result.rows[0] as any)?.count ?? 0);
};

const readRefreshOutputInBackground = async (refreshId: string) => {
  const result = await getProgressDb().execute({
    sql: `
      SELECT stdout, stderr
      FROM event_directory_refresh_runs
      WHERE refresh_id = ?
      LIMIT 1
    `,
    args: [refreshId],
  });
  const row = result.rows[0] as { stdout?: string | null; stderr?: string | null } | undefined;
  return `${row?.stdout ?? ''}\n${row?.stderr ?? ''}`;
};

const classifyRefreshCompletion = (
  code: number | null,
  eventCount: number | null,
  output: string
) => {
  if (code !== 0) {
    return {
      status: 'failed' as const,
      errorMessage: `2026 event refresh failed with exit code ${code}.`,
    };
  }

  const legacyApiFailure =
    /Failed to ingest season 2026|DciNetworkError|UnknownException|Legacy API ingest|API ingest/i.test(
      output
    );
  if ((eventCount ?? 0) === 0) {
    return {
      status: 'failed' as const,
      errorMessage: legacyApiFailure
        ? 'Refresh loaded 0 events. The DCI legacy API path appears unavailable; use the website/cache source.'
        : 'Refresh completed but loaded 0 events. DCI may be blocking direct website fetches; use Browserbase or an existing cached DB.',
    };
  }

  return { status: 'success' as const, errorMessage: undefined };
};

const defaultRefreshSource = () => (process.env.BROWSERBASE_API_KEY ? 'browserbase' : 'website');

const spawnRefreshInBackground = (refreshId: string) => {
  const child = spawn(
    'npx',
    [
      '--yes',
      'tsx',
      'scripts/seasonUpdateWorkflow.ts',
      '--season',
      '2026',
      '--source',
      defaultRefreshSource(),
      '--as-of-date',
      todayYmd(),
      '--skip-recaps',
      '--skip-ml',
    ],
    {
      cwd: sdkDir(),
      env: sdkChildEnv(),
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  child.stdout?.on('data', (chunk) => {
    void appendRefreshOutputInBackground(refreshId, 'stdout', String(chunk)).catch(() => {});
  });
  child.stderr?.on('data', (chunk) => {
    void appendRefreshOutputInBackground(refreshId, 'stderr', String(chunk)).catch(() => {});
  });
  child.on('exit', (code) => {
    void (async () => {
      const count = await count2026EventsInBackground().catch(() => null);
      const output = await readRefreshOutputInBackground(refreshId).catch(() => '');
      const completion = classifyRefreshCompletion(code, count, output);
      await updateRefreshInBackground(refreshId, completion.status, count, completion.errorMessage);
    })().catch(() => {});
  });
  child.on('error', (error) => {
    void updateRefreshInBackground(
      refreshId,
      'failed',
      null,
      `2026 event refresh failed to start: ${String(error)}`
    ).catch(() => {});
  });
};

// ── Read path: read-model lookup (fast) with builder fallback ────────────────
// The SQL + JS post-processing lives in @sdk/src/readModel/builders/events.ts so
// the emitter, the read-model readers, and this service share one definition
// (READ_MODEL_PLAN §0,§5,§8). readOrBuild picks the read-model when
// READ_MODEL_DB_URL is set, else runs the builder against the big DB.
const eventDataError = (message: string) => (cause: unknown) =>
  new EventDirectoryDataError({ message, details: String(cause) });

const readOrBuild = <A>(
  message: string,
  read: (db: Client) => Promise<A>,
  build: (db: Client) => Promise<A>
) =>
  readModelEnabled()
    ? withReadDb((db) => Effect.tryPromise({ try: () => read(db), catch: eventDataError(message) }))
    : withDb((db) => Effect.tryPromise({ try: () => build(db), catch: eventDataError(message) }));

const eventAboutForSlug = (slug: string) =>
  readOrBuild(
    `Could not load about text for ${slug}.`,
    (db) => readEventAbout(db, slug),
    (db) => buildEventAbout(db, slug)
  );

const eventScheduleForSlug = (slug: string) =>
  readOrBuild(
    `Could not load schedule for ${slug}.`,
    (db) => readEventSchedule(db, slug),
    (db) => buildEventSchedule(db, slug)
  );

const listEventsForSeason = (season: string) =>
  readOrBuild(
    `Could not load ${season} event directory.`,
    (db) => readEventsForSeason(db, season),
    (db) => buildEventsForSeason(db, season)
  );

const listAllEvents = (eventSlugs?: readonly string[]) =>
  readOrBuild(
    'Could not load the all-seasons event directory.',
    (db) => readAllEvents(db, eventSlugs),
    (db) => buildAllEvents(db, eventSlugs)
  );

const eventBasicBySlug = (slug: string) =>
  readOrBuild(
    `Could not load basic event info for ${slug}.`,
    (db) => readEventBasic(db, slug),
    (db) => buildEventBasic(db, slug)
  );

const eventBySlug = (slug: string) =>
  readOrBuild(
    `Could not load event ${slug}.`,
    (db) => readEventBySlug(db, slug),
    (db) => buildEventBySlug(db, slug)
  );

const eventBySeasonAndSlug = (season: string, slug: string) =>
  readOrBuild(
    `Could not load event ${season}/${slug}.`,
    (db) => readEventBySeasonAndSlug(db, season, slug),
    (db) => buildEventBySeasonAndSlug(db, season, slug)
  );

const eventSeasonOptionsForSlug = (slug: string) =>
  readOrBuild(
    `Could not load related seasons for ${slug}.`,
    (db) => readEventSeasonOptions(db, slug),
    (db) => buildEventSeasonOptions(db, slug)
  );

const competitionSlugForSeasonEvent = (season: string, slug: string) =>
  readOrBuild(
    `Could not resolve competition for ${season}/${slug}.`,
    (db) => readCompetitionSlugForSeasonEvent(db, season, slug),
    (db) => buildCompetitionSlugForSeasonEvent(db, season, slug)
  );

/** A corps's result at one appearance — total score + overall place. */
export type AppearanceResult = { total: number | null; place: number | null };

// A corps's per-appearance results keyed by the card key (event_id ?? slug), so
// the corps profile can join them to its appearance cards. Read-model path: the
// reader is already keyed by event_id. Fallback: map the builder's event_slug
// results to the card key via the same all-events rows the appearances use.
const corpsAppearanceResultsByEvent = (
  slug: string
): Effect.Effect<Record<string, AppearanceResult>> => {
  const load = readModelEnabled()
    ? withReadDb((db) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await readCorpsAppearanceResults(db, slug);
            const out: Record<string, AppearanceResult> = {};
            for (const r of rows) out[r.event_id] = { total: r.total, place: r.place };
            return out;
          },
          catch: eventDataError(`Could not load appearance results for ${slug}.`),
        })
      )
    : withDb((db) =>
        Effect.tryPromise({
          try: async () => {
            const norm = slug.trim().toLowerCase();
            const [slugs, results] = await Promise.all([
              buildEventSlugsForCorps(db, norm),
              buildCorpsAppearanceResults(db, norm),
            ]);
            if (slugs.size === 0) return {};
            const events = await buildAllEvents(db, Array.from(slugs));
            const keyBySlug = new Map(events.map((e) => [e.slug, String(e.event_id ?? e.slug)]));
            const out: Record<string, AppearanceResult> = {};
            for (const r of results) {
              const key = keyBySlug.get(r.event_slug);
              if (key) out[key] = { total: r.total, place: r.place };
            }
            return out;
          },
          catch: eventDataError(`Could not load appearance results for ${slug}.`),
        })
      );
  // The per-appearance result is an optional annotation — never fail the corps
  // page over it. Notably, `rm_corps_appearance_results` won't exist on a
  // read-model emitted before this feature, so if the code deploys ahead of the
  // read-model publish the SELECT 404s; degrade to "no results" until it catches up.
  return load.pipe(Effect.orElseSucceed(() => ({}) as Record<string, AppearanceResult>));
};

// Corps appearances: read-model stores corps_slug → event_id; the builder
// resolves alias names then filters the all-events query. Compose accordingly.
const corpsAppearanceEvents = (slug: string) =>
  readModelEnabled()
    ? withReadDb((db) =>
        Effect.tryPromise({
          try: async () => {
            const ids = await readCorpsAppearanceEventIds(db, slug);
            return ids.length === 0 ? [] : await readEventsByIds(db, ids);
          },
          catch: eventDataError(`Could not load appearances for ${slug}.`),
        })
      )
    : withDb((db) =>
        Effect.tryPromise({
          try: async () => {
            const slugs = await buildEventSlugsForCorps(db, slug.trim().toLowerCase());
            return slugs.size === 0 ? [] : await buildAllEvents(db, Array.from(slugs));
          },
          catch: eventDataError(`Could not load appearances for ${slug}.`),
        })
      );

// Note: DB clients and node:child_process are treated as infrastructure here.
// In a stricter setup we would have DatabaseService + ProcessRunnerService layers.
const makeEventDirectoryService = Effect.gen(function* () {
  const list2026Events = Effect.fn('EventDirectoryService.list2026Events')(function* () {
    return yield* listEventsForSeason('2026');
  });

  const eventSchedule = Effect.fn('EventDirectoryService.eventSchedule')(function* (slug: string) {
    return yield* eventScheduleForSlug(slug);
  });

  const eventAbout = Effect.fn('EventDirectoryService.eventAbout')(function* (slug: string) {
    return yield* eventAboutForSlug(slug);
  });

  const getEvent = Effect.fn('EventDirectoryService.getEvent')(function* (slug: string) {
    return yield* eventBySlug(slug);
  });

  const getEventBasic = Effect.fn('EventDirectoryService.getEventBasic')(function* (slug: string) {
    return yield* eventBasicBySlug(slug);
  });

  const getEventForSeason = Effect.fn('EventDirectoryService.getEventForSeason')(function* (
    season: string,
    slug: string
  ) {
    return yield* eventBySeasonAndSlug(season, slug);
  });

  const competitionSlugForSeason = Effect.fn('EventDirectoryService.competitionSlugForSeason')(
    function* (season: string, slug: string) {
      return yield* competitionSlugForSeasonEvent(season, slug);
    }
  );

  const eventSeasonOptions = Effect.fn('EventDirectoryService.eventSeasonOptions')(function* (
    slug: string
  ) {
    return yield* eventSeasonOptionsForSlug(slug);
  });

  const listAllSeasonEvents = Effect.fn('EventDirectoryService.listAllSeasonEvents')(function* () {
    return yield* listAllEvents();
  });

  // Events a corps appears in, as directory rows. Chronological, newest season
  // first (the all-events ordering).
  const corpsAppearances = Effect.fn('EventDirectoryService.corpsAppearances')(function* (
    slug: string
  ) {
    return yield* corpsAppearanceEvents(slug);
  });

  // Per-appearance results (place + total) for the corps profile's cards, keyed
  // by the appearance card key (event_id ?? slug).
  const corpsAppearanceResults = Effect.fn('EventDirectoryService.corpsAppearanceResults')(
    function* (slug: string) {
      return yield* corpsAppearanceResultsByEvent(slug);
    }
  );

  const latest2026Refresh = Effect.fn('EventDirectoryService.latest2026Refresh')(function* () {
    return yield* withProgressDb((db) =>
      ensureEventDirectoryTables(db).pipe(Effect.flatMap(() => latestRefreshRun(db, '2026')))
    );
  });

  const get2026Refresh = Effect.fn('EventDirectoryService.get2026Refresh')(function* (
    refreshId: string
  ) {
    return yield* withProgressDb((db) =>
      ensureEventDirectoryTables(db).pipe(Effect.flatMap(() => refreshRunById(db, refreshId)))
    );
  });

  const start2026Refresh = Effect.fn('EventDirectoryService.start2026Refresh')(function* () {
    return yield* withProgressDb((db) =>
      Effect.gen(function* () {
        yield* ensureEventDirectoryTables(db);
        const refreshId = randomUUID();
        const startedAt = new Date().toISOString();
        yield* startRefreshRun(db, refreshId, '2026', startedAt);
        yield* appendRefreshRunOutput(
          db,
          refreshId,
          'stdout',
          `Starting 2026 event refresh at ${startedAt}\n`
        );
        spawnRefreshInBackground(refreshId);
        const refresh = yield* refreshRunById(db, refreshId);
        return refresh!;
      })
    );
  });

  const refresh2026Events = Effect.fn('EventDirectoryService.refresh2026Events')(function* () {
    return yield* withProgressDb((db) =>
      Effect.gen(function* () {
        yield* ensureEventDirectoryTables(db);
        const refreshId = randomUUID();
        const startedAt = new Date().toISOString();
        yield* startRefreshRun(db, refreshId, '2026', startedAt);
        const command = yield* runCommand(
          'npx',
          [
            '--yes',
            'tsx',
            'scripts/seasonUpdateWorkflow.ts',
            '--season',
            '2026',
            '--source',
            defaultRefreshSource(),
            '--as-of-date',
            todayYmd(),
            '--skip-recaps',
            '--skip-ml',
          ],
          sdkDir()
        ).pipe(
          Effect.tapError((error) =>
            finishRefreshRun(db, {
              refreshId,
              status: 'failed',
              errorMessage: error.message,
              stdout:
                typeof error.details === 'object' &&
                error.details != null &&
                'stdout' in error.details
                  ? String((error.details as any).stdout)
                  : undefined,
              stderr:
                typeof error.details === 'object' &&
                error.details != null &&
                'stderr' in error.details
                  ? String((error.details as any).stderr)
                  : undefined,
            }).pipe(Effect.ignore)
          )
        );
        // Count from the big DB (just refreshed) — the read-model isn't
        // re-emitted until ingest's final step, so it would be stale here.
        const events = yield* withDb((eventDb) =>
          Effect.tryPromise({
            try: () => buildEventsForSeason(eventDb, '2026'),
            catch: eventDataError('Could not load 2026 event directory.'),
          })
        );
        const completion = classifyRefreshCompletion(
          0,
          events.length,
          `${command.stdout}\n${command.stderr}`
        );
        yield* finishRefreshRun(db, {
          refreshId,
          status: completion.status,
          eventCount: events.length,
          stdout: command.stdout,
          stderr: command.stderr,
          errorMessage: completion.errorMessage,
        });
        return {
          refresh_id: refreshId,
          event_count: events.length,
          events,
        };
      })
    );
  });

  return {
    list2026Events,
    getEvent,
    getEventBasic,
    getEventForSeason,
    competitionSlugForSeason,
    eventSchedule,
    eventAbout,
    eventSeasonOptions,
    listAllSeasonEvents,
    corpsAppearances,
    corpsAppearanceResults,
    latest2026Refresh,
    get2026Refresh,
    start2026Refresh,
    refresh2026Events,
  };
});

export class EventDirectoryService extends Context.Service<
  EventDirectoryService,
  Effect.Success<typeof makeEventDirectoryService>
>()('EventDirectoryService') {}

export const EventDirectoryServiceLive = Layer.effect(
  EventDirectoryService,
  makeEventDirectoryService
);
