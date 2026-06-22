// Validate merch image durability after ingest.
//
// Fails on stable `merch-product:` keys missing from media-cache.db, because those
// cannot be fetched on demand by the app. Raw source URLs are reported so the
// ingest adapters can be tightened over time without blocking existing stores
// that still rely on fetch-on-miss.

import { createClient } from "@libsql/client";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const stripFile = (value: string | undefined, fallback: string): string =>
  value ? value.replace(/^file:/, "") : fallback;

const relDb = stripFile(
  process.env.DCI_RELATIONAL_DB_URL,
  resolve(SDK_DIR, "dci-relational.db"),
);
const mediaDb = stripFile(
  process.env.MEDIA_CACHE_DB_URL,
  resolve(SDK_DIR, "media-cache.db"),
);

type SummaryRow = {
  products: number;
  stable: number;
  cached_stable: number;
  raw: number;
  missing_stable: number;
};

type StoreRow = {
  store_id: string;
  name: string;
  products: number;
  stable: number;
  cached_stable: number;
  raw: number;
  missing_stable: number;
};

const asNumber = (value: unknown): number => Number(value ?? 0);

const main = async () => {
  const db = createClient({ url: `file:${relDb}` });
  await db.execute(`ATTACH '${mediaDb.replaceAll("'", "''")}' AS media`);

  const summaryRes = await db.execute(`
    SELECT
      COUNT(*) AS products,
      SUM(CASE WHEN p.image_url LIKE 'merch-product:%' THEN 1 ELSE 0 END) AS stable,
      SUM(CASE WHEN p.image_url LIKE 'merch-product:%' AND c.url IS NOT NULL THEN 1 ELSE 0 END) AS cached_stable,
      SUM(CASE WHEN p.image_url IS NOT NULL AND p.image_url NOT LIKE 'merch-product:%' THEN 1 ELSE 0 END) AS raw,
      SUM(CASE WHEN p.image_url LIKE 'merch-product:%' AND c.url IS NULL THEN 1 ELSE 0 END) AS missing_stable
    FROM merch_products p
    LEFT JOIN media.media_cache c ON c.url = p.image_url AND c.byte_length > 0
  `);
  const s = summaryRes.rows[0] as unknown as SummaryRow;

  console.log(
    `[merch-images] products=${asNumber(s.products)} stable=${asNumber(s.stable)} ` +
      `cachedStable=${asNumber(s.cached_stable)} raw=${asNumber(s.raw)} ` +
      `missingStable=${asNumber(s.missing_stable)}`,
  );

  const missingRes = await db.execute(`
    SELECT
      p.store_id,
      COALESCE(s.name, p.store_id) AS name,
      COUNT(*) AS products,
      SUM(CASE WHEN p.image_url LIKE 'merch-product:%' THEN 1 ELSE 0 END) AS stable,
      SUM(CASE WHEN p.image_url LIKE 'merch-product:%' AND c.url IS NOT NULL THEN 1 ELSE 0 END) AS cached_stable,
      SUM(CASE WHEN p.image_url IS NOT NULL AND p.image_url NOT LIKE 'merch-product:%' THEN 1 ELSE 0 END) AS raw,
      SUM(CASE WHEN p.image_url LIKE 'merch-product:%' AND c.url IS NULL THEN 1 ELSE 0 END) AS missing_stable
    FROM merch_products p
    LEFT JOIN merch_stores s ON s.store_id = p.store_id
    LEFT JOIN media.media_cache c ON c.url = p.image_url AND c.byte_length > 0
    GROUP BY p.store_id
    HAVING missing_stable > 0
    ORDER BY missing_stable DESC, products DESC
  `);

  if (missingRes.rows.length > 0) {
    console.error("[merch-images] ERROR: stable image keys missing from media-cache.db:");
    for (const r of missingRes.rows as unknown as StoreRow[]) {
      console.error(
        `  ${r.name} (${r.store_id}): missing=${asNumber(r.missing_stable)} ` +
          `stable=${asNumber(r.stable)} products=${asNumber(r.products)}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const rawRes = await db.execute(`
    SELECT
      p.store_id,
      COALESCE(s.name, p.store_id) AS name,
      COUNT(*) AS products,
      SUM(CASE WHEN p.image_url LIKE 'merch-product:%' THEN 1 ELSE 0 END) AS stable,
      SUM(CASE WHEN p.image_url IS NOT NULL AND p.image_url NOT LIKE 'merch-product:%' THEN 1 ELSE 0 END) AS raw
    FROM merch_products p
    LEFT JOIN merch_stores s ON s.store_id = p.store_id
    GROUP BY p.store_id
    HAVING raw > 0
    ORDER BY raw DESC, products DESC
    LIMIT 12
  `);

  if (rawRes.rows.length > 0) {
    console.warn(
      "[merch-images] WARN: stores still using raw source image URLs (fetch-on-miss path):",
    );
    for (const r of rawRes.rows as unknown as StoreRow[]) {
      console.warn(
        `  ${r.name} (${r.store_id}): raw=${asNumber(r.raw)} ` +
          `stable=${asNumber(r.stable)} products=${asNumber(r.products)}`,
      );
    }
  }
};

main().catch((err) => {
  console.error("[merch-images] FAILED:", err?.message ?? err);
  process.exitCode = 1;
});
