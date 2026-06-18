// Discover + ingest a high-quality logo for each merch group that has NO corps
// logo (vendors like Funliner, Lot Riot, MBI). We scrape the storefront homepage
// for a real brand logo — JSON-LD Organization logo → og:image → header <img> →
// apple-touch-icon (NOT the low-res /favicon.ico) — record the URL on
// merch_stores.store_logo, and download the bytes into the media cache so the app
// serves them via the /api/media proxy (cache-hit-regardless-of-host).
//
// Corps stores are intentionally skipped — they already use the corps logo.
//
// Usage (from sdk/):
//   MEDIA_CACHE_DB_URL=file:/data/corps-place/media-cache.db \
//     npx tsx scripts/scanStoreLogos.ts            # ingest into the prod cache
//   npx tsx scripts/scanStoreLogos.ts --refresh    # re-download even if cached

import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect, Layer } from "effect";
import { load } from "cheerio";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { MediaService, makeMediaServiceLayer } from "../src/mediaService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");

const DB_URL =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const MEDIA_DB_URL =
  process.env.MEDIA_CACHE_DB_URL ??
  `file:${resolve(SDK_DIR, "media-cache.db")}`;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const absolutize = (url: string | undefined, base: string): string | null => {
  if (!url) return null;
  try {
    return new URL(url.startsWith("//") ? `https:${url}` : url, base).href;
  } catch {
    return null;
  }
};

// Best brand logo from a homepage, in descending quality order.
const extractLogo = (html: string, origin: string): string | null => {
  const $ = load(html);

  // 1. JSON-LD Organization/WebSite logo (string or ImageObject.url).
  let jsonLd: string | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (jsonLd) return;
    try {
      const data = JSON.parse($(el).contents().text());
      const nodes: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as any)["@graph"])
          ? (data as any)["@graph"]
          : [data];
      for (const n of nodes) {
        const logo = (n as any)?.logo;
        if (typeof logo === "string" && logo) {
          jsonLd = logo;
          return;
        }
        if (logo && typeof logo === "object" && typeof logo.url === "string") {
          jsonLd = logo.url;
          return;
        }
      }
    } catch {
      /* malformed JSON-LD — skip */
    }
  });
  if (jsonLd) return absolutize(jsonLd, origin);

  // 2. og:image (skip Shopify's "no-image" placeholder + sprites).
  const og = $('meta[property="og:image"]').attr("content");
  if (og && !/no-image|placeholder|sprite|default/i.test(og)) {
    return absolutize(og, origin);
  }

  // 3. A header <img> that looks like a logo.
  const headerImg = $(
    'header img[src], img.logo[src], img[class*="logo" i][src], img[alt*="logo" i][src]',
  )
    .first()
    .attr("src");
  if (headerImg) return absolutize(headerImg, origin);

  // 4. apple-touch-icon (180px-class, decent) — last resort, never /favicon.ico.
  const ati = $('link[rel="apple-touch-icon"]').attr("href");
  if (ati) return absolutize(ati, origin);

  return null;
};

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const media = yield* MediaService;

  // Groups with products but no corps logo (LEFT JOIN — vendors have no corps).
  const stores = yield* sql<{
    store_id: string;
    name: string;
    store_url: string;
  }>`SELECT s.store_id, s.name, s.store_url
       FROM merch_stores s
       LEFT JOIN corps c ON c.corps_key = s.corps_key
      WHERE COALESCE(s.listed, 1) = 1
        AND s.product_count > 0
        AND (c.corps_logo IS NULL OR c.corps_logo = '')`;

  yield* Effect.logInfo(`Scanning ${stores.length} logo-less groups`);

  for (const store of stores) {
    yield* Effect.gen(function* () {
      const origin = new URL(
        /^https?:\/\//i.test(store.store_url)
          ? store.store_url
          : `https://${store.store_url}`,
      ).origin;

      const html = yield* Effect.tryPromise(() =>
        fetch(origin, { headers: { "user-agent": UA } }).then((r) =>
          r.ok ? r.text() : "",
        ),
      );
      const logoUrl = html ? extractLogo(html, origin) : null;
      if (!logoUrl) {
        yield* Effect.logWarning(`${store.name}: no logo found at ${origin}`);
        return;
      }

      // Record the URL + ingest the bytes into the media cache.
      yield* sql`UPDATE merch_stores SET store_logo = ${logoUrl} WHERE store_id = ${store.store_id}`;
      yield* media.cache({
        ownerType: "merch_store",
        ownerId: store.store_id,
        role: "logo",
        sourceUrl: logoUrl,
        refresh,
        attribution: origin,
        metadata: { via: "store-site" },
      });
      yield* Effect.logInfo(`${store.name} → ${logoUrl}`);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`${store.name}: ${String(cause)}`),
      ),
    );
  }
});

Effect.runPromise(
  program.pipe(
    Effect.provide(makeMediaServiceLayer({ cacheDbUrl: MEDIA_DB_URL })),
    Effect.provide(LibsqlClient.layer({ url: DB_URL })),
  ),
).catch((err) => {
  console.error("scanStoreLogos failed:", err);
  process.exitCode = 1;
});
