// Merch catalog ingestion — per-platform adapters that fetch a store's products
// and normalize them to a single shape (docs/plans/MERCH_PLAN.md §4, §17).
//
// Effect-native: every adapter returns an Effect; HTTP goes through Effect.tryPromise
// with a bounded timeout + transient-only retry (Schedule), and the JS-rendered
// fallback reuses the BrowserbaseService LAYER opportunistically via
// Effect.serviceOption (so adapters run with or without it provided — no API key
// required for the direct path). All platform-specific quirks live HERE; everything
// downstream sees only `platform` + `cartCapability`. External payloads are decoded
// with effect/Schema at the boundary and undecodable rows are dropped.

import * as cheerio from "cheerio";
import { Duration, Effect, Option, Schedule } from "effect";
import { Schema } from "effect";
import * as Match from "effect/Match";
import { optionalWith, Union } from "./schemaCompat.js";
import { MerchFetchError } from "./errors.js";
import { BrowserbaseService } from "./browserbaseService.js";

export type MerchPlatform =
  | "shopify"
  | "woocommerce"
  | "bigcommerce"
  | "bigcartel"
  | "squarespace"
  | "wix"
  | "other-ecommerce"
  | "none"
  | "unknown"
  | string;

export interface MerchStore {
  readonly storeId: string;
  readonly name: string;
  readonly platform: MerchPlatform;
  readonly storeUrl: string;
}

export interface NormalizedVariant {
  readonly id: string;
  readonly title: string;
  readonly price: number | null;
  readonly available: boolean | null;
}

export interface NormalizedProduct {
  readonly externalId: string;
  readonly title: string;
  readonly description: string | null;
  readonly productUrl: string;
  readonly image: string | null;
  readonly images: string[];
  readonly priceMin: number | null;
  readonly priceMax: number | null;
  readonly currency: string | null;
  readonly available: boolean | null;
  readonly variants: NormalizedVariant[];
  readonly cartCapability: "prefill" | "link";
  readonly addToCartTemplate: string | null;
  readonly category?: string | null;
}

export interface FetchOpts {
  readonly timeoutMs?: number;
  /** Hard cap on paginated requests per store (safety). */
  readonly maxPages?: number;
}

// Adapters never require Browserbase in their R channel — it's read opportunistically
// via serviceOption, so they run whether or not BrowserbaseServiceLive is provided.
export interface MerchAdapter {
  readonly platform: string;
  readonly fetchCatalog: (
    store: MerchStore,
    opts?: FetchOpts,
  ) => Effect.Effect<NormalizedProduct[], MerchFetchError, never>;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml";
const DEFAULT_TIMEOUT_MS = 15000;

// Tolerate a stored URL missing its scheme (e.g. "www.example.org") rather than
// throwing a defect deep in an adapter.
const originOf = (url: string): string =>
  new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).origin;

// Retry transient failures only (network/abort = 0, 429, 5xx). Deterministic
// failures use distinct codes — 404 (disabled endpoint) and -1 (decode) — so they
// are never classified transient even if httpJson is later wrapped in a retry.
const isTransient = (e: MerchFetchError) =>
  e.statusCode === 0 || e.statusCode === 429 || e.statusCode >= 500;
const retrySchedule = Schedule.exponential(Duration.millis(400)).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.jittered,
);

/** GET text with a bounded AbortController timeout + transient retry. */
const httpText = (
  url: string,
  timeoutMs: number,
  accept: string,
): Effect.Effect<string, MerchFetchError> =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": USER_AGENT, Accept: accept },
          redirect: "follow",
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new MerchFetchError({
            message: `HTTP ${res.status}`,
            url,
            statusCode: res.status,
          });
        }
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (cause) =>
      cause instanceof MerchFetchError
        ? cause
        : new MerchFetchError({
            message: String((cause as Error)?.message ?? cause),
            url,
            statusCode: 0,
            cause,
          }),
  }).pipe(Effect.retry({ schedule: retrySchedule, while: isTransient }));

/** GET + parse JSON (a parse failure is a non-transient MerchFetchError). */
const httpJson = (
  url: string,
  timeoutMs: number,
): Effect.Effect<unknown, MerchFetchError> =>
  httpText(url, timeoutMs, "application/json").pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: () =>
          new MerchFetchError({
            message: "invalid JSON response",
            url,
            statusCode: -1, // deterministic decode failure — not transient
          }),
      }),
    ),
  );

const orEmpty = (eff: Effect.Effect<string, MerchFetchError>) =>
  eff.pipe(Effect.catch(() => Effect.succeed("")));

/**
 * Fetch HTML, falling back to Browserbase for JS-rendered/blocked pages. Never
 * fails (returns "" when both paths fail), so callers can treat "no HTML" as
 * "no product". Browserbase is read via serviceOption — optional, no R requirement.
 *
 * `wantSignal` lets a caller demand the *rendered* page: client-rendered stores
 * (e.g. bkmarketplace, Shopify Hydrogen) return a non-empty SPA shell over a plain
 * fetch, but the product JSON-LD only exists after hydration. When the direct HTML
 * doesn't satisfy `wantSignal`, we escalate to a Browserbase render even though the
 * shell is non-empty — then keep whichever response carries the signal.
 */
const fetchHtmlWithFallback = (
  url: string,
  timeoutMs: number,
  wantSignal?: (html: string) => boolean,
): Effect.Effect<string, never, never> =>
  Effect.gen(function* () {
    const direct = yield* orEmpty(httpText(url, timeoutMs, HTML_ACCEPT));
    const satisfied = (h: string) =>
      h.trim().length > 0 && (!wantSignal || wantSignal(h));
    if (satisfied(direct)) return direct;
    const bb = yield* Effect.serviceOption(BrowserbaseService);
    if (Option.isSome(bb)) {
      const viaBb = yield* bb.value
        .fetchHtml(url)
        .pipe(Effect.catch(() => Effect.succeed("")));
      if (satisfied(viaBb)) return viaBb;
      // Render didn't carry the signal either — still prefer it if it's richer
      // than the direct shell (e.g. a Cloudflare 403 body vs the real page).
      if (viaBb.trim().length > direct.trim().length) return viaBb;
    }
    return direct;
  });

/** True when HTML carries a schema.org Product (the universal adapter's signal). */
const hasProductJsonLd = (html: string): boolean =>
  /<script[^>]+application\/ld\+json/i.test(html) &&
  /"@type"\s*:\s*(?:"Product"|\[[^\]]*"Product")/i.test(html);

/**
 * True when the STATIC HTML already carries enough for productFromHtml to extract
 * a product — JSON-LD Product, OpenGraph `product` type / price, or an og:image +
 * og:title pair. Used as the render-escalation gate: we only spend a headless
 * render on a page that is a genuinely bare SPA shell (none of these present).
 *
 * Without this, every universal product page that lacks JSON-LD (Woo/WordPress
 * stores like spartansdbc.org, Printify SPAs like the Northern Lights store) would
 * escalate to a render even though its og: tags are right there in the static
 * markup — hundreds of needless renders that swamp a memory-tight box.
 */
const hasExtractableProductSignal = (html: string): boolean =>
  hasProductJsonLd(html) ||
  /property=["']og:type["'][^>]*content=["']product/i.test(html) ||
  /property=["']product:price:amount["']/i.test(html) ||
  (/property=["']og:image["']/i.test(html) &&
    /property=["']og:title["']/i.test(html));

const toNumber = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const priceRange = (
  prices: ReadonlyArray<number | null>,
): [number | null, number | null] => {
  const nums = prices.filter((p): p is number => p !== null);
  if (nums.length === 0) return [null, null];
  return [Math.min(...nums), Math.max(...nums)];
};

// Aggregate per-variant availability: any in-stock → true, any explicitly
// out-of-stock → false, all-unknown (or no variants) → null.
const aggregateAvailable = (
  variants: ReadonlyArray<NormalizedVariant>,
): boolean | null => {
  if (variants.some((v) => v.available === true)) return true;
  if (variants.some((v) => v.available === false)) return false;
  return null;
};

const stripHtml = (html: string | null | undefined): string | null =>
  html
    ? html
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim() || null
    : null;

/**
 * BigCommerce percent-encodes the `description` in its JSON-LD (spaces → %20, so
 * the whole string has no raw whitespace). Decode those; leave normal prose (which
 * has spaces) untouched. Guarded so a malformed/partial sequence is left as-is.
 */
export const maybeUrlDecode = (s: string): string => {
  if (!/%[0-9A-Fa-f]{2}/.test(s) || /\s/.test(s)) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Fold a platform's freeform category/type/tag into a small canonical set for the
// catalog facet; unknown values pass through (trimmed) rather than being dropped.
const CATEGORY_SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [
    /t-?shirt|\btee\b|\bshirt|hoodie|sweatshirt|crewneck|apparel|clothing|outerwear|jacket|polo|shorts|pants|jersey/i,
    "Apparel",
  ],
  [/\bhats?\b|\bcaps?\b|beanie|headwear|visor/i, "Headwear"],
  [
    /pin\b|sticker|patch|lanyard|keychain|accessor|bag|towel|flag|decal/i,
    "Accessories",
  ],
  [/music|recording|audio|\bcd\b|vinyl|download|media/i, "Music"],
  [/ticket|admission/i, "Tickets"],
  [/donat|sponsor|support|fund/i, "Donations"],
];

const normalizeCategory = (raw: string | null | undefined): string | null => {
  const t = (raw ?? "").trim();
  if (!t) return null;
  for (const [re, label] of CATEGORY_SYNONYMS) if (re.test(t)) return label;
  return t.length > 40 ? t.slice(0, 40).trim() : t;
};

// --- Shopify --------------------------------------------------------------

const ShopifyVariant = Schema.Struct({
  id: Union(Schema.Number, Schema.String),
  title: Schema.String.pipe(optionalWith({ default: () => "Default" })),
  price: Union(Schema.String, Schema.Number).pipe(
    optionalWith({ nullable: true }),
  ),
  available: Schema.Boolean.pipe(optionalWith({ nullable: true })),
});
const ShopifyImage = Schema.Struct({ src: Schema.String });
const ShopifyProduct = Schema.Struct({
  id: Union(Schema.Number, Schema.String),
  title: Schema.String,
  handle: Schema.String,
  body_html: Schema.String.pipe(optionalWith({ nullable: true })),
  product_type: Schema.String.pipe(optionalWith({ nullable: true })),
  tags: Schema.Array(Schema.String).pipe(optionalWith({ default: () => [] })),
  images: Schema.Array(ShopifyImage).pipe(optionalWith({ default: () => [] })),
  variants: Schema.Array(ShopifyVariant).pipe(
    optionalWith({ default: () => [] }),
  ),
});
const decodeShopify = Schema.decodeUnknownOption(ShopifyProduct);

const shopifyAdapter: MerchAdapter = {
  platform: "shopify",
  fetchCatalog: (store, opts) =>
    Effect.gen(function* () {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxPages = opts?.maxPages ?? 10;
      const origin = originOf(store.storeUrl);
      const out: NormalizedProduct[] = [];
      for (let page = 1; page <= maxPages; page++) {
        // Headless Shopify (Hydrogen, e.g. store.dci.org) disables /products.json
        // → 404. Fall back to the universal sitemap + rendered-DOM path, which
        // reads the storefront like any other client-rendered store.
        const jsonOpt = yield* httpJson(
          `${origin}/products.json?limit=250&page=${page}`,
          timeoutMs,
        ).pipe(
          Effect.map(Option.some),
          Effect.catch((e) =>
            e.statusCode === 404 && page === 1
              ? Effect.succeed(Option.none<unknown>())
              : Effect.fail(e),
          ),
        );
        if (Option.isNone(jsonOpt))
          return yield* universalJsonLdAdapter.fetchCatalog(store, opts);
        const json = jsonOpt.value as {
          products?: unknown[];
        };
        const products = Array.isArray(json.products) ? json.products : [];
        if (products.length === 0) break;
        for (const raw of products) {
          const opt = decodeShopify(raw);
          if (opt._tag === "None") continue;
          const p = opt.value;
          const variants: NormalizedVariant[] = p.variants.map((v) => ({
            id: String(v.id),
            title: v.title ?? "Default",
            price: toNumber(v.price),
            available: v.available ?? null,
          }));
          const [priceMin, priceMax] = priceRange(variants.map((v) => v.price));
          const images = p.images.map((i) => i.src);
          out.push({
            externalId: String(p.id),
            title: p.title,
            description: stripHtml(p.body_html),
            productUrl: `${origin}/products/${p.handle}`,
            image: images[0] ?? null,
            images,
            priceMin,
            priceMax,
            currency: null, // products.json omits currency
            available: aggregateAvailable(variants),
            variants,
            cartCapability: "prefill",
            addToCartTemplate: `${origin}/cart/`, // base; app appends {variantId}:{qty}
            category: normalizeCategory(p.product_type ?? p.tags[0] ?? null),
          });
        }
        if (products.length < 250) break;
      }
      return out;
    }),
};

// --- WooCommerce (Store API, public) -------------------------------------

const WooPrices = Schema.Struct({
  price: Schema.String.pipe(optionalWith({ nullable: true })),
  currency_code: Schema.String.pipe(optionalWith({ nullable: true })),
  currency_minor_unit: Schema.Number.pipe(optionalWith({ default: () => 2 })),
});
const WooImage = Schema.Struct({ src: Schema.String });
const WooProduct = Schema.Struct({
  id: Union(Schema.Number, Schema.String),
  name: Schema.String,
  permalink: Schema.String,
  short_description: Schema.String.pipe(optionalWith({ nullable: true })),
  description: Schema.String.pipe(optionalWith({ nullable: true })),
  is_in_stock: Schema.Boolean.pipe(optionalWith({ nullable: true })),
  prices: WooPrices.pipe(optionalWith({ nullable: true })),
  images: Schema.Array(WooImage).pipe(optionalWith({ default: () => [] })),
  categories: Schema.Array(Schema.Struct({ name: Schema.String })).pipe(
    optionalWith({ default: () => [] }),
  ),
});
const decodeWoo = Schema.decodeUnknownOption(WooProduct);

const wooAdapter: MerchAdapter = {
  platform: "woocommerce",
  fetchCatalog: (store, opts) =>
    Effect.gen(function* () {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxPages = opts?.maxPages ?? 10;
      const origin = originOf(store.storeUrl);
      const out: NormalizedProduct[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const json = yield* httpJson(
          `${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`,
          timeoutMs,
        );
        const products = Array.isArray(json) ? json : [];
        if (products.length === 0) break;
        for (const raw of products) {
          const opt = decodeWoo(raw);
          if (opt._tag === "None") continue;
          const p = opt.value;
          const minor = p.prices?.currency_minor_unit ?? 2;
          const rawPrice = toNumber(p.prices?.price);
          const price = rawPrice === null ? null : rawPrice / 10 ** minor;
          const images = p.images.map((i) => i.src);
          out.push({
            externalId: String(p.id),
            title: p.name,
            description: stripHtml(p.short_description ?? p.description),
            productUrl: p.permalink,
            image: images[0] ?? null,
            images,
            priceMin: price,
            priceMax: price,
            currency: p.prices?.currency_code ?? null,
            available: p.is_in_stock ?? null,
            variants: [],
            cartCapability: "prefill",
            category: normalizeCategory(p.categories[0]?.name ?? null),
            addToCartTemplate: `${p.permalink}?add-to-cart=${p.id}`,
          });
        }
        if (products.length < 100) break;
      }
      return out;
    }),
};

// --- Big Cartel -----------------------------------------------------------

const BigCartelImage = Schema.Struct({ url: Schema.String });
const BigCartelProduct = Schema.Struct({
  id: Union(Schema.Number, Schema.String),
  name: Schema.String,
  url: Schema.String,
  price: Union(Schema.String, Schema.Number).pipe(
    optionalWith({ nullable: true }),
  ),
  status: Schema.String.pipe(optionalWith({ nullable: true })),
  images: Schema.Array(BigCartelImage).pipe(
    optionalWith({ default: () => [] }),
  ),
});
const decodeBigCartel = Schema.decodeUnknownOption(BigCartelProduct);

const bigCartelAdapter: MerchAdapter = {
  platform: "bigcartel",
  fetchCatalog: (store, opts) =>
    Effect.gen(function* () {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const origin = originOf(store.storeUrl);
      const json = yield* httpJson(`${origin}/products.json`, timeoutMs);
      const products = Array.isArray(json) ? json : [];
      const out: NormalizedProduct[] = [];
      for (const raw of products) {
        const opt = decodeBigCartel(raw);
        if (opt._tag === "None") continue;
        const p = opt.value;
        const price = toNumber(p.price);
        const images = p.images.map((i) => i.url);
        const productUrl = p.url.startsWith("http")
          ? p.url
          : `${origin}${p.url}`;
        out.push({
          externalId: String(p.id),
          title: p.name,
          description: null,
          productUrl,
          image: images[0] ?? null,
          images,
          priceMin: price,
          priceMax: price,
          currency: null,
          available: p.status ? p.status === "active" : null,
          variants: [],
          cartCapability: "prefill",
          addToCartTemplate: productUrl,
        });
      }
      return out;
    }),
};

// --- Squarespace (Commerce JSON: `<storePage>?format=json`) --------------

const SqsMoney = Schema.Struct({
  currency: Schema.String.pipe(optionalWith({ nullable: true })),
}).pipe(optionalWith({ nullable: true }));
const SqsVariant = Schema.Struct({
  id: Union(Schema.String, Schema.Number).pipe(optionalWith({ nullable: true })),
  sku: Schema.String.pipe(optionalWith({ nullable: true })),
  price: Schema.Number.pipe(optionalWith({ nullable: true })), // cents
  salePrice: Schema.Number.pipe(optionalWith({ nullable: true })), // cents
  onSale: Schema.Boolean.pipe(optionalWith({ nullable: true })),
  qtyInStock: Schema.Number.pipe(optionalWith({ nullable: true })),
  unlimited: Schema.Boolean.pipe(optionalWith({ nullable: true })),
  priceMoney: SqsMoney,
  optionValues: Schema.Array(
    Schema.Struct({
      value: Schema.String.pipe(optionalWith({ nullable: true })),
    }),
  ).pipe(optionalWith({ default: () => [] })),
});
const SqsStructured = Schema.Struct({
  priceCents: Schema.Number.pipe(optionalWith({ nullable: true })),
  salePriceCents: Schema.Number.pipe(optionalWith({ nullable: true })),
  onSale: Schema.Boolean.pipe(optionalWith({ nullable: true })),
  priceMoney: SqsMoney,
  variants: Schema.Array(SqsVariant).pipe(optionalWith({ default: () => [] })),
});
const SqsItem = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  fullUrl: Schema.String,
  excerpt: Schema.String.pipe(optionalWith({ nullable: true })),
  body: Schema.String.pipe(optionalWith({ nullable: true })),
  assetUrl: Schema.String.pipe(optionalWith({ nullable: true })),
  publishOn: Schema.Number.pipe(optionalWith({ nullable: true })),
  structuredContent: SqsStructured.pipe(optionalWith({ nullable: true })),
});
const decodeSqsItem = Schema.decodeUnknownOption(SqsItem);

const centsToDollars = (c: number | null | undefined): number | null =>
  typeof c === "number" && Number.isFinite(c) ? c / 100 : null;

// Synonym-only category bucket (never echoes a raw title into the facet).
const bucketCategory = (text: string): string | null => {
  for (const [re, label] of CATEGORY_SYNONYMS) if (re.test(text)) return label;
  return null;
};

const squarespaceAdapter: MerchAdapter = {
  platform: "squarespace",
  fetchCatalog: (store, opts) =>
    Effect.gen(function* () {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxPages = opts?.maxPages ?? 30;
      const origin = originOf(store.storeUrl);
      const base = store.storeUrl.split("?")[0]!; // the store/collection page
      const out: NormalizedProduct[] = [];
      const seenIds = new Set<string>();
      let offset: number | null = null;
      for (let page = 0; page < maxPages; page++) {
        const url = `${base}?format=json${offset ? `&offset=${offset}` : ""}`;
        // A page fetch failure (Squarespace sometimes 500s on a stale offset)
        // must not discard products already collected — stop paginating instead.
        const jsonOpt = yield* httpJson(url, timeoutMs).pipe(
          Effect.map(Option.some),
          Effect.catch(() => Effect.succeed(Option.none<unknown>())),
        );
        if (Option.isNone(jsonOpt)) break;
        const json = jsonOpt.value as {
          items?: unknown[];
          pagination?: { nextPage?: boolean; nextPageOffset?: number };
        };
        const items = Array.isArray(json.items) ? json.items : [];
        if (items.length === 0) break;
        let added = 0;
        for (const raw of items) {
          const opt = decodeSqsItem(raw);
          if (opt._tag === "None") continue;
          const it = opt.value;
          const sc = it.structuredContent;
          if (!sc) continue; // not a commerce item
          if (seenIds.has(it.id)) continue;
          seenIds.add(it.id);
          added++;
          const variants: NormalizedVariant[] = (sc.variants ?? []).map((v) => {
            const cents =
              v.onSale && typeof v.salePrice === "number"
                ? v.salePrice
                : v.price;
            const avail =
              v.unlimited === true
                ? true
                : typeof v.qtyInStock === "number"
                  ? v.qtyInStock > 0
                  : null;
            const label = v.optionValues
              .map((o) => o.value)
              .filter(Boolean)
              .join(" / ");
            return {
              id: String(v.id ?? v.sku ?? (label || "default")),
              title: label || "Default",
              price: centsToDollars(cents),
              available: avail,
            };
          });
          const fallbackPrice = centsToDollars(
            sc.onSale ? sc.salePriceCents : sc.priceCents,
          );
          const [vMin, vMax] = priceRange(variants.map((v) => v.price));
          const productUrl = it.fullUrl.startsWith("http")
            ? it.fullUrl
            : `${origin}${it.fullUrl}`;
          const currency =
            sc.priceMoney?.currency ??
            sc.variants?.[0]?.priceMoney?.currency ??
            null;
          out.push({
            externalId: it.id,
            title: it.title,
            description: stripHtml(it.excerpt ?? it.body),
            productUrl,
            image: it.assetUrl ?? null,
            images: it.assetUrl ? [it.assetUrl] : [],
            priceMin: vMin ?? fallbackPrice,
            priceMax: vMax ?? fallbackPrice,
            currency,
            available: aggregateAvailable(variants),
            variants,
            cartCapability: "link", // Squarespace cart prefill needs a session
            addToCartTemplate: null,
            category: bucketCategory(it.title),
          });
        }
        // Squarespace signals more pages via `pagination.nextPageOffset`; absent
        // → single page (don't guess an offset, which 500s on some collections).
        const next = json.pagination?.nextPageOffset ?? null;
        if (added === 0 || !json.pagination?.nextPage || next === null) break;
        if (offset !== null && next >= offset) break; // no progress
        offset = next;
      }
      return out;
    }),
};

// --- Universal fallback: sitemap + schema.org JSON-LD / OpenGraph --------

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");

const UNIVERSAL_MAX_SITEMAPS = 24;
// Full-catalog ceiling (product owner: ingest everything, paginate). A high
// safety backstop, not a target — fetchCatalog logs when it's actually hit so a
// silent truncation is visible.
const UNIVERSAL_MAX_PRODUCTS = 3000;
// Per-store PDP fetch concurrency. Kept modest because client-rendered stores
// open that many heavy (~3 MB) local-Chromium pages at once on a memory-tight box.
const UNIVERSAL_CONCURRENCY = 3;
const PRODUCT_URL_RE =
  /(\/products?\/|\/product-page\/|\/p\/|\/shop\/|\/store\/|\/item\/|\/merch\/)/i;
// Sitemaps that list the actual products — prefer these over a store's other
// sitemaps (Wix lists blog/event sitemaps BEFORE store-products; BigCommerce
// splits by type). Without this priority, non-product URLs starve the pool.
const PRODUCT_SITEMAP_RE =
  /(store-products|type=products|product-sitemap|sitemap[_-]?products|\/products[\/_-]\d|\/sitemap\/products)/i;
// Pages that are never products — skip to avoid wasting fetches.
const NON_PRODUCT_URL_RE =
  /\/(blog|news|category|categories|account|login|cart|checkout|search|policies|pages?|about|contact|faq|privacy|terms|sitemap)\b|\.(jpg|jpeg|png|gif|webp|svg|pdf|css|js)(\?|$)/i;

/** Seed sitemap URLs from robots.txt `Sitemap:` lines + common fallbacks. */
const discoverSitemaps = (
  origin: string,
  timeoutMs: number,
): Effect.Effect<string[], never, never> =>
  Effect.gen(function* () {
    const found = new Set<string>();
    const robots = yield* fetchHtmlWithFallback(
      `${origin}/robots.txt`,
      timeoutMs,
    );
    for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim))
      found.add(m[1]!);
    // Common fallbacks (BigCommerce uses xmlsitemap.php; many use sitemap_index).
    for (const path of [
      "/sitemap.xml",
      "/sitemap_index.xml",
      "/xmlsitemap.php",
    ]) {
      found.add(`${origin}${path}`);
    }
    return [...found];
  });

const locsOf = (xml: string): string[] =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    decodeEntities(m[1]!),
  );

// A LINK to an actual product detail page: a `/product(s)/<slug>` (Woo, Printify,
// Shopify), `/product-page/<slug>` (Wix), `/item/<slug>`, or `/p/<slug>` segment
// with something after it. Tighter than PRODUCT_URL_RE (which also matches bare
// `/shop/` and `/store/` landing/category pages) so anchor-harvesting collects
// products, not category indexes.
const PRODUCT_PAGE_RE = /\/(products?|product-page|item|p|merch)\/[^/?#]+/i;
// Listing pages worth following one level to reach their products (shop landing,
// category/collection indexes, paginated shop pages).
const LISTING_PAGE_RE =
  /\/(shop|store|products|collections?|category|product-category|merch)(\/|\/page\/\d+|$)/i;
const SHOP_SEED_PATHS = ["", "/shop", "/shop/", "/store", "/store/", "/products"];

/**
 * Harvest product-detail URLs by crawling a store's shop/landing pages and
 * reading their anchors — robust against stores whose product sitemap is missing
 * or 404s (common on WooCommerce sites that ship only a posts/pages sitemap).
 * Without this, sitemap discovery falls back to the blog/news sitemap and scrapes
 * articles as "products" while the real `/shop/product/...` pages go unseen.
 *
 * Two bounded levels: collect product + listing anchors from the seed pages, then
 * follow up to a handful of listing pages (categories / shop page 2…) to reach the
 * rest of the catalog. Same-origin only; capped by fetch + product budgets.
 */
const harvestProductAnchors = (
  origin: string,
  timeoutMs: number,
): Effect.Effect<string[], never, never> =>
  Effect.gen(function* () {
    const products = new Set<string>();
    const listings = new Set<string>();
    const visited = new Set<string>();
    const scan = (html: string) => {
      const $ = cheerio.load(html);
      $("a[href]").each((_i, el) => {
        const href = $(el).attr("href");
        if (!href) return;
        let abs: string;
        try {
          abs = new URL(href, origin).toString().split("#")[0]!;
        } catch {
          return;
        }
        if (!abs.startsWith(origin)) return; // same-origin only
        if (PRODUCT_PAGE_RE.test(abs)) products.add(abs);
        else if (LISTING_PAGE_RE.test(abs)) listings.add(abs);
      });
    };

    // Level 0 — seed pages (homepage + common shop roots).
    for (const path of SHOP_SEED_PATHS) {
      const url = `${origin}${path}`;
      if (visited.has(url)) continue;
      visited.add(url);
      const html = yield* fetchHtmlWithFallback(url, timeoutMs);
      if (html) scan(html);
      if (products.size >= UNIVERSAL_MAX_PRODUCTS) return [...products];
    }

    // Level 1 — follow listing pages (categories, shop page 2…) to reach products
    // the landing page didn't link directly. Bounded by the sitemap fetch budget.
    let budget = UNIVERSAL_MAX_SITEMAPS;
    for (const url of listings) {
      if (budget <= 0 || products.size >= UNIVERSAL_MAX_PRODUCTS) break;
      if (visited.has(url)) continue;
      visited.add(url);
      budget--;
      const html = yield* fetchHtmlWithFallback(url, timeoutMs);
      if (html) scan(html);
    }
    return [...products];
  });

/**
 * Collect product URLs from a store's sitemap(s). Two-phase:
 *   1. Expand sitemap *indexes* to their leaf sitemaps.
 *   2. Read leaves, PREFERRING product sitemaps (Wix `store-products-*`,
 *      BigCommerce `?type=products`) — other sitemaps (blog/events) are listed
 *      first by some platforms and would otherwise starve the candidate pool.
 * BigCommerce splits products across `?type=products&page=N`, so we paginate
 * those until a page yields no new URLs. Product-pattern URLs rank ahead of
 * generic leaf URLs (root-level slugs), which the adapter then filters by
 * Product JSON-LD.
 */
const discoverProductUrls = (
  origin: string,
  timeoutMs: number,
): Effect.Effect<string[], never, never> =>
  Effect.gen(function* () {
    // Phase 1 — expand indexes to leaf sitemaps (one level deep covers BC/Wix).
    const leafXml = new Map<string, string>();
    const queue = yield* discoverSitemaps(origin, timeoutMs);
    const visited = new Set<string>();
    let budget = UNIVERSAL_MAX_SITEMAPS;
    while (queue.length > 0 && budget > 0) {
      const sm = queue.shift()!;
      if (visited.has(sm)) continue;
      visited.add(sm);
      budget--;
      const xml = yield* fetchHtmlWithFallback(sm, timeoutMs);
      if (!xml) continue;
      if (/<sitemapindex/i.test(xml)) {
        for (const child of locsOf(xml))
          if (!visited.has(child)) queue.push(child);
      } else {
        leafXml.set(sm, xml);
      }
    }

    // Phase 1.5 — harvest product links straight from the shop/landing pages, so a
    // store with a missing/404 product sitemap (its real products only reachable by
    // crawling /shop/) still gets ingested instead of its blog pages.
    const harvested = yield* harvestProductAnchors(origin, timeoutMs);

    // Phase 2 — read product sitemaps first; fall back to all leaves otherwise.
    const leaves = [...leafXml.keys()];
    const productSitemaps = leaves.filter((s) => PRODUCT_SITEMAP_RE.test(s));
    const ordered = productSitemaps.length > 0 ? productSitemaps : leaves;

    // Harvested product-detail URLs rank first and pre-seed the dedup set.
    const seen = new Set<string>(harvested);
    const productUrls: string[] = [...harvested];
    const genericUrls: string[] = [];
    const total = () => productUrls.length + genericUrls.length;
    const collect = (xml: string) => {
      for (const loc of locsOf(xml)) {
        if (total() >= UNIVERSAL_MAX_PRODUCTS) return;
        if (seen.has(loc) || !/^https?:\/\//i.test(loc)) continue;
        seen.add(loc);
        if (PRODUCT_URL_RE.test(loc)) productUrls.push(loc);
        else if (!NON_PRODUCT_URL_RE.test(loc)) genericUrls.push(loc);
      }
    };

    for (const sm of ordered) {
      if (total() >= UNIVERSAL_MAX_PRODUCTS) break;
      collect(leafXml.get(sm)!);
      // BigCommerce: products are paginated across ?type=products&page=N.
      if (/type=products/i.test(sm)) {
        for (let page = 2; page <= 50 && total() < UNIVERSAL_MAX_PRODUCTS; page++) {
          const pageUrl = /[?&]page=\d+/i.test(sm)
            ? sm.replace(/([?&]page=)\d+/i, `$1${page}`)
            : `${sm}${sm.includes("?") ? "&" : "?"}page=${page}`;
          const before = seen.size;
          collect(yield* fetchHtmlWithFallback(pageUrl, timeoutMs));
          if (seen.size === before) break; // no new URLs → last page
        }
      }
    }
    // When we harvested a real catalog from the shop, trust it and drop the generic
    // sitemap URLs (blog/news/about) — they're not products and would only burn
    // fetches (each escalates to a headless render looking for absent JSON-LD). Gate
    // on a small count so one stray `/p/` anchor can't suppress the generic fallback
    // for a store whose products genuinely live in non-product-pattern URLs.
    const tail = harvested.length >= 3 ? [] : genericUrls;
    return productUrls.concat(tail).slice(0, UNIVERSAL_MAX_PRODUCTS);
  });

const AVAILABILITY_IN_STOCK = /InStock|LimitedAvailability|PreOrder|BackOrder/i;
const AVAILABILITY_OUT = /OutOfStock|SoldOut|Discontinued/i;

const mapAvailability = (v: unknown): boolean | null => {
  if (typeof v !== "string") return null;
  if (AVAILABILITY_IN_STOCK.test(v)) return true;
  if (AVAILABILITY_OUT.test(v)) return false;
  return null;
};

const collectImages = (img: unknown): string[] => {
  if (typeof img === "string") return [img];
  if (Array.isArray(img)) return img.flatMap(collectImages);
  if (img && typeof img === "object") {
    // schema.org ImageObject uses `url`; Wix emits `contentUrl`.
    const o = img as { url?: unknown; contentUrl?: unknown };
    if (typeof o.url === "string") return [o.url];
    if (typeof o.contentUrl === "string") return [o.contentUrl];
  }
  return [];
};

const offerPrices = (
  offers: unknown,
): {
  min: number | null;
  max: number | null;
  currency: string | null;
  availability: boolean | null;
} => {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  const prices: number[] = [];
  let currency: string | null = null;
  let availability: boolean | null = null;
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const offer = o as Record<string, unknown>;
    for (const key of ["price", "lowPrice", "highPrice"]) {
      const n = toNumber(offer[key]);
      if (n !== null) prices.push(n);
    }
    if (!currency && typeof offer.priceCurrency === "string")
      currency = offer.priceCurrency;
    const av = mapAvailability(offer.availability ?? offer.Availability);
    if (availability === null && av !== null) availability = av;
  }
  return {
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    currency,
    availability,
  };
};

/** Walk a parsed JSON-LD blob (object, array, @graph, or mainEntity) for Products. */
const collectProductNodes = (
  node: unknown,
  acc: Record<string, unknown>[],
): void => {
  if (Array.isArray(node)) {
    for (const n of node) collectProductNodes(n, acc);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) collectProductNodes(obj["@graph"], acc);
  // Weebly/Square (bkmarketplace) wrap the Product in a WebPage.mainEntity.
  if (obj["mainEntity"]) collectProductNodes(obj["mainEntity"], acc);
  const type = obj["@type"];
  const isProduct =
    type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (isProduct) acc.push(obj);
};

/** Pure: extract a Product from a PDP's HTML (schema.org JSON-LD, then OpenGraph). */
const productFromHtml = (
  html: string,
  pageUrl: string,
): NormalizedProduct | null => {
  const $ = cheerio.load(html);

  const nodes: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_i, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      collectProductNodes(JSON.parse(raw), nodes);
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  const node = nodes[0];
  if (node && typeof node.name === "string") {
    // Wix emits `Offers` (capital O); schema.org canonical is `offers`.
    const { min, max, currency, availability } = offerPrices(
      node.offers ?? (node as Record<string, unknown>).Offers,
    );
    const images = collectImages(node.image);
    const sku = node.sku ?? node.productID ?? node.mpn;
    return {
      externalId: String(sku ?? pageUrl),
      title: node.name,
      description:
        typeof node.description === "string"
          ? maybeUrlDecode(node.description).replace(/\s+/g, " ").trim() || null
          : null,
      productUrl:
        typeof node.url === "string" && node.url.startsWith("http")
          ? node.url
          : pageUrl,
      image: images[0] ?? null,
      images,
      priceMin: min,
      priceMax: max,
      currency,
      available: availability,
      variants: [],
      cartCapability: "link",
      addToCartTemplate: null,
      // Prefer an explicit JSON-LD category; otherwise bucket from the title so
      // BigCommerce/Wix products (which omit category) still facet usefully.
      category:
        normalizeCategory(
          typeof node.category === "string"
            ? node.category
            : Array.isArray(node.category)
              ? String(node.category[0] ?? "")
              : null,
        ) ?? bucketCategory(node.name),
    };
  }

  const og = (prop: string) =>
    $(`meta[property="${prop}"]`).attr("content") ?? null;
  const ogTitle = og("og:title");
  const ogType = og("og:type");
  if (ogTitle && (ogType === "product" || og("product:price:amount"))) {
    const image = og("og:image");
    return {
      externalId: pageUrl,
      title: ogTitle,
      description: (() => {
        const d = og("og:description");
        return d ? maybeUrlDecode(d) : null;
      })(),
      productUrl: og("og:url") ?? pageUrl,
      image,
      images: image ? [image] : [],
      priceMin: toNumber(og("product:price:amount")),
      priceMax: toNumber(og("product:price:amount")),
      currency: og("product:price:currency"),
      available: null,
      variants: [],
      cartCapability: "link",
      addToCartTemplate: null,
    };
  }

  // Last resort — a rendered SPA product page (e.g. Shopify Hydrogen / store.dci.org)
  // with NEITHER JSON-LD nor og:product, but the product is in the DOM: title in an
  // <h1>, a product image, and a visible price. Only reached after both structured
  // paths fail, so it never overrides good data on the working stores.
  //
  // CRITICAL guard against marketing-site noise: a WordPress/Wix site (e.g.
  // spartansdbc.org) hands the crawler hundreds of blog/news pages that all have an
  // <h1> but are NOT products. We only accept an <h1>-only page as a product when
  // it carries real product signal: a price, OR (it sits on a product-pattern URL
  // AND has an image). A bare <h1> with neither is rejected.
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  if (h1) {
    const imgRaw =
      $("img")
        .toArray()
        .map((e) => $(e).attr("src") || $(e).attr("data-src") || "")
        .find((s) => /cdn\.shopify|\/products?\//i.test(s)) ?? null;
    // Prefer a matched content image; fall back to og:image (Printify/Woo host
    // their mockups off-CDN, e.g. images-api.printify.com / S3, so the pattern
    // match misses them but og:image is present). Drop the resizing query.
    const image = (imgRaw ?? og("og:image"))?.split("?")[0] ?? null;
    // Require cents ($10.00) so we don't grab a "$75 free shipping" threshold or a
    // bare quantity. Prefer a price-classed element, else the main content text.
    const priceText =
      $('[class*="price" i],[data-price],[itemprop="price"]').first().text() ||
      $("main").text() ||
      $("body").text();
    const m = priceText.match(/\$\s?([0-9]+\.[0-9]{2})\b/);
    const price = m ? Number(m[1]) : null;
    const onProductUrl = PRODUCT_URL_RE.test(pageUrl);
    // Reject non-product pages: no price AND (not a product URL, or no image).
    if (price === null && !(onProductUrl && image)) return null;
    return {
      externalId: pageUrl,
      title: h1,
      description: null,
      productUrl: pageUrl,
      image,
      images: image ? [image] : [],
      priceMin: price,
      priceMax: price,
      currency: null,
      available: null,
      variants: [],
      cartCapability: "link",
      addToCartTemplate: null,
      category: bucketCategory(h1),
    };
  }
  return null;
};

const universalJsonLdAdapter: MerchAdapter = {
  platform: "universal",
  fetchCatalog: (store, opts) =>
    Effect.gen(function* () {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const origin = originOf(store.storeUrl);
      const urls = yield* discoverProductUrls(origin, timeoutMs);
      if (urls.length >= UNIVERSAL_MAX_PRODUCTS)
        yield* Effect.logWarning(
          `[merch] ${store.name}: hit UNIVERSAL_MAX_PRODUCTS (${UNIVERSAL_MAX_PRODUCTS}) — catalog may be truncated`,
        );
      const found = yield* Effect.forEach(
        urls,
        (url) =>
          // Demand a rendered page: client-rendered storefronts inject the
          // Product JSON-LD only after hydration, so escalate to Browserbase
          // when the plain fetch returns a signal-less shell.
          fetchHtmlWithFallback(url, timeoutMs, hasExtractableProductSignal).pipe(
            Effect.map((html) => (html ? productFromHtml(html, url) : null)),
          ),
        { concurrency: UNIVERSAL_CONCURRENCY },
      );
      const out: NormalizedProduct[] = [];
      const seenIds = new Set<string>();
      for (const p of found) {
        if (p && !seenIds.has(p.externalId)) {
          seenIds.add(p.externalId);
          out.push(p);
        }
      }
      return out;
    }),
};

// --- Bonfire (multi-tenant POD) — scoped REST API per store slug ---------
// Bonfire is multi-tenant (one corps's shop is `bonfire.com/store/<slug>/`) and a
// pure SPA — the page has no static product data and the only sitemap is GLOBAL,
// so the universal adapter would ingest other tenants' products. But its store page
// calls a per-tenant REST endpoint, `/rest/stores/<slug>/`, which returns exactly
// this store's campaigns with prices + design-image URLs. That's correctly scoped,
// needs no rendering, and is what this adapter uses.
const BONFIRE_HOSTS = ["bonfire.com"];
export const isBonfireHost = (storeUrl: string): boolean => {
  try {
    const host = new URL(originOf(storeUrl)).host.replace(/^www\./, "");
    return BONFIRE_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
  } catch {
    return false;
  }
};
const bonfireStoreSlug = (storeUrl: string): string | null => {
  try {
    const m = new URL(storeUrl).pathname.match(/\/store\/([^/]+)/i);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
};
/** Largest design-image URL from a campaign's first product. */
const bonfireImage = (campaign: Record<string, unknown>): string | null => {
  const pt = (campaign.productTypes as any[])?.[0];
  const dims = pt?.products?.[0]?.designs?.[0]?.dimensions;
  if (dims && typeof dims === "object") {
    const sizes = Object.keys(dims)
      .map(Number)
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => b - a);
    const top = sizes[0];
    if (top !== undefined && typeof dims[String(top)] === "string")
      return dims[String(top)] as string;
  }
  return null;
};

const bonfireAdapter: MerchAdapter = {
  platform: "bonfire",
  fetchCatalog: (store, opts) =>
    Effect.gen(function* () {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const slug = bonfireStoreSlug(store.storeUrl);
      if (!slug) return [];
      const origin = originOf(store.storeUrl); // https://www.bonfire.com
      const json = (yield* httpJson(
        `${origin}/rest/stores/${slug}/`,
        timeoutMs,
      )) as { campaigns?: { campaign?: Record<string, unknown> }[] };
      const campaigns = Array.isArray(json.campaigns) ? json.campaigns : [];
      const out: NormalizedProduct[] = [];
      for (const entry of campaigns) {
        const c = entry.campaign;
        if (!c || typeof c.name !== "string" || typeof c.slug !== "string")
          continue;
        const prices: number[] = [];
        const variants: NormalizedVariant[] = [];
        for (const pt of (c.productTypes as any[]) ?? []) {
          for (const p of pt?.products ?? []) {
            const price = toNumber(p?.sellingPrice);
            if (price !== null) prices.push(price);
            variants.push({
              id: String(p?.id ?? p?.productId ?? variants.length),
              title:
                [pt?.type, p?.colorName].filter(Boolean).join(" / ") || "Default",
              price,
              available: null,
            });
          }
        }
        const [priceMin, priceMax] = priceRange(prices);
        const image = bonfireImage(c);
        out.push({
          externalId: String(c.id ?? c.slug),
          title: c.name,
          description: null,
          productUrl: `${origin}/${c.slug}/`,
          image,
          images: image ? [image] : [],
          priceMin,
          priceMax,
          currency: "USD",
          available: null,
          variants,
          cartCapability: "link",
          addToCartTemplate: null,
          category: bucketCategory(c.name),
        });
      }
      return out;
    }),
};

// Multi-tenant storefront platforms a corps shop is a sub-path/SPA on, where the
// products do NOT live under the store's own URL path and we have no scoped feed.
// `square.site` (Square Online) renders products client-side with no JSON-LD or
// per-product URLs in static HTML — it needs the Square API or a DOM render, so
// for now it's link-only (keep the storefront link, ingest nothing). (bonfire used
// to be here; it now has a dedicated scoped adapter above.)
// `atozwearproductorders.com` is a shared A-to-Z Wear order portal serving many
// unrelated orgs (schools/teams) from ONE Wix store — a corps that links it has no
// scoped catalog there, so the universal adapter over-scrapes the whole platform
// (Cincinnati Tradition → 613 products belonging to other orgs). Treat as link-only.
// `stores.inksoft.com` is a multi-tenant InkSoft platform: each org is a
// `/tenant/shop/...` sub-path, but the universal adapter follows the storefront's
// cross-promo / "What customers say" carousels into OTHER tenants' product pages,
// so a corps scoped to one tenant over-scrapes the whole platform (Raiders →
// 28 products all belonging to NYLacrosse / East Eagles / etc.). Link-only.
const LINK_ONLY_HOSTS = ["square.site", "atozwearproductorders.com", "inksoft.com"] as const;

/** True when a store URL is on a platform we deliberately don't auto-ingest. */
export const isLinkOnlyHost = (storeUrl: string): boolean => {
  try {
    const host = new URL(originOf(storeUrl)).host.replace(/^www\./, "");
    return LINK_ONLY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

/** Pick the adapter for a store (MERCH_PLAN §17). Host-specific adapters win over
 *  the platform classification — bonfire is detected by host, not platform. */
export const selectAdapter = (
  platform: MerchPlatform,
  storeUrl?: string,
): MerchAdapter => {
  if (storeUrl && isBonfireHost(storeUrl)) return bonfireAdapter;
  return Match.value(platform).pipe(
    Match.when("shopify", () => shopifyAdapter),
    Match.when("woocommerce", () => wooAdapter),
    Match.when("bigcartel", () => bigCartelAdapter),
    Match.when("squarespace", () => squarespaceAdapter),
    // bigcommerce / wix / other-ecommerce → sitemap + JSON-LD (universal).
    Match.orElse(() => universalJsonLdAdapter),
  );
};

export const adapters = {
  shopify: shopifyAdapter,
  woocommerce: wooAdapter,
  bigcartel: bigCartelAdapter,
  squarespace: squarespaceAdapter,
  bonfire: bonfireAdapter,
  universal: universalJsonLdAdapter,
};
