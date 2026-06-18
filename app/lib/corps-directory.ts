import { createClient, type Client } from '@libsql/client';
import { Context, Effect, Layer, Schema } from 'effect';
import * as path from 'node:path';
import {
  buildCorpsBySlug,
  buildCorpsByKeys,
  buildCorpsDirectory,
  buildCorpsSeasonScores,
  CORPS_DIVISIONS,
  type CorpsDetail,
  type CorpsDivision,
  type CorpsSeasonPoint,
  type CorpsSummary,
} from '@sdk/src/readModel/builders/corps.js';
import {
  readCorpsByKeys,
  readCorpsBySlug,
  readCorpsDirectory,
  readCorpsSeasonScores,
} from '@sdk/src/readModel/readers.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';

export { CORPS_DIVISIONS };
export type { CorpsDetail, CorpsDivision, CorpsSeasonPoint, CorpsSummary };

export class CorpsDirectoryDataError extends Schema.TaggedErrorClass<CorpsDirectoryDataError>()(
  'CorpsDirectoryDataError',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

// Resolved lazily (not at module top level) so importing this server module is
// browser-safe in the Vite dev client bundle (node:path/process are externalized
// there). Only invoked from server-side Service methods.
let _dbUrl: string | undefined;
const dbUrl = () =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ??
    `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`);

// One shared, long-lived libsql client per process (see event-prediction-api).
let sharedDb: Client | null = null;
const getDb = () => (sharedDb ??= createClient({ url: dbUrl() }));

const withDb = <A, E>(use: (db: Client) => Effect.Effect<A, E>) =>
  Effect.suspend(() => use(getDb()));

// ── Read path: read-model lookup (READ_MODEL_PLAN §8) with builder fallback ──
const corpsDataError = (message: string) => (cause: unknown) =>
  new CorpsDirectoryDataError({ message, details: String(cause) });

const readOrBuild = <A>(
  message: string,
  read: (db: Client) => Promise<A>,
  build: (db: Client) => Promise<A>
) =>
  Effect.suspend(() =>
    readModelEnabled()
      ? Effect.tryPromise({ try: () => read(getReadModelClient()), catch: corpsDataError(message) })
      : Effect.tryPromise({ try: () => build(getDb()), catch: corpsDataError(message) })
  );

const listCorpsRows = () =>
  readOrBuild('Could not load the corps directory.', readCorpsDirectory, buildCorpsDirectory);

const seasonScoresForSlug = (slug: string, season = '2026') =>
  readOrBuild(
    'Could not load the corps season scores.',
    (db) => readCorpsSeasonScores(db, slug),
    (db) => buildCorpsSeasonScores(db, slug, season)
  );

// corpsByKeys looks up specific corps_keys (prediction/schedule corps) for their
// directory row (logo/link/class chip). In production the big DB isn't present, so
// read from rm_corps (covers every directory corps); fall back to the builder
// (big DB) in dev. Corps outside the directory are rare and degrade to no row.
const corpsByKeys = (corpsKeys: readonly string[]) =>
  readOrBuild(
    'Could not load corps by keys.',
    (db) => readCorpsByKeys(db, corpsKeys),
    (db) => buildCorpsByKeys(db, corpsKeys)
  );

const corpsBySlug = (slug: string) =>
  readOrBuild(
    'Could not load the corps.',
    (db) => readCorpsBySlug(db, slug),
    (db) => buildCorpsBySlug(db, slug)
  );

const makeCorpsDirectoryService = Effect.gen(function* () {
  const listCorps = Effect.fn('CorpsDirectoryService.listCorps')(function* () {
    return yield* listCorpsRows();
  });

  const getCorps = Effect.fn('CorpsDirectoryService.getCorps')(function* (slug: string) {
    return yield* corpsBySlug(slug.trim().toLowerCase());
  });

  const getSeasonScores = Effect.fn('CorpsDirectoryService.getSeasonScores')(function* (
    slug: string
  ) {
    return yield* seasonScoresForSlug(slug);
  });

  const getCorpsByKeys = Effect.fn('CorpsDirectoryService.getCorpsByKeys')(function* (
    corpsKeys: readonly string[]
  ) {
    return yield* corpsByKeys(corpsKeys);
  });

  return { listCorps, getCorps, getSeasonScores, getCorpsByKeys };
});

export class CorpsDirectoryService extends Context.Service<
  CorpsDirectoryService,
  Effect.Success<typeof makeCorpsDirectoryService>
>()('CorpsDirectoryService') {}

export const CorpsDirectoryServiceLive = Layer.effect(
  CorpsDirectoryService,
  makeCorpsDirectoryService
);
