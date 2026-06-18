// Fill missing about/logo for currently-active corps that dci.org never profiled.
//
// Usage:
//   npx tsx scripts/enrichActiveCorps.ts            # dry-run (default)
//   npx tsx scripts/enrichActiveCorps.ts --apply    # write about + cache logos
//
// The lineup-driven discovery pipeline (discoverCorps.ts) only enriches corps
// that have a dci.org profile page. A handful of active SoundSport / affiliate /
// international units have none, so their about + logo stay empty. The data below
// was sourced by hand from each corps' own website / official socials (see
// `source` per entry) and from WebSearch, in June 2026. Writes are FILL-ONLY:
// a non-empty about/logo is never overwritten. Logos are cached through
// MediaService (bytes -> media-cache.db, metadata -> media_assets) exactly like
// the discovery pipeline, and corps.corps_logo is set to the source URL the app
// serves bytes by.

import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';
import * as fs from 'node:fs';
import { MediaService, makeMediaServiceLayer } from '../src/mediaService.js';
import {
  resolveRelationalDbUrl,
  resolveMediaCacheDbUrl,
  cacheCorpsLogo,
} from '../src/scriptSupport.js';
import { markCorpsFieldsCurated, type CuratableField } from '../src/corpsCuration.js';

interface Enrichment {
  readonly corpsKey: string;
  readonly name: string;
  readonly about?: string;
  readonly city?: string;
  readonly logoUrl?: string;
  /** Where the data came from, recorded in the media_assets provenance + report. */
  readonly source: string;
}

// A non-logo standing in for a missing one — the dci.org generic splash image.
// Treated as "empty" so a real logo can replace it.
const isPlaceholderLogo = (url: string | null | undefined) =>
  !url || url.trim() === '' || /dci-splash/i.test(url);

const ENRICHMENTS: readonly Enrichment[] = [
  {
    corpsKey: '001j000000iwwspaal',
    name: 'Blue Saints',
    about:
      "Founded in 1952 in Sudbury, Ontario, the Blue Saints are Canada's oldest drum and bugle corps and the oldest surviving competitive junior corps in the country. The corps competed strictly in Canada until 2002, when it committed to the DCI tour, reaching the Open Class finals with a 15th-place finish in 2011. Since 2010 the Blue Saints have been the only active competitive junior drum and bugle corps in Ontario.",
    logoUrl: 'https://img1.wsimg.com/isteam/ip/cae390fc-c1d8-41c9-b6af-7e2c916cd8e3/Saints%20Logo.webp',
    source: 'thebluesaints.org + Wikipedia/DCX',
  },
  {
    corpsKey: 'conquest-drum-bugle-corps',
    name: 'Conquest Drum & Bugle Corps',
    about:
      "Based in Geneseo, Illinois, Conquest Drum & Bugle Corps is the only SoundSport team in the Illinois/Iowa region. The corps' mission is to mold young people into responsible citizens and future leaders through dynamic music performance.",
    logoUrl:
      'https://lh3.googleusercontent.com/sitesv/AA5AbUB3rPPpiad00bo65zKheOxmidRDx-InNopZv3E1ovoMpRLzylHSLGhu5oDJmUcM0n5PW4wKaSJjcFbB3bi0caw1I5GI6VyqVjGmraWpxD4X_D4rMNgCCtbZmO4VnU-XH3ZQgppRYbHwH7szcXL1fNevU7TzpRfYYZbwjt_F8OQMVqEepwXOT13OThw=w16383',
    source: 'sites.google.com/view/conquest-drum-and-bugle',
  },
  {
    corpsKey: '0015b000028qtqbaae',
    name: 'Eclipse',
    about:
      'Eclipse is a SoundSport drum corps based in Indianapolis, Indiana, sponsored by the National Sport and Performing Arts Federation (NSPAF). The group provides young musicians with competitive performance opportunities and professional training in a collaborative, supportive environment.',
    logoUrl:
      'https://images.squarespace-cdn.com/content/v1/63397265e2571e10e7c29313/1e1a14bd-3685-426a-be4d-1198e30b77d6/Eclipse+SEO+-+Remade.png?format=1500w',
    source: 'eclipsedbc.org',
  },
  {
    corpsKey: '0010a00001bpafnaar',
    name: 'Sound of Sun Prairie',
    about:
      'The Sound of Sun Prairie is a voluntary marching ensemble for students in grades 8–12, combining winds, percussion, and color guard. Affiliated with the Sun Prairie Band Boosters in Sun Prairie, Wisconsin, the group develops leadership and musical artistry while competing in DCI SoundSport and events such as the WAMSB World Championships.',
    logoUrl: 'https://www.spbb.org/uploads/2/2/2/1/22215324/sosp_orig.jpeg',
    source: 'spbb.org/sosp.html',
  },
  {
    corpsKey: 'mercedes-marching-band',
    name: 'Mercedes Marching Band',
    about:
      "Mercedes Marching Band is a marching ensemble from Mercedes Norte in Heredia, Costa Rica. Part of Costa Rica's growing marching-arts community, the group represents the country on the international stage as a Drum Corps International entry.",
    // Replaces the dci-splash placeholder with the band's real shield logo
    // (Facebook page profile photo / og:image). The fbcdn URL is signed + expiring
    // but only ever used as a cache key — bytes are stored on apply and served from
    // cache, never re-fetched.
    logoUrl:
      'https://scontent-sea1-1.xx.fbcdn.net/v/t39.30808-1/286374602_481976583937855_4772604151432345781_n.jpg?stp=dst-jpg_tt6&cstp=mx960x959&ctp=s720x720&_nc_cat=100&ccb=1-7&_nc_sid=3ab345&_nc_ohc=yzKjJq3glGoQ7kNvwEMESrK&_nc_oc=AdoOtXuKURfLg0dmgaf7yq0hdeLXHGwujUfefG_Sii8fl7QShSyfprV6104yju8tb9E&_nc_zt=24&_nc_ht=scontent-sea1-1.xx&_nc_gid=QM1cfovP2jMBZ_xCVhZ64A&_nc_ss=7b289&oh=00_Af8pP2YqI4-hhexM8iY6CsNtVF58LceZDDSEZu1CU2mNrA&oe=6A26B045',
    source: 'facebook.com/mercedesmarchingband (og:image profile logo)',
  },
  {
    corpsKey: '0010a000019s6ceaay',
    name: 'Erie Thunderbirds',
    city: 'Erie, PA',
    about:
      'The Erie Thunderbirds Drum & Bugle Corps traces its roots to a corps founded in Meadville, Pennsylvania in 1956, taking its current form when the Thunderbirds merged with the Shoreliners in 1968. After going inactive in 1984, the corps was revived by alumni and today competes as an all-age corps in DCA and DCI All-Age events out of Erie, Pennsylvania.',
    logoUrl: 'https://www.eriethunderbirds.org/templates/tbirds/images/header.png',
    source: 'eriethunderbirds.org + DCX/Fandom',
  },
  {
    corpsKey: 'kilties',
    name: 'Kilties',
    city: 'Racine, WI',
    about:
      "Founded in 1934 in Racine, Wisconsin, the Kilties Drum & Bugle Corps is one of the activity's oldest organizations, recognizable for its tartan-clad Scottish identity. A successful junior corps through the 1950s and '60s, it disbanded in 1982 and reformed as an all-age corps in 1992, performing in competitions, parades, concerts, and exhibitions across the country.",
    logoUrl: 'https://www.kilties.com/templates/lime_light/images/s5_logo.png',
    source: 'kilties.com + DCX',
  },
  {
    corpsKey: 'sonus-brass-theater',
    name: 'Sonus Brass Theater',
    about:
      "Sonus Brass Theater is Virginia's only DCI SoundSport team, a brass ensemble that competes at SoundSport events across the eastern United States. The group has earned Gold ratings at the SoundSport International Music & Food Festival and rehearses and holds open houses in the Gainesville, Virginia area.",
    source: 'sonusbrasstheater.org (logo already present)',
  },
  {
    corpsKey: 'sky-ryders',
    name: 'Sky Ryders',
    // about already present; only the logo is missing.
    logoUrl:
      'https://lh3.googleusercontent.com/sitesv/AA5AbUBr5L-ePrR41yPLZr84T9rx-KjOSzZkCZny9jsV4zWWplIqV88FCFgfl3K6iedmTvcYZ7aGyF-3Qw3mywgD_Mv2mKNOQBjRtC5oOzvhZgWd1NC33zlfazI93ykFGscdoBcSSl0U2Z28j_cHWuwne6dWRe_GDLRi1WQ9OFF2EOkOPY99sJmcAmF1=w16383',
    source: 'skyryderspaf.org',
  },
];

const APPLY = process.argv.includes('--apply');

const dbUrl = resolveRelationalDbUrl();
const mediaDbUrl = resolveMediaCacheDbUrl();

type Action = {
  corpsKey: string;
  name: string;
  setAbout?: boolean;
  setLogo?: string;
  setCity?: string;
  logoBytes?: number;
  logoFormat?: string;
  skipped: string[];
};

const program = Effect.gen(function* () {
  const sql = yield* (SqlClient.SqlClient);
  const media = yield* (MediaService);
  const actions: Action[] = [];

  for (const e of ENRICHMENTS) {
    const rows = yield* (
      sql<{ about: string | null; corps_logo: string | null; display_city: string | null }>`
        SELECT about, corps_logo, display_city FROM corps WHERE corps_key = ${e.corpsKey} LIMIT 1
      `
    );
    const cur = rows[0];
    const action: Action = { corpsKey: e.corpsKey, name: e.name, skipped: [] };
    if (!cur) {
      action.skipped.push('corps_key not found');
      actions.push(action);
      continue;
    }

    // about — fill only.
    const aboutEmpty = !cur.about || cur.about.trim() === '';
    if (e.about && aboutEmpty) {
      action.setAbout = true;
      if (APPLY) {
        yield* (sql`UPDATE corps SET about = ${e.about} WHERE corps_key = ${e.corpsKey}`);
      }
    } else if (e.about && !aboutEmpty) {
      action.skipped.push('about already present');
    }

    // city — fill only.
    const cityEmpty = !cur.display_city || cur.display_city.trim() === '';
    if (e.city && cityEmpty) {
      action.setCity = e.city;
      if (APPLY) {
        yield* (sql`UPDATE corps SET display_city = ${e.city} WHERE corps_key = ${e.corpsKey}`);
      }
    } else if (e.city && !cityEmpty) {
      action.skipped.push('city already present');
    }

    // logo — fill only (a dci-splash placeholder counts as empty); cache bytes
    // through MediaService, then point the column at the source URL.
    const logoEmpty = isPlaceholderLogo(cur.corps_logo);
    if (e.logoUrl && logoEmpty) {
      if (APPLY) {
        const result = yield* (
          cacheCorpsLogo(media, sql, {
            corpsKey: e.corpsKey,
            name: e.name,
            logoUrl: e.logoUrl,
            via: 'manual-enrichment',
            source: e.source,
          }).pipe(Effect.result)
        );
        if (result._tag === 'Failure') {
          action.skipped.push(`logo cache failed: ${(result.failure as { message?: string }).message ?? result.failure}`);
        } else {
          action.setLogo = e.logoUrl;
          action.logoBytes = result.success.byteLength;
          action.logoFormat = result.success.format;
        }
      } else {
        action.setLogo = e.logoUrl; // dry-run: would cache + set
      }
    } else if (e.logoUrl && !logoEmpty) {
      action.skipped.push('logo already present');
    }

    // Mark every hand-authored field on this corps as curated so a later DCI
    // ingest never overwrites it — even when the fill was skipped because the
    // value is already in place (e.g. a logo set on a prior run).
    if (APPLY) {
      const curated: CuratableField[] = [];
      if (e.about) curated.push('about');
      if (e.city) curated.push('display_city');
      if (e.logoUrl) curated.push('corps_logo');
      if (curated.length) yield* (markCorpsFieldsCurated(sql, e.corpsKey, curated, 'manual-enrichment'));
    }

    actions.push(action);
  }

  // Report.
  console.log(`\nEnrich active corps ${APPLY ? '(APPLY)' : '(dry-run)'}\n`);
  for (const a of actions) {
    const bits: string[] = [];
    if (a.setAbout) bits.push('about✔');
    if (a.setCity) bits.push(`city✔ (${a.setCity})`);
    if (a.setLogo) bits.push(`logo✔${a.logoBytes ? ` (${a.logoBytes}B ${a.logoFormat ?? ''})` : ''}`);
    console.log(`• ${a.name}: ${bits.join(', ') || '—'}${a.skipped.length ? `  [skipped: ${a.skipped.join('; ')}]` : ''}`);
  }

  fs.mkdirSync('results', { recursive: true });
  const file = `results/enrich-active-corps-${APPLY ? 'apply' : 'dryrun'}.json`;
  fs.writeFileSync(file, JSON.stringify({ applied: APPLY, actions }, null, 2));
  console.log(`\nReport: ${file}`);
  if (!APPLY) console.log('Dry-run only — re-run with --apply to write.');
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeMediaServiceLayer({ cacheDbUrl: mediaDbUrl })),
    Effect.provide(LibsqlClient.layer({ url: dbUrl }))
  )
)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[enrichActiveCorps] ERROR', err);
    process.exit(1);
  });
