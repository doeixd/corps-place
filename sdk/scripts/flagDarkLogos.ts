// Detect corps logos that are "primarily dark/grey" (black/grey marks, e.g.
// Mandarins / Cavaliers / Troopers) so the UI can swap in a light-recolored
// variant in dark mode. Sets the derived `corps.corps_logo_dark` flag (0/1).
//
// Detection is a heuristic over the cached logo bytes (sharp pixel stats — see
// src/logoDarkness.ts); the curated-fields table is the override (force
// include/exclude a corps via corps_curated_fields.field = 'corps_logo_dark').
//
// Usage (run from sdk/):
//   npx tsx scripts/flagDarkLogos.ts            # dry-run report, no writes
//   npx tsx scripts/flagDarkLogos.ts --apply    # write corps.corps_logo_dark
//   npx tsx scripts/flagDarkLogos.ts --slug mandarins   # inspect one corps

import { Effect, Layer } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { createClient } from '@libsql/client';
import * as path from 'node:path';
import { analyzeLogoBytes, isDarkLogo } from '../src/logoDarkness.js';

const APPLY = process.argv.includes('--apply');
const slugArg = (() => {
  const i = process.argv.indexOf('--slug');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const RELATIONAL_DB = process.env.RELATIONAL_DB_URL ?? 'file:./dci-relational.db';
const MEDIA_CACHE_DB =
  process.env.MEDIA_CACHE_DB_URL ?? `file:${path.resolve(process.cwd(), 'media-cache.db')}`;

type CorpsRow = {
  corps_key: string;
  slug: string | null;
  name: string;
  corps_logo: string | null;
  corps_logo_dark: number | null;
};

const toBytes = (value: unknown): Uint8Array | null =>
  value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;

const program = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  // Idempotent migration: add the derived flag column if missing (mirrors
  // ensureColumns in relational.ts; tolerated to fail if it already exists).
  if (APPLY) {
    yield* (
      sql.unsafe('ALTER TABLE corps ADD COLUMN corps_logo_dark INTEGER').pipe(
        Effect.catch(() => Effect.void)
      )
    );
  }

  // Separate libsql client for the bytes cache (a different DB file), mirroring
  // how MediaService splits bytes (media-cache.db) from metadata (relational).
  const mediaDb = createClient({ url: MEDIA_CACHE_DB });
  const readLogoBytes = (url: string) =>
    Effect.tryPromise(() =>
      mediaDb.execute({
        sql: 'SELECT bytes FROM media_cache WHERE url = ? LIMIT 1',
        args: [url],
      })
    ).pipe(
      Effect.map((r) => toBytes(r.rows[0]?.bytes)),
      // Cache miss: try a live fetch (DCI asset hosts) so a first run still works.
      Effect.flatMap((cached) =>
        cached
          ? Effect.succeed(cached)
          : Effect.tryPromise(async () => {
              const res = await fetch(url);
              return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
            }).pipe(Effect.catch(() => Effect.succeed(null)))
      ),
      Effect.catch(() => Effect.succeed(null as Uint8Array | null))
    );

  const rows = yield* (
    slugArg
      ? sql<CorpsRow>`
          SELECT corps_key, slug, name, corps_logo, corps_logo_dark
          FROM corps
          WHERE corps_logo IS NOT NULL AND length(trim(corps_logo)) > 0 AND slug = ${slugArg}`
      : sql<CorpsRow>`
          SELECT corps_key, slug, name, corps_logo, corps_logo_dark
          FROM corps
          WHERE corps_logo IS NOT NULL AND length(trim(corps_logo)) > 0`
  );
  yield* (
    Effect.log(
      `Evaluating ${rows.length} corps with a logo${slugArg ? ` (slug=${slugArg})` : ''}…`
    )
  );

  // Curated overrides: corps whose corps_logo_dark was hand-set are left alone.
  const curatedRows = yield* (
    sql<{ corps_key: string }>`
      SELECT corps_key FROM corps_curated_fields WHERE field = 'corps_logo_dark'`
  );
  const curatedKeys = new Set(curatedRows.map((r) => r.corps_key));

  type Decision =
    | { kind: 'curated' }
    | { kind: 'missing' }
    | { kind: 'judged'; corpsKey: string; name: string; dark: boolean; prev: boolean };

  // Phase 1: read + analyze concurrently (IO/CPU bound, no DB writes — SQLite is
  // a single writer, so writes are serialized separately in phase 2 to avoid
  // "database is locked").
  const decisions = yield* (
    Effect.forEach(
      rows,
      (row): Effect.Effect<Decision> =>
        Effect.gen(function* () {
          if (curatedKeys.has(row.corps_key)) return { kind: 'curated' };
          const bytes = yield* (readLogoBytes(row.corps_logo!));
          if (!bytes) {
            if (slugArg) yield* (Effect.log(`  ${row.name}: no bytes for ${row.corps_logo}`));
            return { kind: 'missing' };
          }
          const stats = yield* (
            Effect.tryPromise(() => analyzeLogoBytes(bytes)).pipe(
              Effect.catch(() => Effect.succeed(null))
            )
          );
          if (!stats) return { kind: 'missing' };

          const dark = isDarkLogo(stats);
          const prev = row.corps_logo_dark === 1;
          if (slugArg || dark !== prev) {
            yield* (
              Effect.log(
                `  ${dark ? 'DARK ' : '     '} ${row.name.padEnd(34).slice(0, 34)} ` +
                  `dark=${stats.darkFraction.toFixed(2)} colored=${stats.coloredFraction.toFixed(2)} ` +
                  `lum=${stats.meanLum.toFixed(0)} opaque=${stats.opaqueFraction.toFixed(2)}` +
                  (dark !== prev ? `  (was ${prev ? 1 : 0})` : '')
              )
            );
          }
          return { kind: 'judged', corpsKey: row.corps_key, name: row.name, dark, prev };
        }),
      { concurrency: 8 }
    )
  );

  const judged = decisions.filter((d): d is Extract<Decision, { kind: 'judged' }> => d.kind === 'judged');
  const flaggedNames = judged.filter((d) => d.dark).map((d) => d.name);
  const cleared = judged.filter((d) => !d.dark && d.prev).length;
  const missing = decisions.filter((d) => d.kind === 'missing').length;
  const skippedCurated = decisions.filter((d) => d.kind === 'curated').length;

  // Phase 2: serialized writes (concurrency 1) to avoid SQLite write-lock contention.
  if (APPLY) {
    yield* (
      Effect.forEach(
        judged,
        (d) =>
          sql`UPDATE corps SET corps_logo_dark = ${d.dark ? 1 : 0} WHERE corps_key = ${d.corpsKey}`,
        { concurrency: 1, discard: true }
      )
    );
  }

  yield* (
    Effect.log(
      `\n${APPLY ? '' : '[dry-run] '}Summary: flagged=${flaggedNames.length} cleared=${cleared} ` +
        `no-bytes=${missing} curated-skip=${skippedCurated}`
    )
  );
  if (!slugArg && flaggedNames.length > 0) {
    yield* (Effect.log(`Dark logos: ${flaggedNames.sort().join(', ')}`));
  }
  if (!APPLY) yield* (Effect.log('\nRe-run with --apply to write corps.corps_logo_dark.'));
});

const SqlLayer = LibsqlClient.layer({ url: RELATIONAL_DB });

Effect.runPromise(program.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('flagDarkLogos failed:', error);
  process.exitCode = 1;
});
