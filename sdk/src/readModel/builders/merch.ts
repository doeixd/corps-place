// Merch read-model builders (docs/plans/MERCH_PLAN.md §5). Read the frozen
// merch_stores / merch_products tables from the source DB and shape them into the
// payloads the app serves as static shards (catalog index + facets, store
// directory, per-product / per-store detail, and per-corps teasers). The same
// shapes are returned by the app-side reader so SSR and static can't drift.

import type { Client } from "@libsql/client";

/** The group-logo fields a product card needs (mirrors corpsLogoSource's input). */
export interface MerchLogoFields {
  corps_logo: string | null;
  corps_logo_dark: number | null;
  corps_logo_dark_url: string | null;
}

export interface MerchProductSummary {
  productId: string;
  storeId: string;
  storeName: string;
  title: string;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  image: string | null;
  available: boolean | null;
  cartCapability: "prefill" | "link";
  category: string | null;
  productUrl: string;
  /** Human-readable slug for the selling group's storefront URL (corps slug for
   *  corps stores, else the already-slugified store_id). See buildMerchStores. */
  storeSlug: string;
  /** Corps logo fields for the selling group (null for non-corps vendors). */
  logo: MerchLogoFields | null;
  /** Scraped + cached storefront logo (vendor groups w/o a corps logo). */
  storeLogo: string | null;
}

export interface MerchVariant {
  id: string;
  title: string;
  price: number | null;
  available: boolean | null;
}

export interface MerchProductDetail extends MerchProductSummary {
  description: string | null;
  images: string[];
  variants: MerchVariant[];
  addToCartTemplate: string | null;
  storePlatform: string | null;
}

export interface MerchStoreSummary {
  storeId: string;
  name: string;
  kind: string;
  platform: string | null;
  storeUrl: string;
  cartCapability: string | null;
  productCount: number;
  corpsKey: string | null;
  /** Human-readable slug for the storefront URL: the corps slug for corps stores,
   *  else the (already-slugified) store_id. Unique per store; used by /shop/group. */
  slug: string;
  /** Corps logo fields for the group (null for non-corps vendors). Joined here at
   *  build time so the group logo never depends on rm_corps directory coverage. */
  logo: MerchLogoFields | null;
  /** Scraped storefront logo (vendors w/o a corps logo); see scanStoreLogos.ts. */
  storeLogo: string | null;
}

export interface MerchFacets {
  platforms: { value: string; count: number }[];
  stores: { storeId: string; name: string; count: number }[];
  priceBuckets: {
    label: string;
    min: number;
    max: number | null;
    count: number;
  }[];
  categories: { value: string; count: number }[];
  total: number;
}

export interface CorpsMerchTeaser {
  storeId: string;
  /** Human-readable storefront slug (corps slug); used by the /shop/group link. */
  storeSlug: string;
  storeName: string;
  storeUrl: string;
  cartCapability: string | null;
  products: MerchProductSummary[];
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const bool = (v: unknown): boolean | null =>
  v === null || v === undefined ? null : Number(v) !== 0;
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

const rowToSummary = (r: Record<string, unknown>): MerchProductSummary => {
  const corpsLogo = str(r.corps_logo);
  return {
    productId: String(r.product_id),
    storeId: String(r.store_id),
    storeName: String(r.store_name ?? ""),
    title: String(r.title),
    priceMin: num(r.price_min),
    priceMax: num(r.price_max),
    currency: str(r.currency),
    image: str(r.image_url),
    available: bool(r.available),
    cartCapability: (str(r.cart_capability) as "prefill" | "link") ?? "link",
    category: str(r.category),
    productUrl: String(r.product_url),
    // Corps stores link by their corps slug; vendors by their (slugified) store_id.
    // Treat an empty/missing corps slug as absent so the URL never collapses to "".
    storeSlug: str(r.corps_slug) || String(r.store_id),
    // Only carry corps logo fields when the group actually has a corps logo;
    // otherwise the card falls back to the scraped storefront logo / monogram.
    logo: corpsLogo
      ? {
          corps_logo: corpsLogo,
          corps_logo_dark: num(r.corps_logo_dark) ?? 0,
          corps_logo_dark_url: str(r.corps_logo_dark_url),
        }
      : null,
    storeLogo: str(r.store_logo),
  };
};

// Tolerate a DB that was never merch-ingested (no merch_* tables): return [] so a
// read-model emit on such a source still succeeds with an empty catalog.
const rowsOrEmpty = async (
  db: Client,
  statement: string | { sql: string; args: ReadonlyArray<string | number> },
): Promise<Record<string, unknown>[]> => {
  try {
    const res = await db.execute(statement as never);
    return res.rows as unknown as Record<string, unknown>[];
  } catch {
    return [];
  }
};

// The JOIN's `listed` guard hides products from opted-out stores everywhere
// SUMMARY_SELECT is used (catalog index, teasers). `IN_STOCK` additionally hides
// products that are *explicitly* sold out (available = 0); unknown availability
// (NULL — most non-Shopify stores don't report it) stays visible. Lives in the
// JOIN's ON so it composes with the teaser's appended `WHERE p.store_id = ?`.
const IN_STOCK = `(p.available IS NULL OR p.available <> 0)`;
const SUMMARY_SELECT = `
  SELECT p.product_id, p.store_id, s.name AS store_name, p.title, p.price_min, p.price_max,
         p.currency, p.image_url, p.available, p.cart_capability, p.category, p.product_url,
         s.store_logo, c.slug AS corps_slug, c.corps_logo, c.corps_logo_dark, c.corps_logo_dark_url
    FROM merch_products p
    JOIN merch_stores s ON s.store_id = p.store_id AND COALESCE(s.listed, 1) = 1 AND ${IN_STOCK}
    LEFT JOIN corps c ON c.corps_key = s.corps_key`;

/**
 * Full catalog index (list-render fields only) — the emitter paginates this.
 *
 * Deduped by product URL: sibling corps that share one storefront (e.g. the
 * Bluecoats family, Blue Devils A/B/C, Colts/Colt Cadets, Mandarins/Mandarins
 * Alumni) each ingest the SAME products under their own store_id, so the same
 * physical product otherwise appears 2–4× in the catalog. We keep the first
 * occurrence per URL — the ORDER BY (available, then store name) makes the
 * canonical/parent corps win alphabetically in the common cases.
 */
export const buildMerchCatalogIndex = async (
  db: Client,
): Promise<MerchProductSummary[]> => {
  const rows = await rowsOrEmpty(
    db,
    `${SUMMARY_SELECT} ORDER BY p.available DESC, s.name, p.title`,
  );
  const seen = new Set<string>();
  const out: MerchProductSummary[] = [];
  for (const r of rows) {
    const summary = rowToSummary(r);
    if (seen.has(summary.productUrl)) continue;
    seen.add(summary.productUrl);
    out.push(summary);
  }
  return out;
};

/** Per-product detail objects keyed by productId. */
export const buildMerchProductDetails = async (
  db: Client,
): Promise<Map<string, MerchProductDetail>> => {
  const rows = await rowsOrEmpty(
    db,
    `SELECT p.*, s.name AS store_name, s.platform AS store_platform, s.store_logo,
            c.slug AS corps_slug, c.corps_logo, c.corps_logo_dark, c.corps_logo_dark_url
       FROM merch_products p
       JOIN merch_stores s ON s.store_id = p.store_id AND COALESCE(s.listed, 1) = 1 AND ${IN_STOCK}
       LEFT JOIN corps c ON c.corps_key = s.corps_key`,
  );
  const out = new Map<string, MerchProductDetail>();
  for (const r of rows) {
    let images: string[] = [];
    let variants: MerchVariant[] = [];
    try {
      images = r.images_json
        ? (JSON.parse(String(r.images_json)) as string[])
        : [];
    } catch {
      /* ignore */
    }
    try {
      variants = r.variants_json
        ? (JSON.parse(String(r.variants_json)) as MerchVariant[])
        : [];
    } catch {
      /* ignore */
    }
    out.set(String(r.product_id), {
      ...rowToSummary(r),
      description: str(r.description),
      images,
      variants,
      addToCartTemplate: str(r.add_to_cart_template),
      storePlatform: str(r.store_platform),
    });
  }
  return out;
};

/** Store directory — every seeded store (zero-product stores still link out). */
export const buildMerchStores = async (
  db: Client,
): Promise<MerchStoreSummary[]> => {
  const rows = await rowsOrEmpty(
    db,
    // Count IN-STOCK products live so the directory count matches the filtered
    // catalog (s.product_count is the denormalized total incl. out-of-stock).
    `SELECT s.store_id, s.name, s.kind, s.platform, s.store_url, s.cart_capability,
            (SELECT COUNT(*) FROM merch_products p
              WHERE p.store_id = s.store_id AND ${IN_STOCK}) AS product_count,
            s.corps_key, s.store_logo, c.slug AS corps_slug,
            c.corps_logo, c.corps_logo_dark, c.corps_logo_dark_url
       FROM merch_stores s
       LEFT JOIN corps c ON c.corps_key = s.corps_key
      WHERE COALESCE(s.listed, 1) = 1 ORDER BY product_count DESC, s.name`,
  );
  return rows.map((r) => {
    const corpsLogo = str(r.corps_logo);
    return {
    storeId: String(r.store_id),
    name: String(r.name),
    kind: String(r.kind),
    platform: str(r.platform),
    storeUrl: String(r.store_url),
    cartCapability: str(r.cart_capability),
    productCount: Number(r.product_count ?? 0),
    corpsKey: str(r.corps_key),
    // Corps stores link by their corps slug; vendors by the (slugified) store_id.
    // Treat an empty/missing corps slug as absent so the slug never collapses to "".
    slug: str(r.corps_slug) || String(r.store_id),
    logo: corpsLogo
      ? {
          corps_logo: corpsLogo,
          corps_logo_dark: num(r.corps_logo_dark) ?? 0,
          corps_logo_dark_url: str(r.corps_logo_dark_url),
        }
      : null,
    storeLogo: str(r.store_logo),
    };
  });
};

// NOTE: buckets are applied to priceMin regardless of currency. Catalog is
// overwhelmingly USD; a handful of non-USD stores land in $-labeled buckets.
// Acceptable for filtering; revisit if multi-currency coverage grows.
const PRICE_BUCKETS: { label: string; min: number; max: number | null }[] = [
  { label: "Under $20", min: 0, max: 20 },
  { label: "$20–$50", min: 20, max: 50 },
  { label: "$50–$100", min: 50, max: 100 },
  { label: "$100+", min: 100, max: null },
];

/** Precomputed filter facets for instant client-side filtering. */
export const buildMerchFacets = async (db: Client): Promise<MerchFacets> => {
  const index = await buildMerchCatalogIndex(db);
  const platforms = new Map<string, number>();
  const stores = new Map<string, { name: string; count: number }>();
  const categories = new Map<string, number>();
  const buckets = PRICE_BUCKETS.map((b) => ({ ...b, count: 0 }));

  // platform per store (index carries storeId only)
  const storePlatform = new Map<string, string>();
  for (const s of await buildMerchStores(db))
    storePlatform.set(s.storeId, s.platform ?? "unknown");

  for (const p of index) {
    const plat = storePlatform.get(p.storeId) ?? "unknown";
    platforms.set(plat, (platforms.get(plat) ?? 0) + 1);
    const st = stores.get(p.storeId) ?? { name: p.storeName, count: 0 };
    st.count++;
    stores.set(p.storeId, st);
    if (p.category)
      categories.set(p.category, (categories.get(p.category) ?? 0) + 1);
    const price = p.priceMin;
    if (price !== null) {
      const b = buckets.find(
        (x) => price >= x.min && (x.max === null || price < x.max),
      );
      if (b) b.count++;
    }
  }

  return {
    platforms: [...platforms]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
    stores: [...stores]
      .map(([storeId, v]) => ({ storeId, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count),
    priceBuckets: buckets.filter((b) => b.count > 0),
    categories: [...categories]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count),
    total: index.length,
  };
};

/**
 * Per-corps teaser: corps slug → top N products from that corps's store.
 * Used by the corps profile Merch section (§23.3). Returned for every corps with
 * a (listed) store so the Shop link always shows — including link-only siblings
 * that share another corps's storefront and carry no products of their own (their
 * `products` is simply empty, so the profile shows the link without a grid).
 */
export const buildCorpsMerchTeasers = async (
  db: Client,
  limit = 8,
): Promise<Map<string, CorpsMerchTeaser>> => {
  const stores = await rowsOrEmpty(
    db,
    `SELECT s.store_id, s.name, s.store_url, s.cart_capability, c.slug AS corps_slug
       FROM merch_stores s
       JOIN corps c ON c.corps_key = s.corps_key
      WHERE s.kind = 'corps' AND c.slug IS NOT NULL
        AND COALESCE(s.listed, 1) = 1`,
  );

  const out = new Map<string, CorpsMerchTeaser>();
  for (const s of stores) {
    const storeId = String(s.store_id);
    const products = await rowsOrEmpty(db, {
      sql: `${SUMMARY_SELECT} WHERE p.store_id = ? ORDER BY p.available DESC, p.title LIMIT ?`,
      args: [storeId, limit],
    });
    out.set(String(s.corps_slug), {
      storeId,
      storeSlug: String(s.corps_slug),
      storeName: String(s.name),
      storeUrl: String(s.store_url),
      cartCapability: str(s.cart_capability),
      products: products.map(rowToSummary),
    });
  }
  return out;
};
