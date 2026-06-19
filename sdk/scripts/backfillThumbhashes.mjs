// Backfill missing thumbhashes by hitting the media proxy's thumbhash endpoint.
// The proxy already generates + caches thumbhashes on first request.
// Usage: node sdk/scripts/backfillThumbhashes.mjs [--concurrency 16]
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");

const DB_URL = process.env.MEDIA_CACHE_DB_URL ?? `file:${resolve(SDK_DIR, "media-cache.db")}`;
const db = createClient({ url: DB_URL });
const CONCURRENCY = process.argv.includes("--concurrency")
  ? Number(process.argv[process.argv.indexOf("--concurrency") + 1])
  : 8;
const BASE = process.env.BACKFILL_BASE_URL ?? "http://127.0.0.1:3000";

const rows = (await db.execute({
  sql: "SELECT url FROM media_cache WHERE url LIKE 'merch-product:%' AND thumbhash IS NULL",
  args: [],
})).rows;

console.log(`[backfill] ${rows.length} product images need thumbhashes (concurrency=${CONCURRENCY})`);

let done = 0;
async function fetchOne(url) {
  try {
    const u = `${BASE}/api/media?u=${encodeURIComponent(url)}&thumbhash=1`;
    const r = await fetch(u);
    if (r.ok) done++;
    else console.error(`  ${r.status} ${url.slice(0, 60)}`);
  } catch (e) {
    console.error(`  err ${url.slice(0, 60)}: ${e.message || e}`);
  }
}

async function run() {
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(r => fetchOne(r.url)));
    if (i % 500 === 0) console.log(`[backfill] ${done} / ${i + batch.length}`);
  }
  console.log(`[backfill] done — ${done} thumbhashes generated.`);
}

run().catch(e => { console.error(e); process.exit(1); });
