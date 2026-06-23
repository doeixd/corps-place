/**
 * Fantasy DCI SQL layers (migration plan §3.1).
 *
 * Two `effect/unstable/sql` `SqlClient`s, each under its OWN service tag so they
 * coexist in one context (the default `SqlClient` tag can only hold one):
 *
 *  - `ContributionsSql` — writable, over the durable `contributions.db`. It wraps
 *    the EXISTING `getContributionsDb()` singleton via the libsql `liveClient`
 *    config, so the whole process keeps one client, one PRAGMA + DDL bootstrap,
 *    and one WAL writer (no double-init race with the legacy server-fns during
 *    the strangler). The Effect client is caller-owned here and is NOT closed by
 *    the layer.
 *  - `ScoreSql` — read-only, over `dci-relational.db`. Its own managed client.
 *    NEVER write to it (the scoring pool + prior-season ranking are read-only).
 *
 * Services `yield*` the tag they need (`const sql = yield* ContributionsSql`) and
 * use `sql\`…\`` templates (`sql<Row>` returns `Row[]` in v4).
 *
 * SERVER-ONLY — imported only by services / RPC handlers / route boundaries.
 */
import { Context, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { LibsqlClient } from '@effect/sql-libsql';
import { durableStorageStatus, getContributionsDb } from '@/lib/contributions-db';
import { StorageUnavailable } from './errors';

// ---------------------------------------------------------------------------
// service tags — distinct so both SqlClients live in the same context
// ---------------------------------------------------------------------------

export class ContributionsSql extends Context.Service<ContributionsSql, SqlClient.SqlClient>()(
  'FantasyContributionsSql'
) {}

// Note: the read-only score DB (dci-relational.db) is still accessed via
// `score-db.ts`'s plain libsql client (wrapped in `Effect.promise` by the
// services). A dedicated `ScoreSql` SqlClient tag was prototyped here but never
// wired — removed to avoid implying a capability that doesn't exist. Migrate the
// score reads onto a SqlClient later if/when they need transactions or tracing.

// ---------------------------------------------------------------------------
// ContributionsSql — wraps the shared getContributionsDb() client
// ---------------------------------------------------------------------------

// Each Live layer builds a libsql `SqlClient` under the default tag, then remaps
// it onto the custom tag via `Layer.effect(tag, SqlClient.SqlClient)`.
export const ContributionsSqlLive = Layer.unwrap(
  Effect.gen(function* () {
    // getContributionsDb() runs the once-per-process PRAGMAs + DDL bootstrap and
    // hands back the long-lived client; we reuse it as a caller-owned liveClient.
    const liveClient = yield* Effect.promise(() => getContributionsDb());
    return Layer.effect(ContributionsSql, SqlClient.SqlClient).pipe(
      Layer.provide(LibsqlClient.layer({ liveClient }))
    );
  })
);

// ---------------------------------------------------------------------------
// durable-storage guard (I-7) — fail closed before any write
// ---------------------------------------------------------------------------

/**
 * Succeeds only when the contributions DB sits on writable durable storage;
 * otherwise fails with `StorageUnavailable`. Provide this to write services so a
 * missing `/data` volume surfaces as a typed error instead of silent data loss.
 */
export const requireDurableStorage: Effect.Effect<void, StorageUnavailable> = Effect.suspend(() => {
  const status = durableStorageStatus();
  return status.ready
    ? Effect.void
    : Effect.fail(new StorageUnavailable({ reason: status.reason }));
});
