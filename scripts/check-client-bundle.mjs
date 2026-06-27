// Build-time guard against the worst failure mode in this app: server-only code
// (Effect SQL / libsql / node builtins / the jobs+media service layers) getting
// bundled into the CLIENT chunks. When that happens the whole site goes blank on
// the client while SSR + health checks stay green — historically caught only by a
// manual `grep` before each deploy. This runs in the Docker builder stage right
// after `npm run build`, so a leak FAILS the build instead of shipping silently.
//
// Markers are things that must NEVER appear in a client chunk. (`effect` core is
// client-safe and intentionally NOT listed; `@effect/sql*`, the Live layers, and
// node builtins are not.)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ASSETS = '.output/public/assets';
// App-specific server markers — these names exist ONLY in this app's server layer,
// so finding them in ANY client chunk means a real leak (Effect SQL / DB / service
// Live layers reached the browser).
const APP_MARKERS = [
  'LibsqlClient',
  'LibsqlDialect',
  'getContributionsDb',
  'contributions-db',
  'MediaServiceLive',
  'JobsServiceLive',
];
// Node builtins / the raw libsql client appear as dead-branch strings inside some
// third-party ESM chunks, so they only signal a leak in the MAIN entry chunk (which
// is historically clean of them — that's where the past `node:fs` leak landed).
const MAIN_ONLY_MARKERS = ['node:fs', 'node:crypto', '@libsql/client', '@effect/sql-libsql'];

let files;
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
} catch (err) {
  console.error(`[bundle-check] cannot read ${ASSETS}: ${err?.message ?? err}`);
  process.exit(1);
}

const hits = [];
for (const f of files) {
  const txt = readFileSync(path.join(ASSETS, f), 'utf8');
  const markers = /^main-/.test(f) ? [...APP_MARKERS, ...MAIN_ONLY_MARKERS] : APP_MARKERS;
  for (const marker of markers) if (txt.includes(marker)) hits.push(`${f} → ${marker}`);
}

if (hits.length) {
  console.error('[bundle-check] FAIL — server-only code leaked into the client bundle:');
  for (const h of hits) console.error(`  ${h}`);
  console.error(
    '\nA client component is value-importing a server module. Use `import type` for\n' +
      'server modules in client components, keep service Live layers inside createServerFn\n' +
      'handlers, and avoid module-scope helpers that close over them.'
  );
  process.exit(1);
}

console.log(`[bundle-check] ok — scanned ${files.length} client chunks, no server markers.`);
