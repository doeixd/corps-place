import { Context, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { LibsqlClient } from '@effect/sql-libsql';
import { getContributionsDb, durableStorageStatus } from '@/lib/contributions-db';
import { StorageUnavailable } from './errors';

// SqlClient over contributions.db for the profile-ownership service. Mirrors
// app/lib/jobs/jobs-sql.ts (same shared client + durable-storage guard).

export class ProfileSql extends Context.Service<ProfileSql, SqlClient.SqlClient>()('ProfileSql') {}

export const ProfileSqlLive = Layer.unwrap(
  Effect.gen(function* () {
    const liveClient = yield* Effect.promise(() => getContributionsDb());
    return Layer.effect(ProfileSql, SqlClient.SqlClient).pipe(
      Layer.provide(LibsqlClient.layer({ liveClient }))
    );
  })
);

export const requireDurableStorage: Effect.Effect<void, StorageUnavailable> = Effect.suspend(() => {
  const status = durableStorageStatus();
  return status.ready
    ? Effect.void
    : Effect.fail(new StorageUnavailable({ reason: status.reason }));
});
