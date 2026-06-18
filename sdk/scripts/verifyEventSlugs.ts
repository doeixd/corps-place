// Read-only Browserbase verification of candidate canonical event slugs.
// Companion to reconcileEventSlugs.ts. Only slugs NOT already in
// event_page_scrapes need checking (a scraped slug is a known-real DCI URL), so
// this verifies just the uncertain remainder. Results are cached to
// event-slug-verification-cache.json so reruns don't re-fetch.
//
// Usage (from sdk/):  npx tsx scripts/verifyEventSlugs.ts [--limit N]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

const argVal = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const limit = Number(argVal('limit') ?? 0) || 0;
const cachePath = path.resolve(process.cwd(), 'event-slug-verification-cache.json');
const reportPath = path.resolve(process.cwd(), 'event-slug-reconciliation.json');

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
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const targets: string[] = [
    ...report.events.filter((e: any) => e.state === 'migrate' && e.canonical).map((e: any) => e.canonical),
    ...report.missing.map((m: any) => m.slug),
  ];
  const scraped = new Set(
    (await db.execute(`SELECT DISTINCT event_slug FROM event_page_scrapes`)).rows.map((r) =>
      String(r.event_slug)
    )
  );
  const cache: Record<string, { status: string; checkedAt: string }> = existsSync(cachePath)
    ? JSON.parse(readFileSync(cachePath, 'utf8'))
    : {};

  // Unknown = target slug we have NOT scraped and have NOT already verified.
  let unknown = [...new Set(targets)].filter((s) => !scraped.has(s) && !cache[s]);
  if (limit > 0) unknown = unknown.slice(0, limit);

  console.log(`targets=${targets.length} | known-real(scraped)=${targets.filter((s) => scraped.has(s)).length} | cached=${Object.keys(cache).length} | to-check now=${unknown.length}`);

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

  // ---- Classify all targets ----
  const exists = (s: string) =>
    scraped.has(s) || /^(2\d\d|3\d\d)$/.test(cache[s]?.status ?? '') || cache[s]?.status === 'ok';
  const result = { real: [] as string[], synthetic404: [] as string[], errored: [] as string[] };
  for (const s of [...new Set(targets)]) {
    if (scraped.has(s)) result.real.push(s);
    else if (cache[s]?.status === '404') result.synthetic404.push(s);
    else if (exists(s)) result.real.push(s);
    else result.errored.push(s);
  }
  console.log(`\nreal=${result.real.length} | synthetic(404)=${result.synthetic404.length} | errored/unknown=${result.errored.length}`);
  console.log('\n--- synthetic (404 on DCI — do NOT migrate blindly) ---');
  for (const s of result.synthetic404) console.log('  ', s);
  if (result.errored.length) {
    console.log('\n--- errored/unchecked ---');
    for (const s of result.errored.slice(0, 20)) console.log('  ', s, cache[s]?.status ?? '(unchecked)');
  }
}

main()
  .then(() => db.close())
  .catch((e) => {
    console.error('verify failed:', e);
    db.close();
    process.exit(1);
  });
