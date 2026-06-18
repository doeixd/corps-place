// Auto-extract two brand accent colors per corps from its logo (CORPS_COLORS_PLAN).
// Sibling of flagDarkLogos.ts — same media-cache wiring + two-phase read/write —
// but writes corps.color_primary / color_secondary / color_source='auto'.
//
// The UI derives every per-corps accent (light + dark, chart colors, favorite
// chips) from these two via src/corpsColors.ts. Detection is a heuristic over the
// cached logo bytes (src/logoColors.ts); the color editor is the override
// (color_source='manual', recorded in corps_curated_fields.field='colors').
//
// Usage (run from sdk/):
//   npx tsx scripts/extractCorpsColors.ts            # dry-run report, no writes
//   npx tsx scripts/extractCorpsColors.ts --apply    # write corps.color_*
//   npx tsx scripts/extractCorpsColors.ts --slug mandarins   # inspect one corps

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { createClient } from '@libsql/client';
import * as path from 'node:path';
import { extractLogoColors } from '../src/logoColors.js';
import { FALLBACK_PRIMARY } from '../src/corpsColors.js';

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
  color_primary: string | null;
  color_secondary: string | null;
};

const toBytes = (value: unknown): Uint8Array | null =>
  value instanceof Uint8Array
    ? value
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : null;

const program = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);

  // Idempotent migration: add the color columns if missing (mirrors ensureColumns
  // in relational.ts; tolerated to fail if they already exist). Run even in
  // dry-run so the SELECT below can reference the columns.
  for (const col of ['color_primary TEXT', 'color_secondary TEXT', 'color_source TEXT']) {
    yield* (sql.unsafe(`ALTER TABLE corps ADD COLUMN ${col}`).pipe(Effect.catch(() => Effect.void)));
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
          SELECT corps_key, slug, name, corps_logo, color_primary, color_secondary
          FROM corps
          WHERE corps_logo IS NOT NULL AND length(trim(corps_logo)) > 0 AND slug = ${slugArg}`
      : sql<CorpsRow>`
          SELECT corps_key, slug, name, corps_logo, color_primary, color_secondary
          FROM corps
          WHERE corps_logo IS NOT NULL AND length(trim(corps_logo)) > 0`
  );
  yield* (
    Effect.log(`Evaluating ${rows.length} corps with a logo${slugArg ? ` (slug=${slugArg})` : ''}…`)
  );

  // Curated overrides: corps whose colors were hand-set are left untouched.
  const curatedRows = yield* (
    sql<{ corps_key: string }>`SELECT corps_key FROM corps_curated_fields WHERE field = 'colors'`
  );
  const curatedKeys = new Set(curatedRows.map((r) => r.corps_key));

  type Decision =
    | { kind: 'curated' }
    | { kind: 'missing' }
    | { kind: 'fallback'; corpsKey: string; name: string }
    | { kind: 'extracted'; corpsKey: string; name: string; primary: string; secondary: string | null };

  // Phase 1: read + analyze concurrently (no DB writes — SQLite is single-writer,
  // so writes are serialized in phase 2 to avoid "database is locked").
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
          const colors = yield* (
            Effect.tryPromise(() => extractLogoColors(bytes)).pipe(Effect.catch(() => Effect.succeed(null)))
          );
          // Monochrome / unreadable mark → no brand hue; record the site fallback
          // so the corps still gets a deterministic accent (and isn't retried as
          // "missing" every run).
          if (!colors) {
            if (slugArg) yield* (Effect.log(`  ${row.name}: monochrome → fallback ${FALLBACK_PRIMARY}`));
            return { kind: 'fallback', corpsKey: row.corps_key, name: row.name };
          }
          if (slugArg || row.color_primary !== colors.primary || row.color_secondary !== colors.secondary) {
            yield* (
              Effect.log(
                `  ${row.name.padEnd(34).slice(0, 34)} ${colors.primary}` +
                  (colors.secondary ? ` + ${colors.secondary}` : '') +
                  (row.color_primary ? `  (was ${row.color_primary}${row.color_secondary ? ` + ${row.color_secondary}` : ''})` : '')
              )
            );
          }
          return { kind: 'extracted', corpsKey: row.corps_key, name: row.name, ...colors };
        }),
      { concurrency: 8 }
    )
  );

  const extracted = decisions.filter(
    (d): d is Extract<Decision, { kind: 'extracted' }> => d.kind === 'extracted'
  );
  const fallbacks = decisions.filter(
    (d): d is Extract<Decision, { kind: 'fallback' }> => d.kind === 'fallback'
  );
  const missing = decisions.filter((d) => d.kind === 'missing').length;
  const skippedCurated = decisions.filter((d) => d.kind === 'curated').length;

  // Phase 2: serialized writes (concurrency 1) to avoid SQLite write-lock contention.
  if (APPLY) {
    yield* (
      Effect.forEach(
        extracted,
        (d) =>
          sql`UPDATE corps SET color_primary = ${d.primary}, color_secondary = ${d.secondary}, color_source = 'auto' WHERE corps_key = ${d.corpsKey}`,
        { concurrency: 1, discard: true }
      )
    );
    yield* (
      Effect.forEach(
        fallbacks,
        (d) =>
          sql`UPDATE corps SET color_primary = ${FALLBACK_PRIMARY}, color_secondary = NULL, color_source = 'auto' WHERE corps_key = ${d.corpsKey}`,
        { concurrency: 1, discard: true }
      )
    );
  }

  yield* (
    Effect.log(
      `\n${APPLY ? '' : '[dry-run] '}Summary: extracted=${extracted.length} fallback=${fallbacks.length} ` +
        `no-bytes=${missing} curated-skip=${skippedCurated}`
    )
  );
  if (!APPLY) yield* (Effect.log('\nRe-run with --apply to write corps.color_primary/secondary.'));
});

const SqlLayer = LibsqlClient.layer({ url: RELATIONAL_DB });

Effect.runPromise(program.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error('extractCorpsColors failed:', error);
  process.exitCode = 1;
});
