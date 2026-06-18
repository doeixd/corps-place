// M0 recon for the lineup-discovery plan: fetch a few non-roster corps profiles
// + a bogus slug via Browserbase and dump the signals we need to design the
// existence predicate, class-from-text parser, and favicon resolver.
//
//   npx tsx scripts/reconCorpsDiscovery.ts
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
import * as cheerio from 'cheerio';
import { BrowserbaseServiceLive, BrowserbaseService } from '../src/browserbaseService.js';

const SLUGS = ['sky-ryders', 'arsenal-drum-bugle-corps', 'this-corps-does-not-exist-xyz'];

const probe = (html: string) => {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ').trim();
  const classHits: Record<string, boolean> = {};
  for (const cls of ['World Class', 'Open Class', 'All-Age', 'All Age', 'SoundSport', 'International'])
    classHits[cls] = new RegExp(cls.replace(/[-\s]/g, '[-\\s]?'), 'i').test(text);
  return {
    length: html.length,
    title: $('title').first().text().trim(),
    h1: $('h1').first().text().replace(/\s+/g, ' ').trim(),
    hasCommonDis: $('.common-dis').length,
    hasHero: $('.hero-section, .inner-hero').length,
    hasSocial: $('.social a[href]').length,
    hasAddress: $('.address').length,
    heroImgs: $('.hero-section img[alt], .inner-hero img[alt]')
      .map((_, im) => $(im).attr('src'))
      .get()
      .filter((s) => /production\.assets\.dci\.org/i.test(s ?? '')),
    classHits,
    metaDesc: $('meta[name="description"]').attr('content')?.slice(0, 160),
    // candidate class phrasings in body text
    classSnippets: [...text.matchAll(/[^.]*\b(World Class|Open Class|All[-\s]?Age|SoundSport|International)\b[^.]*\./gi)]
      .map((m) => m[0].trim())
      .slice(0, 4),
  };
};

const program = Effect.gen(function* () {
  const bb = yield* (BrowserbaseService);
  for (const slug of SLUGS) {
    const url = `https://www.dci.org/corps/${slug}/`;
    const res = yield* (
      bb.fetchHtml(url).pipe(Effect.result)
    );
    if (res._tag === 'Failure') {
      console.log(`\n### ${slug} — FETCH FAILED: ${res.failure.message} (status ${res.failure.statusCode})`);
      continue;
    }
    const info = probe(res.success);
    console.log(`\n### ${slug}`);
    console.log(JSON.stringify(info, null, 2));
  }
});

Effect.runPromise(program.pipe(Effect.provide(BrowserbaseServiceLive)))
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('RECON ERROR', e);
    process.exit(1);
  });
