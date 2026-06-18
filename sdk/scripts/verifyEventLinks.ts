// Browserbase verification of the DCI /events link for EVERY event, then
// regeneration of the app's verified-event-slug allowlist.
//
// For each event we resolve its canonical link slug (competition_slug bridged via
// event_to_competition, falling back to the event slug) — the same slug the app
// uses in app/lib/dci-links.ts — and fetch dci.org/events/{slug}. We do NOT trust
// event_page_scrapes as proof the page still exists: DCI removes the /events/
// page for older events (their score pages persist, but /events/ 404s), so a slug
// we scraped years ago may be gone now. Every slug is verified live (cached in
// event-slug-verification-cache.json so reruns skip already-checked slugs; pass
// --recheck to force). Slugs returning 2xx/3xx are written to
// ../app/lib/dci-verified-event-slugs.json — the allowlist the UI gates on.
//
// Usage (from sdk/):  npx tsx scripts/verifyEventLinks.ts [--limit N] [--recheck]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const argVal = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const limit = Number(argVal('limit') ?? 0) || 0;
const recheck = process.argv.includes('--recheck');
const cachePath = path.resolve(process.cwd(), 'event-slug-verification-cache.json');
const verifiedPath = path.resolve(process.cwd(), '../app/lib/dci-verified-event-slugs.json');

const db = createClient({ url: `file:${path.resolve(process.cwd(), 'dci-relational.db')}` });

const loadEnv = () => {
  try {
    for (const line of readFileSync(path.resolve(process.cwd(), '../.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/\r$/, '').trim();
    }
  } catch {
    /* ambient env */
  }
};

async function main() {
  // Resolve every event's canonical link slug (mirrors app/lib/dci-links.ts).
  const events = await db.execute(
    `SELECT DISTINCT COALESCE(m.competition_slug, e.slug) AS link
       FROM events e
       LEFT JOIN event_to_competition m ON m.event_slug = e.slug`
  );
  const linkSlugs = [...new Set(events.rows.map((r) => String(r.link)).filter(Boolean))];

  const cache: Record<string, { status: string; checkedAt: string }> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf8'))
    : {};

  // Verify every slug live. We deliberately do NOT skip previously-scraped slugs:
  // a scraped /events/ page may since have been removed by DCI. Cached results are
  // reused unless --recheck.
  let unknown = recheck ? [...linkSlugs] : linkSlugs.filter((s) => !cache[s]);
  if (limit > 0) unknown = unknown.slice(0, limit);

  console.log(
    `events=${linkSlugs.length} | cached=${linkSlugs.filter((s) => cache[s]).length} | to-check now=${unknown.length}`
  );

  if (unknown.length > 0) {
    loadEnv();
    const apiKey = process.env.BROWSERBASE_API_KEY;
    if (!apiKey) throw new Error('BROWSERBASE_API_KEY not set');
    const { default: Browserbase } = await import('@browserbasehq/sdk');
    const bb = new Browserbase({ apiKey });
    let i = 0;
    for (const slug of unknown) {
      const url = `https://www.dci.org/events/${slug}`;
      let status = 'err';
      try {
        const res = await bb.fetchAPI.create({ url });
        status = String(res.statusCode ?? 'ok');
      } catch (e) {
        status = `err:${String(e).slice(0, 30)}`;
      }
      cache[slug] = { status, checkedAt: new Date().toISOString() };
      i++;
      if (i % 10 === 0) {
        writeFileSync(cachePath, JSON.stringify(cache, null, 2));
        console.log(`  …${i}/${unknown.length}`);
      }
    }
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  }

  // Allowlist = link slugs whose /events/ page currently returns 2xx/3xx.
  const verified = linkSlugs.filter((s) => /^(2\d\d|3\d\d)$/.test(cache[s]?.status ?? '')).sort();
  writeFileSync(verifiedPath, `${JSON.stringify(verified, null, 2)}\n`);
  console.log(
    `\nverified(2xx/3xx)=${verified.length} | 404=${linkSlugs.filter((s) => cache[s]?.status === '404').length} → wrote ${path.relative(process.cwd(), verifiedPath)}`
  );
}

main()
  .then(() => db.close())
  .catch((e) => {
    console.error('verify failed:', e);
    db.close();
    process.exit(1);
  });
