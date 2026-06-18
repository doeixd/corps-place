# Merch Section — Implementation Plan

Status: proposed
Related: [READ_MODEL_PLAN](./READ_MODEL_PLAN.md), [DATA_LAYER_DECISION](./DATA_LAYER_DECISION.md),
[PREGEN_AND_ADMIN_PLAN](./PREGEN_AND_ADMIN_PLAN.md)

## 1. Goal & scope

A **Merch** section that aggregates products from every corps/vendor store we can read,
into one browsable catalog, with a **save-for-later cart that links out to the merchant**
instead of checking out on our site. No payments, no PCI, no merchant-of-record. The
merchant site is always the source of truth for price, stock, and checkout.

We support **all products from all platforms** on a best-effort basis (not just Shopify),
degrading gracefully from "full catalog with pre-filled cart" down to "browse on website"
depending on what each platform exposes.

### Non-goals
- On-site checkout / UCP buyer surface / AP2 / Google Pay (explicitly out — see history).
- Holding inventory, money, or order state.

## 2. Architecture decision: pre-gen → SWR → cache headers

The merch catalog is **read-mostly and changes only when we re-sync** (daily-ish). It must
**not** hit a DB on the request path. We reuse the site's existing precompute pipeline
verbatim (READ_MODEL_PLAN §5, DATA_LAYER_DECISION §3–4):

1. **Ingest** product data into the big relational DB (`sdk/dci-relational.db`).
2. **Build** merch read-model rows via shared builders (`sdk/src/readModel/builders/merch.ts`)
   so live server-fn fallback and the emitted shards can't drift.
3. **Emit** a static JSON snapshot under `public/read-model/merch/**` via
   `sdk/scripts/emitReadModel.ts --json-snapshot`, registered in `manifest.json`.
4. **Serve** with the cache policy already in `proxy.mjs`:
   - `manifest.json` → `public, max-age=60, stale-while-revalidate=86400` (the single
     revalidated entry point; a new emit is picked up within ~1 min).
   - versioned shards (`merch/...?v=<token>`) → `public, max-age=31536000, immutable`.
5. **Consume on the frontend with SWR**: `loadReadModelManifest()` (short max-age + SWR)
   resolves the current `version` token; index/detail shards are fetched at immutable
   `?v=` URLs (`app/db/detail-shard.ts` → `loadDetailOrServer`), with the server fn as a
   fallback for not-yet-emitted entities. TanStack Router `staleTime: 60_000` gives an
   additional in-memory SWR layer across client navigations.

**Net effect:** the catalog is fully static/CDN-cacheable, instantly served stale while
revalidating, and a re-sync invalidates exactly once via the manifest `version` bump.
Cart state is the *only* dynamic piece and lives entirely client-side (localStorage).

### Why this is better than the prior draft
The first draft served the catalog through request-time Effect server functions hitting the
read-model DB. That re-implements caching we already have and puts the catalog on the
request path. Folding merch into the emit/manifest/shard system gives correct cache headers,
SWR, CDN immutability, and atomic A/B publishing **for free**, and keeps a server-fn
fallback for freshness.

## 3. Capability tiers (the UX axis)

Per **store** and per **product** we record a cart capability:

- **Tier A — `prefill`**: we can deep-link a cart with specific items.
  Shopify, WooCommerce, BigCommerce, Big Cartel.
- **Tier B — `link`**: we can list products but can only send the user to the product page.
  Squarespace, Wix, generic JSON-LD, third-party storefronts (Printify, Fourthwall,
  BoosterHub, itemorder, …).

The "Open on sites" action fans out: one **pre-filled cart URL per Tier-A store** plus
**product-page links for Tier-B items**.

## 4. Ingestion: all platforms

New sdk module `src/merchCatalog.ts` — per-platform **adapters** + a **universal fallback**,
all normalizing to one shape. Built on existing fetch primitives (direct fetch → Browserbase
fallback for JS-rendered sites) and routed by the `merch_platform` already detected by
`merchScan.ts`.

| Platform        | Catalog source                                             | Coverage      | Tier-A cart link |
|-----------------|------------------------------------------------------------|---------------|------------------|
| Shopify         | `/products.json?limit=250&page=N` (already proven)         | Full          | `/cart/{variantId}:{qty},…` |
| WooCommerce     | Store API `/wp-json/wc/store/v1/products` (public)         | Full          | `?add-to-cart={id}&quantity={qty}` |
| Big Cartel      | `https://{store}.bigcartel.com/products.json`              | Full          | per-product add URL |
| BigCommerce     | sitemap + JSON-LD on PDPs (no token)                       | Best-effort   | `/cart.php?action=add&product_id={id}&qty={qty}` |
| Squarespace     | store collection `?format=json` (validate per store)       | Decent        | Tier B |
| Wix             | Browserbase + JSON-LD/OG (JS-rendered)                     | Best-effort   | Tier B |
| Generic / other | `sitemap.xml` → PDPs → schema.org `Product` JSON-LD + OG   | Best-effort   | Tier B |

**Universal fallback** (makes "all sites" realistic): discover product URLs via `sitemap.xml`
(or nav links matching `/product|/collections|/shop`), fetch each PDP, parse schema.org
`Product` JSON-LD (`name`, `image`, `offers.price/priceCurrency/availability`, `sku`) with
OpenGraph (`og:*`, `product:price:amount`) as secondary. JS-rendered pages → Browserbase.

```ts
interface MerchAdapter {
  platform: MerchPlatform;
  fetchCatalog(store: MerchStore, ctx: FetchCtx): Promise<NormalizedProduct[]>;
}
interface NormalizedProduct {
  externalId: string; title: string; description: string | null;
  productUrl: string; image: string | null; images: string[];
  priceMin: number | null; priceMax: number | null; currency: string | null;
  available: boolean | null;
  variants: { id: string; title: string; price: number | null; available: boolean | null }[];
  cartCapability: "prefill" | "link";
  addToCartTemplate: string | null;
}
```

**Runner** `sdk/scripts/ingestMerch.ts` (mirrors `scanMerch.ts`): bounded concurrency,
per-host throttle, per-store timeout, Browserbase only for blocked/JS sites, caches via
`api_responses`, respects `robots.txt`, records `last_synced_at` + `sync_status`. Re-runnable
on a cadence.

## 5. Data model (relational → read-model)

New tables in `sdk/src/relational.ts` (existing `CREATE TABLE IF NOT EXISTS` / `ensureColumns`
pattern):

```sql
CREATE TABLE merch_stores (
  store_id          TEXT PRIMARY KEY,   -- corps_key or vendor slug
  corps_key         TEXT,               -- null for vendors
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL,      -- 'corps' | 'vendor'
  platform          TEXT,
  store_url         TEXT NOT NULL,
  cart_capability   TEXT,               -- 'prefill' | 'link'
  cart_url_template TEXT,
  product_count     INTEGER DEFAULT 0,
  last_synced_at    TEXT,
  sync_status       TEXT                 -- 'ok' | 'partial' | 'error'
);
CREATE TABLE merch_products (
  product_id        TEXT PRIMARY KEY,   -- hash(store_id + external_id)
  store_id          TEXT NOT NULL,
  external_id       TEXT,
  title             TEXT NOT NULL,
  description       TEXT,
  product_url       TEXT NOT NULL,
  image_url         TEXT,
  images_json       TEXT,
  price_min         REAL, price_max REAL, currency TEXT,
  available         INTEGER,
  variants_json     TEXT,               -- [{id,title,price,available}]
  cart_capability   TEXT,
  add_to_cart_template TEXT,
  category          TEXT,               -- best-effort
  synced_at         TEXT
);
-- indexes: merch_products(store_id), (available), (currency)
```

**Builders** `sdk/src/readModel/builders/merch.ts` + readers, wired into
`emitReadModel.ts`. Emitted shards (all under `/read-model/merch/`, versioned by manifest
`version`):

- **Index shards** (preloaded, registered in `manifest.shards`):
  - `merch/stores.json` — store directory (name, platform, capability, product_count, logo).
  - `merch/catalog/index.json` — lightweight catalog index for client search/filter
    (id, title, storeId, price, image, capability, category). If large, **paginate**:
    `merch/catalog/page-<n>.json` + a `merch/catalog/manifest.json` (page count, facets).
  - `merch/facets.json` — precomputed filter facets (platforms, price buckets, categories,
    stores) so filtering is instant and client-side.
- **Detail shards** (on-demand via `loadDetailOrServer`):
  - `merch/products/<product_id>.json`
  - `merch/stores/<store_id>.json` (store + its product ids)

Partial emit (`--only merch`) writes `<stem>.partial.db` and does **not** flip the live
pointer; a catalog refresh therefore runs a normal full emit (or a merch-aware incremental
path) to bump `version` and atomically publish. Cache invalidation is automatic via the
manifest token.

## 6. App data layer

`app/lib/merch-directory.ts` — `MerchDirectoryService` (Effect, mirrors `corps-directory.ts`)
as the **server-fn fallback** only; the happy path is static shards.

Server fns in `app/lib/server-fns/hybrid.ts`:
- `getMerchCatalogIndex()` / `getMerchCatalogPage(n)`
- `getMerchStores()`
- `getMerchProduct(productId)` / `getMerchStore(storeId)`

App-facing types here: `MerchProductSummary`, `MerchProductDetail`, `MerchStoreSummary`
(no SDK type imports — matches current app convention).

Manifest type extension (`app/db/read-model-manifest.ts`): add
`shards.merchStores`, `shards.merchCatalog` (+ optional `shards.merchFacets`).

## 7. Routes & components

```
app/routes/merch/
  index.tsx        // Catalog: product grid, filters (store/corps, platform, price, in-stock), search
  $productId.tsx   // Product detail: images, variant picker, price, Add-to-cart | Buy-on-website
  stores.tsx       // Shop-by-corps store directory
  cart.tsx         // Saved cart + "Open on sites" handoff
app/components/merch/
  product-card.tsx          // reuses .card-hover recipe + CorpsCard structure
  product-grid.tsx          // HybridCollection + virtualization for the large grid
  variant-picker.tsx
  add-to-cart-button.tsx    // "Add to cart" (Tier A) vs "Buy on website" (Tier B)
  cart-drawer.tsx           // mini-cart in nav
  open-on-sites-panel.tsx   // grouped handoff (one button per store)
app/machines/merch-filter-machine.ts   // filters/sort synced to URL (like judge-filter-machine)
app/stores/cart-store.ts               // persistent cart (XState createStore + localStorage)
app/lib/merch-cart-links.ts            // per-platform cart-URL builders
```

- **Catalog page** follows the **judges directory** pattern: `validateSearch` codec for
  filters, `merch-filter-machine` + `useSearchSync` for URL-synced state, loader resolves the
  catalog index shard (SWR via manifest), `staleTime: 60_000`. Facets drive instant
  client-side filtering; pagination shards loaded on demand.
- **Product detail** SSRs from its server fn for first paint; client navigation loads
  `merch/products/<id>.json` (immutable `?v=`) via `loadDetailOrServer`.

## 8. Cart (client-only, no checkout)

`app/stores/cart-store.ts` — XState `createStore` (same pattern as `theme-store.ts`),
persisted to `localStorage('merch-cart')`, hydrated on mount (SSR-safe; render empty on
server to avoid hydration mismatch). Never pre-gen, never server-cached.

```ts
interface CartItem {
  productId: string; storeId: string; storeName: string;
  title: string; productUrl: string; image: string | null;
  price: number | null; currency: string | null;
  variantId: string | null; variantTitle: string | null; qty: number;
  cartCapability: "prefill" | "link"; addToCartTemplate: string | null;
}
```

Variant selection: for Tier-A items with variants (apparel sizes/colors) we capture the
chosen `variantId` so the pre-fill is exact; without a chosen variant, handoff falls back to
the product page.

## 9. "Open on sites" handoff (checkout replacement)

`open-on-sites-panel.tsx` groups cart items **by store** and builds, per store, the best
handoff via `merch-cart-links.ts`:

```ts
// Shopify:    `${storeUrl}/cart/${variantId}:${qty},…`
// WooCommerce:`${productUrl}?add-to-cart=${id}&quantity=${qty}`
// BigCommerce:`${storeUrl}/cart.php?action=add&product_id=${id}&qty=${qty}`
// Big Cartel: per-product add URL
// Tier B:     open each productUrl directly
```

**UX (popup-blocker safe):** the panel lists each store with a single
**"Open cart at {store} →"** button (one user click = one tab, items pre-loaded where
possible) and Tier-B items as **"Buy on website"** links. No auto-spawning N tabs. Offer a
"Copy list" for stores we cannot pre-fill.

## 10. Images, styling, types

- **Product images** are external (merchant CDNs). Extend the media proxy
  (`app/routes/api/media.ts` + `PROXY_HOSTS`) to allow merchant CDN hosts so
  `proxiedImage()` resizes + caches them (immutable, content-addressed) like corps photos.
  Lazy-load grids.
- **Styling:** Tailwind v4 + existing recipes (`.card-hover`, `.icon-shift`); add a
  `.product-card` recipe only if needed.
- **Types:** app-side in `app/lib/merch-directory.ts`.

## 11. Freshness & honest caveats

- **Coverage is uneven.** Shopify/Woo/Big Cartel ≈ complete; BigCommerce/Squarespace
  good-but-validate; Wix/generic best-effort via JSON-LD; some third-party storefronts only
  link-out. The store directory must mark each store "full catalog" vs "browse on site."
- **Prices/stock drift between syncs.** Always show "price as of {manifest.built_at}" and
  treat the merchant site as authoritative. This also limits liability. Never block the UI on
  a price.
- **JS-rendered sites cost money** (Browserbase) — gate behind the universal fallback only
  when direct + JSON-LD fail.
- **Authorization / trademark.** Even link-out aggregation reuses names, logos, product
  images. Recommend: clear attribution + "Shop {corps}" framing, a per-store opt-out flag,
  honoring `robots.txt`. A short heads-up to corps reframes this as "a free storefront we
  built you."

## 12. Phased rollout

1. **P1 — Catalog + link-out for everyone.** Ingest Shopify + WooCommerce + Big Cartel +
   universal JSON-LD fallback; emit shards; catalog + store directory; every product has at
   least "Buy on website."
2. **P2 — Cart + grouped handoff.** Cart store, mini-cart, "Open on sites" with Tier-A
   pre-fill + Tier-B links.
3. **P3 — Coverage polish.** BigCommerce/Squarespace/Wix adapters, variant pickers,
   Browserbase for stubborn sites, category/size normalization, scheduled re-sync.

## 13. File checklist

**sdk**
- `src/merchCatalog.ts` (adapters + normalize)
- `src/readModel/builders/merch.ts` (+ reader)
- `scripts/ingestMerch.ts`
- `src/relational.ts` (2 new tables + indexes)
- `scripts/emitReadModel.ts` (emit merch index + detail shards; register in manifest)
- `src/index.ts` (export)

**app**
- `routes/merch/{index,$productId,stores,cart}.tsx`
- `components/merch/*` (presentation-only — §25)
- `lib/merch-directory.ts`, `lib/merch-cart-links.ts`, `lib/merch-filtering.ts`
- `predicates/merch.ts`
- `lib/server-fns/hybrid.ts` (new fns incl. `getCorpsMerch`, fallback only)
- `db/read-model-manifest.ts` (manifest shard keys)
- `machines/merch-filter-machine.ts`, `stores/cart-store.ts`
- `components/site-nav.tsx` (NAV_ITEMS entry), `components/icons/generated/` (bag/cart icons)
- `routes/corps/$slug.tsx` (Shop SocialLink + Merch teaser section + 5th loader call)
- media proxy host allowlist

**ops**
- `proxy.mjs` already covers `/read-model/**` cache headers — no change needed if merch
  shards live under `/read-model/merch/**`. Verify after first emit.
```

## 14. Success criteria

Phase-gated and measurable. A phase is "done" only when its criteria hold on a real emit.

**P1 — Catalog + link-out**
- **Coverage:** ≥ 95% of Shopify/WooCommerce/Big Cartel stores ingest with a non-zero
  product count; ≥ 60% of remaining stores yield ≥ 1 product via the universal JSON-LD
  fallback; every store that yields zero products still renders a "Shop on website" card
  (i.e. **no store is silently dropped**).
- **Correctness:** for a 20-product hand-audited sample, title/price/currency/image/URL match
  the live merchant page (price within the last sync window). `ingestMerch.ts --dry-run`
  reports the exact normalize result per store.
- **Performance / cache:** catalog index + a product detail shard are served from
  `/read-model/merch/**` with the expected `cache-control` (manifest `REVALIDATE`, versioned
  shards `IMMUTABLE` — assert in a proxy test); first paint SSRs, client navigation fetches
  only the manifest (revalidated) + immutable shards. No request-path DB query for the catalog.
- **SEO:** `/merch` and `/merch/$productId` emit valid `ItemList` / `Product` JSON-LD
  (validates against schema.org), unique `<title>`/`<meta description>`, and a canonical URL.

**P2 — Cart + handoff**
- Cart persists across reloads (localStorage) and survives SSR with **zero hydration
  warnings**.
- "Open on sites" produces a **correct pre-filled cart** for every Tier-A platform (manual
  click-through opens the merchant cart with the exact variant+qty) and a working product
  link for every Tier-B item. One user gesture → at most one tab (popup-blocker safe).
- Removing the last item from a store removes that store group; clearing the cart is atomic.

**P3 — Coverage polish**
- BigCommerce/Squarespace/Wix adapters raise their stores' coverage to ≥ 80%.
- Variant pickers present for all products with > 1 variant; scheduled re-sync runs and bumps
  the manifest exactly once per emit.

**Always-on (regression gates)**
- A failed/partial ingest of one store never blocks the emit of others (`sync_status`
  records it; the store degrades to link-out).
- Lighthouse: catalog LCP within budget on a mid-tier mobile profile; CLS ~0 (image
  dimensions reserved).

## 15. Invariants

These must hold at all times; encode as Schema decoders, predicates, and tests.

1. **No money, no order state.** The app never collects payment, stores card data, or holds an
   order. The only mutable client state is the cart (a list of references).
2. **Merchant is source of truth.** Every product surface links to `product_url`; we display
   "price as of {manifest.built_at}" and never present our price as authoritative.
3. **Catalog is never on the request path.** Catalog/detail reads resolve from static shards
   (+ server-fn fallback for not-yet-emitted ids). A DB query for a catalog *list* in a hot
   path is a bug.
4. **Builder = shard parity.** Emitted shards are produced by the same
   `readModel/builders/merch.ts` used by the server-fn fallback, so SSR and static can't drift
   (READ_MODEL_PLAN §5).
5. **Stable ids.** `product_id = hash(store_id + external_id)` is deterministic across syncs;
   a product keeps its URL/shard path as long as the merchant id is stable.
6. **Capability is single-sourced.** `cart_capability` ∈ {`prefill`,`link`} is computed once at
   ingest and flows unchanged to shards → cart → handoff. The UI never re-derives it.
7. **Tier-A requires a resolvable target.** A `prefill` item must carry the data its
   `add_to_cart_template` needs (e.g. Shopify variantId); if missing at handoff time it
   **degrades to `link`** rather than producing a broken cart URL.
8. **Cache-bust is the manifest token.** Detail shards are only ever fetched at
   `?v=<manifest.version>`; a new emit invalidates exactly once.
9. **Currency is explicit or null** — never assume USD. Mixed-currency carts are grouped and
   labeled per store; we never sum across currencies.
10. **No store silently disappears.** Zero products ⇒ link-out card, not omission.

## 16. Edge cases

**Ingestion / data**
- Shopify `/products.json` paginates and **caps at 250/page**; some stores disable it
  (404/401) → fall back to JSON-LD. Password-protected/"opening soon" Shopify → store marked
  `link`, `sync_status='partial'`.
- WooCommerce Store API disabled or non-standard prefix → JSON-LD fallback.
- Squarespace `?format=json` shapes vary by template; validate with a Schema decoder, skip
  rows that don't decode rather than poisoning the catalog.
- Wix/JS-rendered: empty direct HTML → Browserbase; still empty → link-out.
- **Wayback-snapshot store URLs** (existing data quirk for defunct corps): detect
  `web.archive.org` origin and either resolve to the live domain or mark `link` + a "via
  archive" note; never build a cart URL against archive.org.
- Malformed JSON-LD (arrays of `@graph`, multiple `Product` nodes, `offers` as object vs
  array, price as string with currency symbol) — normalize defensively; drop if no price+url.
- Variants: size/color matrices, sold-out variants, price ranges → `price_min/max`; a product
  with all variants unavailable is `available=false` but still listed.
- Duplicate products across alias stores (e.g. "Mandarins" vs "Mandarins Alumni") — dedupe by
  `product_id`; keep the canonical store.
- Giant catalogs → paginate index shards; **log any cap** (never silently truncate — see
  no-silent-caps invariant).
- HTML/entity-encoded titles, emoji, RTL text → store decoded UTF-8; render-safe.

**Cart / handoff**
- localStorage unavailable (private mode / quota) → in-memory cart, no crash.
- Stale cart item (product gone/price changed since add) → on cart view, soft-revalidate
  against current shard; show "price changed / no longer available," keep the link.
- Variant chosen in cart but merchant removed it → degrade to product-page link.
- Popup blocker → never auto-open N tabs; one button per store, one gesture per tab.
- Cross-currency cart → grouped per store, no global total.
- SSR/CSR mismatch → cart renders empty on server, hydrates from localStorage on mount.

**SEO / routing**
- Product/store deleted between emits → detail shard 404 → server-fn fallback → if truly gone,
  `noindex` + redirect to the store or `/merch`.
- Filtered catalog URLs must be canonicalized (filters in search params, canonical points at
  the unfiltered or normalized URL) to avoid duplicate-content dilution.

## 17. Preferred tech & conventions

Match the existing codebase patterns exactly.

**Effect (sdk ingestion + builders + server-fn fallback)**
- Adapters and the runner are `Effect`-based with **tagged errors** (extend the `errors.ts`
  pattern: `MerchFetchError`, `MerchDecodeError`) and a `BrowserbaseService`-style **Layer**
  for shared deps. Use `Effect.forEach(..., { concurrency })` for bounded fan-out and
  `Schedule` for retry/backoff (as `websiteScraper.ts` does).
- An **adapter registry** keyed by platform, dispatched with `Match`:
  ```ts
  const selectAdapter = (platform: MerchPlatform) =>
    Match.value(platform).pipe(
      Match.when("shopify", () => shopifyAdapter),
      Match.when("woocommerce", () => wooAdapter),
      Match.when("bigcartel", () => bigCartelAdapter),
      Match.orElse(() => universalJsonLdAdapter) // bigcommerce/squarespace/wix/generic
    );
  ```
- **Schema** decodes every external payload (`products.json`, Store API, JSON-LD) into
  `NormalizedProduct` at the boundary; undecodable rows are dropped, not trusted. Consider
  **branded** ids (`ProductId`, `StoreId`) via `Schema.brand` (see `corpsColors.ts`).

**Predicate (app filtering)**
- New `app/predicates/merch.ts` exporting composable `Predicate.Predicate<MerchProductSummary>`
  (mirrors `app/predicates/corps.ts`): `hasSearchTerm`, `inPriceBucket`, `onPlatform`,
  `inStore`, `isAvailable`, `isPrefillable`. Compose with `Predicate.and` / `Predicate.or` in
  `app/lib/merch-filtering.ts`.

**Match (app sorting / capability rendering)**
- Sorting and tier-driven rendering use `Match.value(...).pipe(Match.when(...), Match.orElse(...))`
  (as `event-filtering.ts` does), e.g. `Add-to-cart` vs `Buy-on-website` button selection by
  `cart_capability`.

**State machines (XState)**
- `app/machines/merch-filter-machine.ts` — filter/sort/search context, `SYNC` event for
  URL↔state, identical shape to `judge-filter-machine.ts`.
- `app/stores/cart-store.ts` — XState `createStore` (like `theme-store.ts`) with a localStorage
  subscriber; events `addItem`/`removeItem`/`setQty`/`setVariant`/`clear`.

**URL as source of truth**
- Catalog route `validateSearch` codec (like `judges/index.tsx`) for `q`, `store`, `platform`,
  `price`, `inStock`, `sort`; `useSearchSync` keeps URL and machine in sync; filters are
  shareable/bookmarkable and SSR-rendered.

**SEO / JSON-LD (we both consume and emit it)**
- Ingestion **consumes** schema.org `Product` JSON-LD; our pages **emit** it:
  - `/merch/$productId` → `Product` + `Offer` (price, priceCurrency, availability, url, brand =
    corps/store).
  - `/merch` and `/merch/stores` → `ItemList`.
- Per-route `head()`/meta (TanStack Start, as other routes do): unique title, meta description,
  canonical URL, OpenGraph/Twitter card with the product image (via the media proxy).
- A `sitemap` entry generator for `/merch/$productId` so our catalog is itself crawlable.

## 18. Maintainability & architecture notes

- **One normalization boundary.** All platform quirks are absorbed in `merchCatalog.ts`
  adapters → `NormalizedProduct`. Nothing downstream (builders, shards, app) knows a platform
  exists except via `platform`/`cart_capability` fields. Adding a platform = one adapter + one
  `Match.when`, no schema or UI change.
- **No drift.** Shared builders (invariant #4) + Schema-decoded shards + a `verifyReadModel`-style
  check that every `merch_products` row has a corresponding emitted detail shard.
- **Idempotent, resumable ingest.** `ingestMerch.ts` re-runs safely (deterministic ids,
  upserts, `last_synced_at`); a per-store failure is isolated (`sync_status`) and never aborts
  the batch — mirrors `scanMerch.ts`.
- **Cheap to reason about caching.** Caching lives entirely in the manifest+proxy layer
  already documented in DATA_LAYER_DECISION; merch adds data, not a new caching mechanism.
- **Capability/price are display-only contracts.** The UI treats our price as advisory; this
  keeps us correct even when a sync is stale and bounds legal exposure.
- **Testing**
  - *Unit:* adapter normalization against recorded fixtures per platform (incl. malformed
    JSON-LD, paginated Shopify, sold-out variants); cart-link builders per platform; predicate
    composition.
  - *Property/invariant:* `product_id` determinism; `prefill` items always carry their template
    inputs (else degrade); no currency summing across stores.
  - *Integration:* emit a snapshot for a fixture store set; assert manifest registration, shard
    paths, and `cache-control` via a proxy test; assert SSR/CSR cart parity (no hydration
    warning).
  - *Contract:* JSON-LD emitted by our pages validates against schema.org.
- **Observability.** `ingestMerch` prints a per-store summary (products, tier, via
  direct/browserbase, sync_status) and a totals block (like the merch scan), so coverage
  regressions are visible each run.

## 19. Open decisions

> **Deployment / scheduling are documented in [`docs/MERCH_DEPLOY.md`](../MERCH_DEPLOY.md).**
> ✅ Merch now rides the Turso read-model (emit writes `rm_merch_*` tables, schema v10;
> `MerchDirectoryService` uses `readOrBuild`), so it serves in the prod container without
> the relational DB — same as corps/judges. The `listed` opt-out, the slim
> `Dockerfile.merch-ingest`, and `syncMerch --publish prod` (emit → `--push-turso` →
> Coolify redeploy) are all built. To go live: run `syncMerch --publish prod` once, then
> schedule it (MERCH_DEPLOY §4).

- **Emit cadence:** merch re-sync may want a **merch-aware incremental emit** rather than a full
  nightly read-model rebuild (so prices refresh more often). Decide before P1; affects whether
  `emitReadModel.ts` gains a `--only merch` publish path that still bumps `version`.
- **Image hosting:** proxy-and-cache merchant images (more control, storage cost) vs hotlink
  with `proxiedImage` pass-through (cheaper, depends on merchant CDNs). Default: proxy, since we
  already resize/cache and it stabilizes layout/SEO.
- **Authorization posture:** opt-out by default vs proactive opt-in outreach to corps before any
  store goes live (see §11). Recommend a per-store `listed` flag so we can disable on request.

---

# Execution guide (read this if you are implementing the plan)

This half turns the design above into ordered, copy-the-pattern tasks. **Do the milestones in
order.** Each task says exactly which existing file to mimic, what to produce, the command to
run, and how to know it passed. Do not improvise architecture — every new file has a twin
already in the repo.

## 20. Orientation — copy these patterns

| To build… | Copy the pattern from… |
|---|---|
| sdk fetch+normalize module with adapters | `sdk/src/merchScan.ts` (this repo, already merged), `sdk/src/websiteScraper.ts` |
| Browserbase fallback in a script | `sdk/scripts/scanMerch.ts` (env load, `new Browserbase`, fallback closure) |
| tagged errors | `sdk/src/errors.ts` (`DciNetworkError`) |
| read-model builder + reader | `sdk/src/readModel/builders/corps*.ts`, `sdk/src/readModel/readers.ts` |
| emitting JSON shards + manifest entry | `sdk/scripts/emitReadModel.ts` (search how `corps` index + `corps/<slug>.json` detail shards are written and registered) |
| relational table + migration | `sdk/src/relational.ts` (`CREATE TABLE IF NOT EXISTS corps`, `ensureColumns(sql,"corps",[…])`) |
| server-fn fallback | `app/lib/server-fns/hybrid.ts` (`getCorps`), `app/lib/corps-directory.ts` |
| static-shard-first loader | `app/db/detail-shard.ts` (`loadDetailOrServer`), `app/db/read-model-manifest.ts` |
| route + URL-synced filters | `app/routes/judges/index.tsx` + `app/machines/judge-filter-machine.ts` |
| detail route | `app/routes/corps/$slug.tsx` |
| predicates | `app/predicates/corps.ts` |
| Match-based sort/filter | `app/lib/event-filtering.ts` |
| client persisted store | `app/stores/theme-store.ts` |
| card component | `app/components/corps-card.tsx` |
| external image rendering | `app/lib/media.ts` (`proxiedImage`), `app/components/corps-logo.tsx` |

**Commands you will use** (run sdk scripts from the `sdk/` directory):
- Typecheck/lint/format/test: `npm run check`, `npm run lint`, `npm run fmt`, `npm run test` (repo root).
- Ingest scan (already exists): `cd sdk && npx tsx scripts/scanMerch.ts --dry-run`.
- Ingest catalog (new): `cd sdk && npx tsx scripts/ingestMerch.ts --dry-run`.
- Emit read-model + JSON snapshot: `cd sdk && npx tsx scripts/emitReadModel.ts --json-snapshot ../public/read-model`.
- Run the app: `npm run dev` (repo root) → open `/merch`.

**Golden rule:** after every task, run `npm run check` and the task's verification command.
A task is not done until both pass.

## 21. Milestones (do in order)

Each milestone ends with a **gate** — a command + expected result. Do not start the next
milestone until the gate passes.

### M0 — Schema & data plumbing (no UI)
1. **Add tables.** In `sdk/src/relational.ts`, add `merch_stores` and `merch_products`
   (DDL in §5) next to the other `CREATE TABLE IF NOT EXISTS`, plus their indexes via
   `ensureIndex`. Mirror the corps block exactly.
2. **Seed stores from the scan.** Write `sdk/scripts/seedMerchStores.ts` that reads
   `corps.merch_url/merch_platform/has_merch` (populated by `scanMerch.ts`) and the
   `VENDOR_SEEDS`, and upserts one `merch_stores` row per store with `cart_capability`
   derived by `Match` on `platform` (`shopify|woocommerce|bigcommerce|bigcartel` → `prefill`,
   else `link`).
   - **Gate:** `cd sdk && npx tsx scripts/seedMerchStores.ts && sqlite3 dci-relational.db "SELECT platform,cart_capability,COUNT(*) FROM merch_stores GROUP BY 1,2;"` lists every detected platform with a sensible capability and no NULL `store_url`.

### M1 — Ingestion: structured platforms
3. **Normalized type + Schema.** In `sdk/src/merchCatalog.ts` define `NormalizedProduct`
   (§4) and an `effect/Schema` decoder for it. Add tagged errors `MerchFetchError`,
   `MerchDecodeError` in `sdk/src/errors.ts`.
4. **Adapters (structured).** Implement `shopifyAdapter`, `wooAdapter`, `bigCartelAdapter`
   and the `selectAdapter` `Match` registry (§17). Each `fetchCatalog` returns
   `NormalizedProduct[]`; decode external payloads with Schema and drop undecodable rows.
5. **Runner.** Write `sdk/scripts/ingestMerch.ts` (copy `scanMerch.ts` structure: env load,
   args `--dry-run/--limit/--stores/--concurrency`, Browserbase fallback closure, bounded
   concurrency, per-store try/catch → `sync_status`, totals summary). On non-dry-run, upsert
   `merch_products` (id = `hash(store_id + external_id)`) and update
   `merch_stores.product_count/last_synced_at/sync_status`.
   - **Gate:** `cd sdk && npx tsx scripts/ingestMerch.ts --dry-run --limit 5` prints products
     for known Shopify corps (e.g. Boston Crusaders, Colts) with title+price+url+image; a full
     run populates `merch_products` (`sqlite3 … "SELECT COUNT(*) FROM merch_products;"` > 0)
     and no store aborts the batch.

### M2 — Ingestion: universal fallback (all sites)
6. **Universal adapter.** Implement `universalJsonLdAdapter`: `sitemap.xml` discovery →
   PDP fetch (direct→Browserbase) → parse schema.org `Product` JSON-LD + OG fallback →
   `NormalizedProduct` with `cartCapability:'link'`. Wire it as the `Match.orElse` default.
   - **Gate:** ingest run yields ≥ 1 product for a majority of non-structured stores; every
     store with 0 products still has a `merch_stores` row (link-out). Totals block shows
     coverage per platform.

### M3 — Read-model emit (pre-gen + manifest)
7. **Builder + reader.** `sdk/src/readModel/builders/merch.ts` builds: store directory,
   catalog index (paginated if large), `facets.json`, and per-product/per-store detail
   objects. Add a reader for the server-fn fallback.
8. **Emit wiring.** In `sdk/scripts/emitReadModel.ts`, write merch shards under the snapshot's
   `merch/` dir and register `merchStores`/`merchCatalog` (+`merchFacets`) in `manifest.shards`
   exactly like `corps`. Detail shards go to `merch/products/<id>.json`, `merch/stores/<id>.json`.
9. **Manifest type.** Extend `ReadModelManifest['shards']` in `app/db/read-model-manifest.ts`.
   - **Gate:** `cd sdk && npx tsx scripts/emitReadModel.ts --json-snapshot ../public/read-model`
     produces `public/read-model/merch/...`, `manifest.json` lists the new shards with a `?v=`
     token, and `manifest.json` re-emit changes `version`.

### M4 — Catalog UI (read-only, link-out)
10. **Server fns + types.** Add `getMerchCatalogIndex/Page`, `getMerchStores`,
    `getMerchProduct`, `getMerchStore` to `app/lib/server-fns/hybrid.ts`; types +
    `MerchDirectoryService` in `app/lib/merch-directory.ts`.
11. **Predicates + filtering.** `app/predicates/merch.ts` (composable `Predicate`s) and
    `app/lib/merch-filtering.ts` (`Predicate.and` + `Match` sort).
12. **Filter machine + route.** `app/machines/merch-filter-machine.ts` (copy
    `judge-filter-machine.ts`) and `app/routes/merch/index.tsx` with `validateSearch` codec,
    `useSearchSync`, loader via `loadDetailOrServer`/index shard, `staleTime: 60_000`.
13. **Components.** `app/components/merch/{product-card,product-grid}.tsx` (copy
    `corps-card.tsx`, `.card-hover`); images via `proxiedImage`; `add-to-cart-button.tsx`
    rendering "Buy on website" for now (cart comes in M5).
14. **Detail route + SEO.** `app/routes/merch/$productId.tsx` (copy `corps/$slug.tsx`); emit
    `Product` JSON-LD + canonical/meta in the route `head`; `/merch` emits `ItemList`.
    - **Gate:** `npm run dev`, open `/merch`: products render, filters update the URL and the
      grid, every card links to the merchant. `/merch/<id>` shows detail with valid JSON-LD
      (paste into a schema validator). `npm run check` passes.

### M4b — Corps profile + nav integration (§23)
B1. **Corps "Shop" link (do this first — cheapest win).** Add `merch_url`/`has_merch`/
    `merch_platform` to the corps detail read-model row (builder + shard), then add one
    `SocialLink` entry in `app/routes/corps/$slug.tsx`. Flows through the existing renderer.
B2. **Nav entry.** Generate `ShoppingBag03Icon`/`ShoppingCartIcon` into
    `app/components/icons/generated/`; add the `/merch` item to `NAV_ITEMS` in `site-nav.tsx`.
B3. **Corps merch teaser.** Emit `corps-merch/<slug>.json` (≤ 8 products, §24); add the 5th
    loader call + `getCorpsMerch` server fn; render a guarded `<Card>` section reusing
    `MerchProductGrid`/`MerchProductCard` with a "Shop all" link.
    - **Gate:** a corps with a known store (e.g. Boston Crusaders) shows a Shop link in the
      about row and a Merch section with products; a corps with no store renders neither and
      makes no extra successful request. `npm run check` passes.

### M5 — Cart + handoff
15. **Cart store.** `app/stores/cart-store.ts` (copy `theme-store.ts`): `CartItem` (§8),
    events, localStorage subscriber, SSR-safe hydrate-on-mount.
16. **Cart link builders.** `app/lib/merch-cart-links.ts` per-platform (§9) with the
    Tier-A-degrades-to-link rule (invariant #7).
17. **Cart UI.** `cart-drawer.tsx` (mini-cart in nav), `app/routes/merch/cart.tsx`, and
    `open-on-sites-panel.tsx` grouping by store, one button per store. Wire
    `add-to-cart-button.tsx` to `addItem`/variant picker.
    - **Gate:** add items from ≥ 2 stores incl. one Shopify; reload (cart persists, no
      hydration warning); "Open at {store}" opens a pre-filled Shopify cart with the right
      variant+qty; Tier-B items open the product page.

### M6 — Polish & coverage (§12 P3)
18. BigCommerce/Squarespace/Wix adapters; variant pickers; scheduled re-sync; category
    normalization; sitemap entries for `/merch/$productId`.
    - **Gate:** coverage targets in §14 met; `npm run test` green.

## 22. Guardrails — common mistakes to avoid

- **Do not query a DB in a catalog hot path.** Catalog/detail reads go through shards +
  server-fn fallback (invariant #3). The server fn is the *fallback*, not the default.
- **Do not invent new caching.** Put shards under `/read-model/merch/**` and let `proxy.mjs`
  set headers. Do not add `cache-control` in route handlers.
- **Do not bypass the normalization boundary.** Platform-specific logic lives only in
  `merchCatalog.ts` adapters. Builders, shards, and UI see only `platform`/`cart_capability`.
- **Do not trust external JSON.** Decode with Schema at the boundary; drop undecodable rows;
  never `as any` a `products.json`/JSON-LD payload into the DB.
- **Do not auto-open multiple tabs.** One user gesture → one tab (popup blockers).
- **Do not sum prices across currencies** or present our price as live (show "as of …").
- **Do not silently truncate** a large catalog — paginate and `log()` any cap.
- **Do not hand-write shard URLs** — always go through the manifest (`detailShardUrl`,
  `indexShardUrl`) so cache-busting stays correct.
- **Keep ingest idempotent & isolated** — deterministic ids, upserts, per-store try/catch; a
  single store's failure must never abort the batch.
- **Match existing style** — run `npm run fmt` and copy the twin file's structure; do not pull
  in new deps (no axios/cheerio-alternatives; cheerio + effect are already here).

## 23. App integration — nav, corps profile, components

The Merch section is not an island. It plugs into the existing app at three points, and every
new component is **presentation-only** (see §25).

### 23.1 Navigation
Add one entry to `NAV_ITEMS` in `app/components/site-nav.tsx` (renders in both the desktop rail
and mobile bottom bar automatically):
```tsx
{ to: '/merch', label: 'Shop', icon: ShoppingBag03Icon, exact: false }
```
`GiftIcon` already exists in `app/components/icons/generated/`; a cart/bag icon does **not** —
generate `ShoppingBag03Icon` (and a `ShoppingCartIcon` for the cart) into that dir via the
existing unplugin-icons/Hugeicons flow before wiring nav + cart. Until then, fall back to
`GiftIcon`.

### 23.2 Corps profile — "Shop" link in the about/links row (cheap, ship first)
The scan already wrote `corps.merch_url`/`merch_platform`/`has_merch`. The store link is a
**near-zero-cost win independent of the full catalog**:
1. Include `merch_url`, `has_merch`, `merch_platform` in the corps detail read-model row
   (builder `buildCorpsBySlug` / corps detail shard) so `getCorps` returns them.
2. In `app/routes/corps/$slug.tsx`, add one entry to the existing `links: SocialLink[]` array:
   ```tsx
   { label: 'Shop', href: corps.merch_url, icon: ShoppingBag03Icon },
   ```
   It flows through the existing `activeLinks = links.filter(l => l.href)` + `<For>` renderer —
   no new markup. Done.

### 23.3 Corps profile — a "Merch" section (a few products)
Show up to ~6 products from that corps's store as a teaser that links to the full store and to
`/merch?store=<corps>`.
- **Data:** add a 5th loader call in the corps route, mirroring the others:
  ```tsx
  loadDetailOrServer(`corps-merch/${slug}.json`, () => getCorpsMerch({ data: slug }))
  ```
  Emit a small `corps-merch/<slug>.json` detail shard (top N products by availability, capped —
  **not** the whole catalog) so the corps page payload stays tiny.
- **Render:** a new `<Card>`/`<section>` (copy the "2026 Season Scores"/"Appearances" section
  pattern), guarded by `<Show when={merch.length > 0}>`, containing a `MerchProductGrid` of
  `MerchProductCard`s + a "Shop all at {corps}" link. Both components are the *same*
  presentational components used by the catalog route (reuse, don't fork).
- **Invariant:** the corps page must not regress if merch is absent/stale — section simply
  doesn't render (zero extra requests when the shard 404s and the server fn returns empty).

### 23.4 Components (all presentation-only, in `app/components/merch/`)
| Component | Props (data in) | Events (out) | Mirrors |
|---|---|---|---|
| `MerchProductCard` | `product: MerchProductSummary` | `onAdd?(product)` | `corps-card.tsx` (+ `.card-hover`) |
| `MerchProductGrid` | `products: MerchProductSummary[]` | — | `event-card.tsx` `EventCardGrid` |
| `VariantPicker` | `variants`, `selectedId` | `onSelect(id)` | `filter-chips.tsx` |
| `AddToCartButton` | `product`, `capability` | `onAdd()` | `ui/button.tsx` (variant by `Match` on capability) |
| `StoreCard` | `store: MerchStoreSummary` | — | `corps-card.tsx` |
| `CartLineItem` | `item: CartItem` | `onRemove`, `onQty` | `filter-chips.tsx` |
| `OpenOnSitesPanel` | `groups: StoreGroup[]` | `onOpen(storeId)` | new, but pure |

Primitives come from `@/components/ui/card`, `@/components/ui/button`, `@/components/icon`.
Images go through `proxiedImage()` (`@/lib/media`). No component fetches data or reads the URL.

## 24. Performance budget & tactics

Treat these as acceptance numbers (extend §14):

- **Catalog index shard** carries only list-render fields (id, title, storeId, storeName,
  priceMin/Max, currency, image, capability, category, available). Target **≤ 150 KB gzipped
  per page shard**; paginate at ~200 products/shard. Full product (variants, all images,
  description) lives only in the per-product detail shard, fetched on demand.
- **Corps-merch teaser shard** ≤ ~8 products, **≤ 15 KB**. The corps page must not grow its
  critical payload meaningfully.
- **Images:** every product image rendered via the media proxy with explicit `width` +
  `srcSet` (as corps photos do) so they’re resized/WebP/immutable-cached; reserve dimensions
  (no CLS); `loading="lazy"` + `decoding="async"` below the fold.
- **Cache:** all merch data served from `/read-model/merch/**` — manifest revalidated
  (`max-age=60, SWR=86400`), shards immutable (`?v=`). No request-path DB query for catalog
  (invariant #3).
- **Code-split the cart:** the cart store + drawer load only on interaction/`/merch/cart`; the
  catalog browse path ships no cart JS it doesn’t need. Persisted-store hydration runs
  on-mount, never blocking SSR.
- **Filtering is client-side over the index + precomputed `facets.json`** (instant, no
  round-trip); URL is the source of truth (§17) so results are shareable and SSR-rendered.
- **Prefetch:** rely on TanStack Router default intent/viewport preloading for `/merch/$id`;
  do not hand-roll prefetch.
- **No N+1:** the corps-merch shard is emitted in the builder pass, not fetched per-card.
- **`staleTime: 60_000`** on merch routes (matches the rest of the app) for in-memory SWR
  across client navigations.

## 25. Presentation-only component rule (preferred style)

Per `CLAUDE.md` ("data fetching → route loader, never a client effect"; "`useEffect` is a code
smell"), all merch UI follows the data↔presentation split the app already uses
(`filter-chips.tsx` is the reference: "Purely presentational… owns no URL/filter state"):

- Components in `app/components/merch/**` receive **all data via props** and emit **events via
  callbacks**. No server fns, no fetching, no `useEffect`, no URL reads inside them.
- **Derivation/selectors** (grouping cart items by store, building handoff URLs, price
  formatting, facet computation) live as **pure functions in `app/lib/merch-*.ts`** and
  `app/predicates/merch.ts` — unit-testable without React.
- **State** lives at the edges: route loaders (server data), `merch-filter-machine` (URL-synced
  filter/sort), and `cart-store` (persisted cart). Components render the result.
- This keeps every card/section reusable across the catalog route, the corps profile teaser,
  and the cart — one `MerchProductCard`, three contexts.
