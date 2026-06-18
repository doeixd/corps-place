// Capture corps logos that are blocked behind Google-Sites hotlink protection,
// using a real Browserbase browser session (the plain Fetch API + direct GETs
// all 403; the image only loads as an in-page sub-resource).
//
// Usage:
//   npx tsx scripts/captureSiteLogos.ts          # dry-run: capture + write preview PNGs to results/
//   npx tsx scripts/captureSiteLogos.ts --apply  # also cache bytes + set corps.corps_logo
//
// Strategy per corps: open its site, record every image response, then locate the
// header logo <img> in the DOM (top of page, modest size) and keep the bytes that
// element loaded. Bytes are stored in media-cache.db keyed by the logo's URL and
// registered in media_assets via MediaService; corps.corps_logo is set to that URL
// (the app serves it through /api/media, which returns cache hits for any host).

import { Effect } from 'effect';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { LibsqlClient } from '@effect/sql-libsql';
import { createClient } from '@libsql/client';
import Browserbase from '@browserbasehq/sdk';
import { chromium } from 'playwright-core';
import * as fs from 'node:fs';
import { MediaService, makeMediaServiceLayer } from '../src/mediaService.js';
import {
  loadDotenv,
  resolveRelationalDbUrl,
  resolveMediaCacheDbUrl,
  cacheCorpsLogo,
} from '../src/scriptSupport.js';

loadDotenv();

const APPLY = process.argv.includes('--apply');

const TARGETS = [
  { corpsKey: 'sky-ryders', name: 'Sky Ryders', pageUrl: 'https://www.skyryderspaf.org/' },
  {
    corpsKey: 'conquest-drum-bugle-corps',
    name: 'Conquest Drum & Bugle Corps',
    pageUrl: 'https://sites.google.com/view/conquest-drum-and-bugle/home',
  },
] as const;

const dbUrl = resolveRelationalDbUrl();
const mediaDbUrl = resolveMediaCacheDbUrl();

interface Captured {
  corpsKey: string;
  name: string;
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

// --- Browserbase capture (outside Effect; returns raw bytes) ------------------

async function captureLogos(): Promise<Captured[]> {
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY! });
  const projects = await bb.projects.list();
  const projectId = process.env.BROWSERBASE_PROJECT_ID ?? projects[0]?.id;
  if (!projectId) throw new Error('no Browserbase project available');

  const out: Captured[] = [];
  for (const t of TARGETS) {
    const session = await bb.sessions.create({ projectId });
    try {
      const browser = await chromium.connectOverCDP(session.connectUrl);
      const ctx = browser.contexts()[0] ?? (await browser.newContext());
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      const captured = new Map<string, { ct: string; body: Buffer }>();
      page.on('response', async (resp) => {
        const ct = resp.headers()['content-type'] || '';
        if (ct.startsWith('image/') && resp.status() === 200) {
          try {
            captured.set(resp.url(), { ct, body: await resp.body() });
          } catch {
            /* body unavailable */
          }
        }
      });
      await page.goto(t.pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // Google Sites holds long-lived connections, so 'networkidle' never fires;
      // give images time to load, then settle.
      await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(4000);

      // Header logo: a modestly-sized image near the very top of the document.
      const imgs = await page.evaluate(() => {
        const header = document.querySelector('[role="banner"], header');
        return [...document.images].map((im) => {
          const r = im.getBoundingClientRect();
          return {
            src: im.currentSrc || im.src,
            w: Math.round(r.width),
            h: Math.round(r.height),
            top: Math.round(r.top + window.scrollY),
            left: Math.round(r.left),
            inHeader: !!(header && header.contains(im)),
          };
        });
      });
      const logo = imgs
        .filter((i) => i.w > 20 && i.h > 20 && i.w <= 600 && i.h <= 400)
        .sort((a, b) => Number(b.inHeader) - Number(a.inHeader) || a.top - b.top || a.left - b.left)[0];

      const hit = logo ? captured.get(logo.src) : undefined;
      if (logo && hit) {
        out.push({
          corpsKey: t.corpsKey,
          name: t.name,
          url: logo.src,
          contentType: hit.ct,
          bytes: new Uint8Array(hit.body),
        });
        // Preview for human verification.
        const ext = hit.ct.includes('png') ? 'png' : hit.ct.includes('jpeg') ? 'jpg' : 'img';
        fs.writeFileSync(`results/logo-${t.corpsKey}.${ext}`, hit.body);
        console.log(`• ${t.name}: captured ${hit.body.length}B ${hit.ct} (preview results/logo-${t.corpsKey}.${ext})`);
      } else {
        console.log(`• ${t.name}: ⚠ no header logo captured`);
      }
      await browser.close();
    } finally {
      try {
        await bb.sessions.update(session.id, { projectId, status: 'REQUEST_RELEASE' });
      } catch {
        /* best effort */
      }
    }
  }
  return out;
}

// --- ingest captured bytes (Effect: pre-seed cache + register + set column) ---

const ingest = (items: Captured[]) =>
  Effect.gen(function* () {
    const sql = yield* (SqlClient.SqlClient);
    const media = yield* (MediaService);
    // Pre-seed the bytes cache so MediaService.cache reuses them instead of
    // downloading (the URL 403s outside a browser). One client, mirrors the
    // media_cache schema MediaService owns.
    const cacheDb = createClient({ url: mediaDbUrl });
    yield* (
      Effect.promise(() =>
        cacheDb.execute(
          `CREATE TABLE IF NOT EXISTS media_cache (url TEXT PRIMARY KEY, content_type TEXT, bytes BLOB, byte_length INTEGER, fetched_at TEXT)`
        )
      )
    );

    for (const it of items) {
      const cur = yield* (
        sql<{ corps_logo: string | null }>`SELECT corps_logo FROM corps WHERE corps_key = ${it.corpsKey} LIMIT 1`
      );
      if (cur[0]?.corps_logo) {
        console.log(`• ${it.name}: logo already present — skipped`);
        continue;
      }
      yield* (
        Effect.promise(() =>
          cacheDb.execute({
            sql: `INSERT OR REPLACE INTO media_cache (url, content_type, bytes, byte_length, fetched_at) VALUES (?, ?, ?, ?, ?)`,
            args: [it.url, it.contentType, it.bytes, it.bytes.byteLength, new Date().toISOString()],
          })
        )
      );
      const result = yield* (
        cacheCorpsLogo(media, sql, {
          corpsKey: it.corpsKey,
          name: it.name,
          logoUrl: it.url,
          via: 'browserbase-capture',
        })
      );
      console.log(`• ${it.name}: cached ${result.format} ${result.byteLength}B + set corps_logo`);
    }
  });

// --- main ---------------------------------------------------------------------

async function main() {
  fs.mkdirSync('results', { recursive: true });
  console.log(`\nCapture site logos ${APPLY ? '(APPLY)' : '(dry-run)'}\n`);
  const captured = await captureLogos();
  if (!APPLY) {
    console.log('\nDry-run — inspect the preview PNG(s) in results/, then re-run with --apply.');
    return;
  }
  await Effect.runPromise(
    ingest(captured).pipe(
      Effect.provide(makeMediaServiceLayer({ cacheDbUrl: mediaDbUrl })),
      Effect.provide(LibsqlClient.layer({ url: dbUrl }))
    )
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[captureSiteLogos] ERROR', err);
    process.exit(1);
  });
