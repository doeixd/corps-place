// Scrape, archive, and ingest dci.org corps data (directory classes + profiles).
//
// Usage:
//   npx tsx scripts/scrapeCorps.ts                 # dry-run (default), uses cache
//   npx tsx scripts/scrapeCorps.ts --apply         # write the (guardrailed) changes
//   npx tsx scripts/scrapeCorps.ts --refresh       # bypass the scrape cache
//   npx tsx scripts/scrapeCorps.ts --slug bluecoats# single corps
//
// Fetches through Browserbase (Cloudflare bypass) when BROWSERBASE_API_KEY is
// set, archiving every page (raw + parsed) in corps_page_scrapes for time-travel.
// Ingest is coalescing + guardrailed (see corpsIngest.ts); held overwrites are
// reported, not written. A JSON report is written to results/.

import * as fs from 'node:fs';
import * as path from 'node:path';

// Load BROWSERBASE_API_KEY etc. from the repo-root .env (scripts run from sdk/).
const envPath = path.resolve(process.cwd(), '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import { SqlClient } from '@effect/sql';
import { BrowserbaseServiceLive, BrowserbaseService } from '../src/browserbaseService.js';
import { scrapeCorpsDirectory, scrapeCorpsProfile } from '../src/corpsScraper.js';
import { ensureRelationalSchema } from '../src/relational.js';
import { ingestCorps } from '../src/corpsIngest.js';

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);
const getArg = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const apply = has('--apply');
// Fill-only unless explicitly opted in: existing values are never overwritten
// without --allow-overwrite (they're reported as `held` for review instead).
const allowOverwrite = has('--allow-overwrite');
const refresh = has('--refresh');
const onlySlug = getArg('--slug');

const program = Effect.gen(function* () {
  yield* (ensureRelationalSchema);
  const bb = yield* (BrowserbaseService);
  const fetchHtml = (url: string) => bb.fetchHtml(url);

  // 1) Directory → roster + current classes.
  const dir = yield* (scrapeCorpsDirectory({ fetchHtml, refresh }));
  const slugs = onlySlug ? [onlySlug] : dir.roster.corps.map((c) => c.slug);
  yield* (
    Effect.logInfo(
      `[scrapeCorps] roster ${dir.roster.corps.length} corps; scraping ${slugs.length} profiles (refresh=${refresh})`
    )
  );

  // 2) Profiles.
  let done = 0;
  let cached = 0;
  for (const slug of slugs) {
    const r = yield* (scrapeCorpsProfile(slug, { fetchHtml, refresh }));
    if (r.fromCache) cached++;
    if (++done % 10 === 0) yield* (Effect.logInfo(`  …${done}/${slugs.length}`));
  }
  yield* (Effect.logInfo(`[scrapeCorps] profiles done (cache hits=${cached})`));

  // 3) Safety snapshot: before any write, dump the full corps table to results/
  // for an instant local rollback point (in addition to nightly restic backups).
  fs.mkdirSync('results', { recursive: true });
  if (apply) {
    const sql = yield* (SqlClient.SqlClient);
    const rows = yield* (sql`SELECT * FROM corps`);
    const snap = `results/corps-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.writeFileSync(snap, JSON.stringify(rows));
    console.log(`[scrapeCorps] pre-apply corps snapshot → ${snap} (${rows.length} rows)`);
  }

  // 4) Ingest (coalescing + guardrailed). dry-run unless --apply; fill-only unless
  // --allow-overwrite (overwrites of existing values are otherwise held).
  const s = yield* (ingestCorps({ dryRun: !apply, allowOverwrite }));
  console.log(
    `[scrapeCorps] ${apply ? 'APPLIED' : 'DRY-RUN'}${allowOverwrite ? ' (overwrite ON)' : ' (fill-only)'} — matched ${s.matched}/${s.rosterCount}, unresolved ${s.unresolved.length}`
  );
  console.log(
    `  writes=${s.changes.length} (class changes=${s.classChanges.length}); held=${s.held.length}`
  );
  for (const c of s.classChanges) console.log(`   CLASS ${c.slug}: ${c.from} -> ${c.to}`);

  // Persist a full report for review.
  fs.mkdirSync('results', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `results/corps-ingest-${apply ? 'applied' : 'dryrun'}-${stamp}.json`;
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        mode: apply ? 'applied' : 'dry-run',
        matched: s.matched,
        rosterCount: s.rosterCount,
        unresolved: s.unresolved,
        classChanges: s.classChanges,
        changes: s.changes,
        held: s.held,
      },
      null,
      2
    )
  );
  console.log(`  report: ${file}`);
});

Effect.runPromise(
  program.pipe(
    Effect.provide(BrowserbaseServiceLive),
    Effect.provide(LibsqlClient.layer({ url: 'file:./dci-relational.db' }))
  )
)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[scrapeCorps] ERROR', err);
    process.exit(1);
  });
