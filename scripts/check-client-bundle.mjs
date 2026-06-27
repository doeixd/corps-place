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
const FORBIDDEN = [
  'node:fs',
  'node:crypto',
  'LibsqlClient',
  'LibsqlDialect',
  '@libsql/client',
  'contributions-db',
  'MediaServiceLive',
  'JobsServiceLive',
];

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
  for (const marker of FORBIDDEN) if (txt.includes(marker)) hits.push(`${f} → ${marker}`);
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
