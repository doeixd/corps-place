// Ingest products for every seeded merch store (docs/plans/MERCH_PLAN.md §21 M1).
//
// Effect program: the SqlClient (merch_stores reads + merch_products upserts) and
// the Browserbase fallback both come from LAYERS — LibsqlClient.layer +
// (optionally) BrowserbaseServiceLive — not hand-rolled clients. Stores are
// processed with bounded concurrency (Effect.forEach); a single store's failure
// is isolated (Effect.catch → error result) and recorded in merch_stores.sync_status
// without aborting the batch. Idempotent: product_id is a deterministic hash.
//
// Usage (from sdk/, with BROWSERBASE_API_KEY in repo-root .env):
//   npx tsx scripts/ingestMerch.ts --dry-run --limit 5
//   npx tsx scripts/ingestMerch.ts
//   npx tsx scripts/ingestMerch.ts --stores 001j...,lot-riot
//   npx tsx scripts/ingestMerch.ts --concurrency 6

import { Cause, Effect, Layer, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { BrowserbaseServiceLive } from "../src/browserbaseService.js";
import {
  selectAdapter,
  isLinkOnlyHost,
  type MerchStore,
  type NormalizedProduct,
} from "../src/merchCatalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const getOpt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = hasFlag("--dry-run");
const limit = getOpt("--limit") ? Number(getOpt("--limit")) : undefined;
const onlyStores = getOpt("--stores")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const concurrency = Math.max(
  1,
  Math.min(getOpt("--concurrency") ? Number(getOpt("--concurrency")) : 4, 16),
);

const DB_URL =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${resolve(SDK_DIR, "dci-relational.db")}`;

// The distinctive label of a storefront host: drop a leading www/shop/store and
// take the first remaining domain label (shop.cavaliers.org → "cavaliers",
// store.bluedevils.org → "bluedevils", bluecoats.com/shop → "bluecoats").
const hostCore = (url: string): string => {
  try {
    const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    return new URL(u).hostname
      .replace(/^(www|shop|store)\./i, "")
      .split(".")[0]
      .toLowerCase();
  } catch {
    return "";
  }
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Explicit canonical owners for shared storefronts where the host matches NEITHER
// sibling's name (so the heuristic below can't tell). hostCore → preferred name.
// bkmarketplace.org is shared by Blue Knights (parent) + BKXperience (program).
const CANONICAL_OWNER: Record<string, string> = {
  bkmarketplace: "blue knights",
};

// Among stores sharing a storefront URL, pick the canonical owner. Prefer an
// explicit override, then the one whose name matches the host (the parent corps —
// "The Cavaliers" ↔ cavaliers.org, not the "Rosemont King Cobras" feeder), then the
// shortest name, then alphabetical.
const moreCanonical =
  (core: string) =>
  (a: MerchStore, b: MerchStore): MerchStore => {
    const pref = CANONICAL_OWNER[core];
    if (pref) {
      const [pa, pb] = [
        norm(a.name).includes(norm(pref)),
        norm(b.name).includes(norm(pref)),
      ];
      if (pa !== pb) return pa ? a : b;
    }
    const m = (s: MerchStore) =>
      core.length >= 3 &&
      (norm(s.name).includes(core) || core.includes(norm(s.name)));
    const [ma, mb] = [m(a), m(b)];
    if (ma !== mb) return ma ? a : b;
    if (a.name.length !== b.name.length)
      return a.name.length < b.name.length ? a : b;
    return a.name <= b.name ? a : b;
  };

// Partition stores into the primaries to ingest (one per storefront URL) and the
// siblings to demote to link-only.
const electPrimaries = (
  all: MerchStore[],
): { stores: MerchStore[]; secondaries: MerchStore[] } => {
  const byUrl = new Map<string, MerchStore[]>();
  for (const s of all) {
    const group = byUrl.get(s.storeUrl);
    if (group) group.push(s);
    else byUrl.set(s.storeUrl, [s]);
  }
  const stores: MerchStore[] = [];
  const secondaries: MerchStore[] = [];
  for (const [url, group] of byUrl) {
    const primary = group.reduce(moreCanonical(hostCore(url)));
    for (const s of group) (s === primary ? stores : secondaries).push(s);
  }
  return { stores, secondaries };
};

const productId = (storeId: string, externalId: string) =>
  createHash("sha1")
    .update(`${storeId} ${externalId}`)
    .digest("hex")
    .slice(0, 24);

// Stable image cache — product images are downloaded during ingest and stored
// under `merch-product:<pid>/<index>` keys in the shared media-cache.db. The
// app's proxy serves from these keys directly, so images survive source URL
// changes (e.g. Squarespace regenerating asset IDs on re-upload).
const CACHE_DB_PATH = resolve(SDK_DIR, "media-cache.db");
let _cacheDb: Awaited<ReturnType<typeof createClient>> | null = null;
const getCacheDb = () => {
  if (!_cacheDb) {
    _cacheDb = createClient({ url: `file:${CACHE_DB_PATH}` });
    _cacheDb.execute(
      `CREATE TABLE IF NOT EXISTS media_cache (
        url TEXT PRIMARY KEY, content_type TEXT, bytes BLOB,
        byte_length INTEGER, fetched_at TEXT
      )`,
    ).catch(() => {});
  }
  return _cacheDb;
};

const NO_IMAGE_PLACEHOLDER_PATTERNS = [
  'no-image.png',
  'no-image-available',
  'universal/images-v6/configuration/no-image',
  'no_image',
];

// Download a single image from `src` and store it in media-cache.db under `key`.
// Silently skips if already cached, the source fails, or the result is a known
// no-image placeholder. Never throws — callers treat failures as a non-critical
// fallback to the source URL.
// Returns true when the image was successfully cached, false on any failure
// (source unreachable, not an image, no-image placeholder, etc.).
const cacheImage = (key: string, src: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const db = getCacheDb();
    const existing = yield* Effect.tryPromise({
      try: () => db.execute({ sql: 'SELECT 1 FROM media_cache WHERE url = ? LIMIT 1', args: [key] }),
      catch: () => ({ rows: [] }),
    });
    if (existing.rows.length > 0) return true;
    const res = yield* Effect.tryPromise({
      try: () => fetch(src, { signal: AbortSignal.timeout(15000) }),
      catch: () => null,
    });
    if (!res?.ok) return false;
    if (NO_IMAGE_PLACEHOLDER_PATTERNS.some((p) => res.url.includes(p))) return false;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith('image/')) return false;
    const bytes = new Uint8Array(
      yield* Effect.tryPromise({ try: () => res.arrayBuffer(), catch: () => new ArrayBuffer(0) }),
    );
    if (bytes.byteLength === 0) return false;
    yield* Effect.tryPromise({
      try: () =>
        db.execute({
          sql: `INSERT OR REPLACE INTO media_cache (url, content_type, bytes, byte_length, fetched_at)
                VALUES (?, ?, ?, ?, ?)`,
          args: [key, ct, bytes, bytes.byteLength, new Date().toISOString()],
        }),
      catch: () => {},
    });
    return true;
  }).pipe(Effect.catch(() => Effect.succeed(false)));

// For each product image, download and cache under a stable `merch-product:` key,
// then rewrite the NormalizedProduct to reference the stable key instead of the
// source URL so future requests are independent of source URL changes.
const cacheProductImages = (store: MerchStore, p: NormalizedProduct) =>
  Effect.gen(function* () {
    const pid = productId(store.storeId, p.externalId);
    const stableKeys: string[] = [];
    for (let i = 0; i < p.images.length; i++) {
      const src = p.images[i];
      if (!src) continue;
      const key = `merch-product:${pid}/${i}`;
      const ok = yield* cacheImage(key, src);
      if (ok) stableKeys.push(key);
    }
    return {
      ...p,
      image: stableKeys[0] ?? p.image,
      images: stableKeys.length > 0 ? stableKeys : p.images,
    } as NormalizedProduct;
  });

type StoreStatus = "ok" | "partial" | "error";

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Self-contained DDL so the script runs against a DB that hasn't had the full
  // relational schema applied (mirrors relational.ts).
  yield* sql`CREATE TABLE IF NOT EXISTS merch_products (
    product_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, external_id TEXT, title TEXT NOT NULL,
    description TEXT, product_url TEXT NOT NULL, image_url TEXT, images_json TEXT,
    price_min REAL, price_max REAL, currency TEXT, available INTEGER, variants_json TEXT,
    cart_capability TEXT, add_to_cart_template TEXT, category TEXT, synced_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_merch_products_store ON merch_products(store_id)`;

  // Skip opted-out stores (listed=0) unless explicitly targeted by --stores.
  const where = onlyStores?.length
    ? sql`WHERE store_id IN ${sql.in(onlyStores)}`
    : sql`WHERE COALESCE(listed, 1) = 1`;
  const limitClause = limit ? sql`LIMIT ${limit}` : sql``;
  const storeRows = yield* sql<{
    store_id: string;
    name: string;
    platform: string | null;
    store_url: string;
  }>`SELECT store_id, name, platform, store_url FROM merch_stores
       ${where} ORDER BY (platform = 'shopify') DESC, name ${limitClause}`;

  const allStores: MerchStore[] = storeRows.map((r) => ({
    storeId: r.store_id,
    name: r.name,
    platform: r.platform ?? "unknown",
    storeUrl: r.store_url,
  }));

  // Storefront dedup: several corps share ONE storefront (sibling/feeder/alumni
  // units — Bluecoats family, Blue Devils A/B/C, Colts/Colt Cadets, …). Ingesting
  // each would fetch + store the same catalog N times (the source of the duplicate
  // products in /merch). We elect ONE "primary" store per storefront URL to ingest;
  // the rest become link-only (their Shop link still points at the shared store,
  // they just carry no products). When --stores targets specific ids we honour them
  // verbatim and skip this election.
  const elected = onlyStores?.length
    ? { stores: allStores, secondaries: [] as MerchStore[] }
    : electPrimaries(allStores);
  // Pull link-only platforms (e.g. bonfire.com) out of the ingest set and into the
  // same demotion cleanup as siblings — keep the Shop link, store no products.
  const stores = elected.stores.filter((s) => !isLinkOnlyHost(s.storeUrl));
  const secondaries = [
    ...elected.secondaries,
    ...elected.stores.filter((s) => isLinkOnlyHost(s.storeUrl)),
  ];

  const hasBrowserbase = Boolean(process.env.BROWSERBASE_API_KEY);
  yield* Effect.logInfo(
    `Ingesting ${stores.length} primary stores (${secondaries.length} link-only siblings), concurrency=${concurrency}, dryRun=${dryRun}, browserbase=${hasBrowserbase}`,
  );

  // Demote siblings to link-only: drop any products a prior run ingested under them
  // and zero their count so the catalog + /stores counts reflect the dedup.
  if (!dryRun && secondaries.length > 0) {
    const ids = secondaries.map((s) => s.storeId);
    yield* sql`DELETE FROM merch_products WHERE store_id IN ${sql.in(ids)}`;
    yield* sql`UPDATE merch_stores
                 SET product_count = 0, sync_status = 'link-only'
               WHERE store_id IN ${sql.in(ids)}`;
    yield* Effect.logInfo(
      `Demoted ${ids.length} sibling stores to link-only: ${secondaries.map((s) => s.name).join(", ")}`,
    );
  }

  const syncedAt = new Date().toISOString();
  const done = yield* Ref.make(0);

  const upsertProduct = (store: MerchStore, p: NormalizedProduct) =>
    sql`INSERT INTO merch_products
          (product_id, store_id, external_id, title, description, product_url, image_url, images_json,
           price_min, price_max, currency, available, variants_json, cart_capability, add_to_cart_template,
           category, synced_at)
        VALUES
          (${productId(store.storeId, p.externalId)}, ${store.storeId}, ${p.externalId}, ${p.title},
           ${p.description}, ${p.productUrl}, ${p.image}, ${JSON.stringify(p.images)},
           ${p.priceMin}, ${p.priceMax}, ${p.currency},
           ${p.available === null ? null : p.available ? 1 : 0}, ${JSON.stringify(p.variants)},
           ${p.cartCapability}, ${p.addToCartTemplate}, ${p.category ?? null}, ${syncedAt})
        ON CONFLICT(product_id) DO UPDATE SET
          title = excluded.title, description = excluded.description, product_url = excluded.product_url,
          image_url = excluded.image_url, images_json = excluded.images_json, price_min = excluded.price_min,
          price_max = excluded.price_max, currency = excluded.currency, available = excluded.available,
          variants_json = excluded.variants_json, cart_capability = excluded.cart_capability,
          add_to_cart_template = excluded.add_to_cart_template, synced_at = excluded.synced_at`;

  // One store: fetch via its adapter, persist, return a status. Failures here are
  // isolated by the caller (Effect.catch), so the batch never aborts.
  const ingestStore = (store: MerchStore) =>
    Effect.gen(function* () {
      const rawProducts = yield* selectAdapter(
        store.platform,
        store.storeUrl,
      ).fetchCatalog(store);
      // Cache product images under stable keys (merch-product:<pid>/<idx>) so
      // they survive source URL changes. Silently falls back to source URLs.
      const products = yield* Effect.forEach(rawProducts, (p) => cacheProductImages(store, p));
      const status: StoreStatus = products.length > 0 ? "ok" : "partial";
      if (!dryRun) {
        yield* Effect.forEach(products, (p) => upsertProduct(store, p), {
          discard: true,
        });
        // Prune this store's stale rows — products dropped from the storefront, or
        // older rows whose external_id derivation changed (which would otherwise
        // accumulate as same-URL duplicates, since product_id keys on external_id).
        // Only when the fetch returned something, so a transient empty/failed fetch
        // never wipes a store's last-known-good catalog.
        if (products.length > 0) {
          yield* sql`DELETE FROM merch_products
                       WHERE store_id = ${store.storeId} AND synced_at <> ${syncedAt}`;
        }
        yield* sql`UPDATE merch_stores
                     SET product_count = ${products.length}, last_synced_at = ${syncedAt}, sync_status = ${status}
                   WHERE store_id = ${store.storeId}`;
      }
      return {
        store,
        count: products.length,
        status,
        error: null as string | null,
      };
    });

  const results = yield* Effect.forEach(
    stores,
    (store) =>
      ingestStore(store).pipe(
        // Isolate per-store failure → an "error" result, never abort the batch.
        // catchCause (not catch) so an unexpected DEFECT (e.g. a bad store URL
        // throwing in new URL()) is contained too, not just typed errors.
        Effect.catchCause((cause) =>
          Effect.succeed({
            store,
            count: 0,
            status: "error" as StoreStatus,
            error: Cause.pretty(cause),
          }),
        ),
        Effect.tap((r) =>
          Ref.updateAndGet(done, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              Effect.logInfo(
                `[${n}/${stores.length}] ${r.store.name} (${r.store.platform}) → ${r.count} products${
                  r.error ? ` ⚠️ ${r.error}` : ""
                }`,
              ),
            ),
          ),
        ),
      ),
    { concurrency },
  );

  const totalProducts = results.reduce((n, r) => n + r.count, 0);
  const byStatus = { ok: 0, partial: 0, error: 0 };
  for (const r of results) byStatus[r.status]++;
  yield* Effect.logInfo(
    `=== Summary === stores=${results.length} products=${totalProducts} ` +
      `ok/partial/error=${byStatus.ok}/${byStatus.partial}/${byStatus.error}${dryRun ? " (dry run)" : ""}`,
  );
});

const SqlLive = LibsqlClient.layer({ url: DB_URL });
// Browserbase is optional: provide the layer only when a key is set (its
// construction fails otherwise); adapters read it via serviceOption regardless.
// Always provide the render layer — local Chromium (free) when present, with
// Browserbase as fallback only. No API key required.
const BrowserbaseLive = BrowserbaseServiceLive;

Effect.runPromise(
  program.pipe(Effect.provide(Layer.mergeAll(SqlLive, BrowserbaseLive))),
).catch((err) => {
  console.error("ingestMerch failed:", err);
  process.exitCode = 1;
});
