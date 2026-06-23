import { Context, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { LibsqlClient } from '@effect/sql-libsql';
import { getContributionsDb } from '@/lib/contributions-db';
import { StorageUnavailable } from './errors';

export class JobsSql extends Context.Service<JobsSql, SqlClient.SqlClient>()('JobsSql') {}

export const JobsSqlLive = Layer.unwrap(
  Effect.gen(function* () {
    const liveClient = yield* Effect.promise(() => getContributionsDb());
    return Layer.effect(JobsSql, SqlClient.SqlClient).pipe(
      Layer.provide(LibsqlClient.layer({ liveClient }))
    );
  })
);

export const requireDurableStorage: Effect.Effect<void, StorageUnavailable> = Effect.suspend(() => {
  const { durableStorageStatus } = require('@/lib/contributions-db');
  const status = durableStorageStatus();
  return status.ready
    ? Effect.void
    : Effect.fail(new StorageUnavailable({ reason: status.reason }));
});
