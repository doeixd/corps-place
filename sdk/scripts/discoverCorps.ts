// Lineup-driven corps discovery + enrichment (lineup-discovery plan, M5 driver).
//
// Usage:
//   npx tsx scripts/discoverCorps.ts                    # dry-run (default), uses cache
//   npx tsx scripts/discoverCorps.ts --apply            # write enrichment + cache media
//   npx tsx scripts/discoverCorps.ts --season 2026
//   npx tsx scripts/discoverCorps.ts --refresh          # bypass probe cache
//   npx tsx scripts/discoverCorps.ts --limit 10         # cap corps probed
//   npx tsx scripts/discoverCorps.ts --include-defunct  # add cached historical corps
//
// Enumerates this season's competing corps that the roster pass never covered,
// probes dci.org for a profile (trying slug variants, archiving 404s), then
// coalescing-ingests division (class ladder) + logo (favicon fallback) + about/
// socials/etc. On --apply it also caches each adopted logo/cover/favicon's bytes
// + metadata via MediaService. A JSON report is written to results/.

import * as fs from 'node:fs';
import * as path from 'node:path';

const envPaths = [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../.env')];
for (const envPath of envPaths) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  break;
}

import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import { BrowserbaseServiceLive, BrowserbaseService } from '../src/browserbaseService.js';
import { MediaService, makeMediaServiceLayer } from '../src/mediaService.js';
import { discoverCorpsProfiles, type DiscoveredCorps } from '../src/corpsDiscovery.js';
import { ingestDiscoveredCorps, type DiscoveredCorpsInput } from '../src/corpsIngest.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const getArg = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const apply = has('--apply');
// Fill-only unless opted in: existing values are held, not overwritten (mirrors
// scrapeCorps.ts) so discovery can't clobber curated logos/data.
const allowOverwrite = has('--allow-overwrite');
const refresh = has('--refresh');
const season = Number(getArg('--season') ?? 2026);
const limit = getArg('--limit') ? Number(getArg('--limit')) : undefined;
const includeDefunct = has('--include-defunct');
const dbUrl =
  process.env.DCI_RELATIONAL_DB_URL ??
  (fs.existsSync(path.resolve(process.cwd(), 'sdk', 'dci-relational.db'))
    ? `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`
    : `file:${path.resolve(process.cwd(), 'dci-relational.db')}`);
const mediaDbUrl =
  process.env.MEDIA_CACHE_DB_URL ??
  (fs.existsSync(path.resolve(process.cwd(), 'sdk', 'media-cache.db'))
    ? `file:${path.resolve(process.cwd(), 'sdk', 'media-cache.db')}`
    : `file:${path.resolve(process.cwd(), 'media-cache.db')}`);

const program = Effect.gen(function* () {
  // NOTE: deliberately does NOT call ensureRelationalSchema — that function runs
  // DROP TABLE on event_lineup_entries/event_participants/event_venues/
  // event_group_types and would wipe lineup data. All tables this script needs
  // (corps_page_scrapes, corps_class_history, corps.*) already exist.
  const bb = yield* (BrowserbaseService);
  const media = yield* (MediaService);
  const fetchHtml = (url: string) => bb.fetchHtml(url);

  // 1) Discover.
  yield* (Effect.logInfo(`[discoverCorps] season ${season} — probing candidates…`));
  const discovered = yield* (
    discoverCorpsProfiles({ season, fetchHtml, refresh, limit, includeDefunct })
  );
  const found = discovered.filter((d) => !!d.slug);
  const ingestable = discovered.filter(
    (d): d is DiscoveredCorps & { slug: string; corpsKey: string } => !!d.slug && !!d.corpsKey
  );
  const archivedOnly = discovered.filter((d) => !!d.slug && !d.corpsKey);
  const noMatch = discovered.filter((d) => !d.slug);
  yield* (
    Effect.logInfo(
      `[discoverCorps] ${discovered.length} candidates → ${found.length} profiles found, ${archivedOnly.length} archived-only, ${noMatch.length} unmatched`
    )
  );

  // 2) Ingest (coalescing + guardrailed).
  const inputs: DiscoveredCorpsInput[] = ingestable.map((d) => ({
    unitName: d.unitName,
    corpsKey: d.corpsKey,
    slug: d.slug,
    textDivision: d.textDivision ?? null,
    favicon: d.favicon ?? null,
  }));
  const summary = yield* (
    ingestDiscoveredCorps({ discovered: inputs, dryRun: !apply, allowOverwrite })
  );
  console.log(
    `[discoverCorps] ${apply ? 'APPLIED' : 'DRY-RUN'} — found ${found.length}, ` +
      `writes=${summary.changes.length}, held=${summary.held.length}`
  );
  for (const o of summary.classObservations)
    if (o.division) console.log(`   CLASS ${o.corpsKey}: ${o.division} (${o.source})`);

  // 3) Cache adopted media bytes + metadata (only on apply — it downloads).
  const cached: { corpsKey: string; role: string; url: string; bytes: number; format?: string }[] = [];
  if (apply) {
    for (const d of ingestable) {
      const assets: { role: string; url: string | null }[] = [
        { role: 'logo', url: d.logo ?? d.favicon ?? null },
        { role: 'cover', url: d.coverImage ?? null },
      ];
      for (const a of assets) {
        if (!a.url) continue;
        const asset = yield* (
          media
            .cache({
              ownerType: 'corps',
              ownerId: d.corpsKey,
              role: a.role,
              sourceUrl: a.url,
              attribution: a.url === d.favicon ? new URL(a.url).host : 'dci',
              metadata: { via: a.url === d.favicon ? 'corps-site' : 'profile', unitName: d.unitName },
            })
            .pipe(Effect.catch((e) => Effect.as(Effect.logWarning(`[media] ${d.corpsKey}/${a.role}: ${e.message}`), null)))
        );
        if (asset)
          cached.push({
            corpsKey: d.corpsKey,
            role: a.role,
            url: asset.url,
            bytes: Number(asset.metadata && (asset.metadata as Record<string, unknown>).byteLength) || 0,
            format: asset.format,
          });
      }
    }
    console.log(`[discoverCorps] cached ${cached.length} media assets`);
  }

  // 4) Report.
  fs.mkdirSync('results', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `results/corps-discovery-${apply ? 'applied' : 'dryrun'}-${stamp}.json`;
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        mode: apply ? 'applied' : 'dry-run',
        season,
        candidates: discovered.length,
        found: found.map((d) => ({
          unitName: d.unitName,
          corpsKey: d.corpsKey,
          slug: d.slug,
          textDivision: d.textDivision,
          logo: d.logo,
          favicon: d.favicon,
        })),
        archivedOnly: archivedOnly.map((d) => ({
          unitName: d.unitName,
          corpsKey: d.corpsKey,
          slug: d.slug,
          textDivision: d.textDivision,
          logo: d.logo,
          favicon: d.favicon,
        })),
        unmatched: noMatch.map((d) => ({ unitName: d.unitName, triedSlugs: d.triedSlugs })),
        changes: summary.changes,
        held: summary.held,
        classObservations: summary.classObservations,
        cachedMedia: cached,
      },
      null,
      2
    )
  );
  console.log(`  report: ${file}`);
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeMediaServiceLayer({ cacheDbUrl: mediaDbUrl })),
    Effect.provide(BrowserbaseServiceLive),
    Effect.provide(LibsqlClient.layer({ url: dbUrl }))
  )
)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[discoverCorps] ERROR', err);
    process.exit(1);
  });
