import { createClient, type Client } from '@libsql/client';
import { Context, Effect, Layer, Schema } from 'effect';
import * as path from 'node:path';
import { buildEventRecap } from '@sdk/src/readModel/builders/recap.js';
import { buildEventFullRecap } from '@sdk/src/readModel/builders/fullRecap.js';
import { readEventRecap, readEventFullRecap } from '@sdk/src/readModel/readers.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';

export class EventRecapDataError extends Schema.TaggedErrorClass<EventRecapDataError>()(
  'EventRecapDataError',
  {
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }
) {}

// Resolved lazily (not at module top level) so importing this server module is
// browser-safe in the Vite dev client bundle (node:path/process are externalized
// there). Only invoked from server-side Service methods.
let _sdkDir: string | undefined;
const sdkDir = () => (_sdkDir ??= path.resolve(process.cwd(), 'sdk'));
let _dbUrl: string | undefined;
const dbUrl = () =>
  (_dbUrl ??=
    process.env.DCI_RELATIONAL_DB_URL ?? `file:${path.resolve(sdkDir(), 'dci-relational.db')}`);

let sharedDb: Client | null = null;
const getDb = () => (sharedDb ??= createClient({ url: dbUrl() }));

const makeEventRecapService = Effect.gen(function* () {
  const getEventRecap = Effect.fn('EventRecapService.getEventRecap')(function* (slug: string) {
    return yield* Effect.suspend(() =>
      Effect.tryPromise({
        try: () =>
          readModelEnabled()
            ? readEventRecap(getReadModelClient(), slug)
            : buildEventRecap(getDb(), slug),
        catch: (cause) =>
          new EventRecapDataError({
            message: 'Could not load the event recap.',
            details: String(cause),
          }),
      })
    );
  });

  // Full DCI-style recap (per-judge + subcaption breakdown + penalties).
  const getEventFullRecap = Effect.fn('EventRecapService.getEventFullRecap')(function* (
    slug: string
  ) {
    return yield* Effect.suspend(() =>
      Effect.tryPromise({
        try: () =>
          readModelEnabled()
            ? readEventFullRecap(getReadModelClient(), slug)
            : buildEventFullRecap(getDb(), slug),
        catch: (cause) =>
          new EventRecapDataError({
            message: 'Could not load the full event recap.',
            details: String(cause),
          }),
      })
    );
  });

  return { getEventRecap, getEventFullRecap };
});

export class EventRecapService extends Context.Service<
  EventRecapService,
  Effect.Success<typeof makeEventRecapService>
>()('EventRecapService') {}

export const EventRecapServiceLive = Layer.effect(EventRecapService, makeEventRecapService);
