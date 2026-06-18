// Force-set one corps' logo from a specific image URL, caching the bytes through
// MediaService (so the app serves a durable copy via /api/media). Use when the
// auto-discovered/placeholder logo should be replaced with a known-good image
// (e.g. an archived Wayback copy of a defunct corps' original logo).
//
// Usage:
//   npx tsx scripts/overrideCorpsLogo.ts --key glassmen --url "https://…" [--apply]
//
// Dry-run by default. Overwrites corps.corps_logo unconditionally on --apply.

import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';
import { MediaService, makeMediaServiceLayer } from '../src/mediaService.js';
import {
  resolveRelationalDbUrl,
  resolveMediaCacheDbUrl,
  cacheCorpsLogo,
} from '../src/scriptSupport.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const getArg = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const corpsKey = getArg('--key');
const logoUrl = getArg('--url');
if (!corpsKey || !logoUrl) {
  console.error('Usage: overrideCorpsLogo.ts --key <corpsKey> --url <logoUrl> [--apply]');
  process.exit(2);
}

const dbUrl = resolveRelationalDbUrl();
const mediaDbUrl = resolveMediaCacheDbUrl();

const program = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const media = yield* (MediaService);

  const rows = yield* (
    sql<{ name: string; corps_logo: string | null }>`
      SELECT name, corps_logo FROM corps WHERE corps_key = ${corpsKey!} LIMIT 1
    `
  );
  if (rows.length === 0) {
    console.error(`corps_key not found: ${corpsKey}`);
    return;
  }
  console.log(`\nOverride logo ${APPLY ? '(APPLY)' : '(dry-run)'} — ${rows[0].name}`);
  console.log(`  from: ${rows[0].corps_logo ?? '(none)'}`);
  console.log(`  to  : ${logoUrl}`);
  if (!APPLY) {
    console.log('\nDry-run only — re-run with --apply to write.');
    return;
  }
  const result = yield* (
    cacheCorpsLogo(media, sql, {
      corpsKey: corpsKey!,
      name: rows[0].name,
      logoUrl: logoUrl!,
      via: 'override-logo',
    })
  );
  console.log(`\n✅ cached ${result.format} ${result.byteLength}B + set corps_logo`);
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeMediaServiceLayer({ cacheDbUrl: mediaDbUrl })),
    Effect.provide(LibsqlClient.layer({ url: dbUrl }))
  )
)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[overrideCorpsLogo] ERROR', err);
    process.exit(1);
  });
