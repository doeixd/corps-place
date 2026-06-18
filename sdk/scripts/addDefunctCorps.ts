// Create directory records for notable defunct corps that are absent from the DB
// and from every snapshot/score/lineup archive, so they still appear (as inactive)
// in the corps directory. Data sourced by hand from each corps' official/alumni
// site + DCX/Wikipedia (June 2026); logos cached through MediaService.
//
// Usage:
//   npx tsx scripts/addDefunctCorps.ts            # dry-run (default)
//   npx tsx scripts/addDefunctCorps.ts --apply    # insert rows + cache logos
//
// Idempotent: an existing corps_key is left alone (no insert, no logo overwrite).

import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';
import { MediaService, makeMediaServiceLayer } from '../src/mediaService.js';
import {
  resolveRelationalDbUrl,
  resolveMediaCacheDbUrl,
  cacheCorpsLogo,
} from '../src/scriptSupport.js';
import { markCorpsFieldsCurated } from '../src/corpsCuration.js';

interface NewCorps {
  readonly corpsKey: string;
  readonly name: string;
  readonly slug: string;
  readonly division: string;
  readonly city: string;
  readonly about: string;
  readonly logoUrl: string;
  readonly source: string;
}

const CORPS: readonly NewCorps[] = [
  {
    corpsKey: 'glassmen',
    name: 'Glassmen',
    slug: 'glassmen',
    division: 'World Class',
    city: 'Toledo, OH',
    about:
      "The Glassmen Drum & Bugle Corps was a World Class corps from Toledo, Ohio — a nod to the city's heritage as the \"Glass Capital of the World.\" Founded in 1961 as the Maumee Suns and renamed the Glassmen in 1971, the corps became a sixteen-time DCI World Championship Finalist. Mounting debt forced it inactive after the 2012 season, and it was dissolved in bankruptcy in 2014.",
    logoUrl:
      'https://glassmen.org/wp-content/uploads/2022/01/cropped-Step_3_of_4__Edit_Your_Logo___LogoMaker__12_-removebg-preview.png',
    source: 'glassmen.org + DCX/Wikipedia',
  },
  {
    corpsKey: 'teal-sound',
    name: 'Teal Sound',
    slug: 'teal-sound',
    division: 'Open Class',
    city: 'Jacksonville, FL',
    about:
      'Teal Sound was a drum and bugle corps from Jacksonville, Florida. After an early-1980s false start, founders Michael Butler and Danny Clark relaunched the corps for its official 1998 debut, aided by a grant from the Jacksonville Jaguars. Competing largely in Division II/III and Open Class, it was promoted to World Class in 2010 — the only World Class corps in Florida at the time — before going inactive in 2012.',
    logoUrl:
      'https://images.zoogletools.com/s:bzglfiles/u/665086/f15b0544e41a2403736ddf8dd3c7e0248a63756d/original/teal-burn-logo.jpg/!!/b%3AW1sicmVzaXplIiwxODAwXSxbIm1heCJdLFsid2UiXV0%3D/meta%3AeyJzcmNCdWNrZXQiOiJiemdsZmlsZXMifQ%3D%3D.jpg',
    source: 'tealsounddrumcorps.com + DCX/Wikipedia',
  },
];

const APPLY = process.argv.includes('--apply');
const dbUrl = resolveRelationalDbUrl();
const mediaDbUrl = resolveMediaCacheDbUrl();

const program = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const media = yield* (MediaService);

  console.log(`\nAdd defunct corps ${APPLY ? '(APPLY)' : '(dry-run)'}\n`);
  for (const c of CORPS) {
    const existing = yield* (
      sql<{ corps_key: string }>`SELECT corps_key FROM corps WHERE corps_key = ${c.corpsKey} LIMIT 1`
    );
    if (existing.length > 0) {
      console.log(`• ${c.name}: already exists (${c.corpsKey}) — skipped`);
      continue;
    }
    if (!APPLY) {
      console.log(`• ${c.name}: would insert [${c.division}, ${c.city}] + cache logo`);
      continue;
    }
    // Insert the directory row (active=0: defunct). corps_logo is set after the
    // bytes are cached so a failed download never leaves a dangling URL.
    yield* (sql`
      INSERT INTO corps (corps_key, name, slug, division_name, display_city, about, active, is_other_type)
      VALUES (${c.corpsKey}, ${c.name}, ${c.slug}, ${c.division}, ${c.city}, ${c.about}, 0, 0)
    `);
    yield* (markCorpsFieldsCurated(sql, c.corpsKey, ['about', 'display_city'], 'manual-add-defunct'));
    const result = yield* (
      cacheCorpsLogo(media, sql, {
        corpsKey: c.corpsKey,
        name: c.name,
        logoUrl: c.logoUrl,
        via: 'manual-add-defunct',
        source: c.source,
      }).pipe(Effect.result)
    );
    if (result._tag === 'Failure') {
      console.log(`• ${c.name}: inserted, ⚠ logo cache failed: ${(result.failure as { message?: string }).message ?? result.failure}`);
    } else {
      console.log(`• ${c.name}: inserted [${c.division}, ${c.city}] + logo ${result.success.format} ${result.success.byteLength}B`);
    }
  }
  if (!APPLY) console.log('\nDry-run only — re-run with --apply to write.');
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeMediaServiceLayer({ cacheDbUrl: mediaDbUrl })),
    Effect.provide(LibsqlClient.layer({ url: dbUrl }))
  )
)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[addDefunctCorps] ERROR', err);
    process.exit(1);
  });
