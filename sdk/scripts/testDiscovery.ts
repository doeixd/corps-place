// Live test of discovery probe + class-from-text + favicon on the recon corps.
import * as fs from 'node:fs';
import * as path from 'node:path';
const envPath = path.resolve(process.cwd(), '../.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}
import { Effect } from 'effect';
import { LibsqlClient } from '@effect/sql-libsql';
import { BrowserbaseServiceLive, BrowserbaseService } from '../src/browserbaseService.js';
import { guessCorpsSlugs, probeCorpsProfile, resolveFavicon } from '../src/corpsDiscovery.js';
import { parseCorpsClassFromText } from '../src/corpsParser.js';
import { corpsProfileUrl } from '../src/corpsScraper.js';

const CORPS = [
  { name: 'Sky Ryders', slug: 'sky-ryders' },
  { name: 'Arsenal', slug: 'arsenal' },
];

const program = Effect.gen(function* () {
  const bb = yield* (BrowserbaseService);
  const fetchHtml = (u: string) => bb.fetchHtml(u);
  for (const c of CORPS) {
    console.log(`\n### ${c.name}`);
    const slugs = guessCorpsSlugs(c.name, c.slug);
    console.log('  guessed slugs:', slugs);
    for (const slug of slugs) {
      const r = yield* (probeCorpsProfile(slug, { fetchHtml, refresh: true }));
      console.log(`  probe ${slug}: status=${r.status} isProfile=${r.isProfile}`);
      if (r.isProfile && r.profile) {
        const html = yield* (fetchHtml(corpsProfileUrl(slug)));
        console.log('    class-from-text:', parseCorpsClassFromText(html));
        console.log('    dci logo:', r.profile.logo ?? '(none)');
        console.log('    website:', r.profile.website ?? '(none)');
        if (!r.profile.logo && r.profile.website) {
          const siteHtml = yield* (fetchHtml(r.profile.website).pipe(Effect.orElseSucceed(() => '')));
          console.log('    favicon:', resolveFavicon(siteHtml, r.profile.website));
        }
        break;
      }
    }
  }
});

Effect.runPromise(
  program.pipe(
    Effect.provide(BrowserbaseServiceLive),
    Effect.provide(LibsqlClient.layer({ url: 'file:./dci-relational.db' }))
  )
).then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
