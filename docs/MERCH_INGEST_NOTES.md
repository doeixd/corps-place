# Merch ingestion — platform notes, gotchas & runbook

Everything learned bringing the shop from 27 → 48 working stores (2,406 → ~5,600
in-stock products) in 2026-06. Pairs with [`MERCH_COVERAGE_PLAN.md`](./MERCH_COVERAGE_PLAN.md)
(the plan), [`MERCH_DEPLOY.md`](./MERCH_DEPLOY.md) (how it ships), and
[`DATA_QUALITY_NOTES.md`](./DATA_QUALITY_NOTES.md) §4 (merch data-quality bugs).
Scraping mechanics live in [`../sdk/docs/web-research-and-scraping-field-guide.md`](../sdk/docs/web-research-and-scraping-field-guide.md)
§3c/§9.

## TL;DR of the pipeline
`scanMerch` (find store URL + platform) → `seedMerchStores` (one `merch_stores`
row per store) → `ingestMerch` (per-platform adapter → `merch_products`) →
`emitReadModel` → publish to R2 → app. Source of truth is the box's
`sdk/dci-relational.db`; prod serves a frozen read-model. `syncMerch` chains it.

---

## 1. The render layer — local Chromium first (free), Browserbase fallback

`sdk/src/browserbaseService.ts` (`BrowserbaseServiceLive`, `fetchHtml(url)`):
1. **Local headless Chromium** — `/usr/bin/chromium` via puppeteer-core (already
   installed on the box). Free, unlimited, parallel. ONE shared `Browser`, a `Page`
   per fetch. Launch args: `--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage`.
2. **Browserbase cloud session** — fallback only. **We're on the FREE plan**
   (concurrency 3, limited minutes) so avoid it. Its hosted `fetchAPI` is plan-gated
   (402 even with a valid key) and never hydrated SPAs; its *sessions* product works
   (connect puppeteer over CDP) but saturates the free quota fast. The valid key +
   projectId are in repo-root `.env` (auto-resolves projectId from the API if unset).

Needs **no API key** for the local path; `scanMerch`/`ingestMerch` always provide
the layer. `findLocalChrome()` honours `CHROME_PATH`/`PUPPETEER_EXECUTABLE_PATH`.

### Render-readiness — wait for the SIGNAL, never `networkidle`
**Biggest gotcha.** `waitUntil:"networkidle2"` hangs the full nav timeout — store
pages run recaptcha/Sentry/analytics that never let the network idle (made every
render ~45 s and timed out batch jobs). Use `domcontentloaded` + `waitForSelector`
on the element you want (JSON-LD script), capped at 8 s. A render then takes ~1–3 s.
See `settleForContent()`.

### Memory (the box has ~1–2 GB free)
Each Chromium page on a big SPA store is ~3 MB DOM + ~80–150 MB process overhead.
`UNIVERSAL_CONCURRENCY = 3` (per-store PDP concurrency) and ingest `--concurrency 2`
is the safe ceiling. Orphaned `chromium` procs survive a killed ingest and hold
memory — `pkill -9 chromium` between runs. **Don't `pkill -f ingestMerch` in the
same command that relaunches it** — the pattern matches the new command's own shell
and kills the launch (exit 144). Kill, then relaunch in a separate step, or `nohup`.

---

## 2. Adapter selection & discovery

`selectAdapter(platform, storeUrl?)` in `merchCatalog.ts` — host-specific adapters
win over platform: bonfire by host, then `shopify`/`woocommerce`/`bigcartel`/
`squarespace` by platform, else the **universal** (sitemap + JSON-LD) adapter for
`bigcommerce`/`wix`/`other-ecommerce`/`unknown`.

**Universal discovery** (`discoverProductUrls`): expand sitemap *indexes* → leaves,
then PREFER product sitemaps (`PRODUCT_SITEMAP_RE`: `store-products`,
`type=products`, `sitemap_products`, `/sitemap/products/`, …). Without this, a
store that lists blog/event sitemaps *before* products (Wix does) starves the
candidate pool with non-products → 0 real products. BigCommerce paginates products
across `xmlsitemap.php?type=products&page=N` — followed until a page yields nothing.
Cap `UNIVERSAL_MAX_PRODUCTS = 3000` (full-catalog; logs on hit).

**Client-rendered detection / signal-based fallback:** `fetchHtmlWithFallback(url,
…, wantSignal)` renders via the render layer when the plain fetch's HTML *lacks the
signal* (`hasProductJsonLd`), not just when empty. A non-empty SPA *shell* with no
Product JSON-LD ⇒ client-rendered ⇒ render it. Server-rendered stores never pay the
render cost.

---

## 3. JSON-LD extraction quirks (`productFromHtml` / `collectProductNodes`)
- **Descend into `mainEntity`**, not just `@graph`/arrays — Weebly/Square wrap the
  Product in a `WebPage.mainEntity` (bkmarketplace).
- **Casing varies**: Wix emits `Offers` (cap O), `Availability` (cap A); images as
  `ImageObject.contentUrl` not `url`. `offerPrices`/`collectImages` handle both.
- Offers may be `AggregateOffer` with `lowPrice`/`highPrice` (handled).
- **Last-resort rendered-DOM heuristic** (no JSON-LD *and* no og:product): `<h1>`
  title, the cdn product `<img>` (strip the resize query), price via a
  **cents-required** regex `/\$\s?([0-9]+\.[0-9]{2})\b/` (so "$75 free shipping"
  isn't mistaken for the price). Fragile — title/image reliable, price partial.

---

## 4. Per-store / per-platform findings (concrete)
| Store | Platform | How it's ingested | Notes |
|---|---|---|---|
| Phantom Regiment | Shopify (`thephanshop.com`) | `products.json` | was *not found* — regiment.org is Cloudflare + links off-domain |
| Carolina Crown | BigCommerce (`thecrownstore.com`) | sitemap + JSON-LD | corps `/shop` 301s off-domain; ~493 products |
| The Cavaliers | BigCommerce | sitemap + JSON-LD | |
| Blue Knights | Weebly/Square (`bkmarketplace.org`) | **render** + JSON-LD `mainEntity` | client-rendered SPA; ~274 PDPs → render-heavy |
| DCI Store | Shopify **Hydrogen** (`store.dci.org`) | shopify→universal fallback → **rendered-DOM heuristic** | `products.json` & `/products/<h>.js` 404; static HTML has no product data (React-Router loader); price coverage ~50% |
| Music City | Squarespace | `?format=json` | richest feed (variants, cents prices) |
| Spirit of Atlanta | Wix | `store-products-sitemap.xml` + JSON-LD | JSON-LD is server-rendered (no hydration needed) |
| 7th Regiment | **bonfire** | scoped REST `/rest/stores/<slug>/` | see §5 |
| Seattle Cascades | Square Online (`*.square.site`) | **link-only** | client-rendered, no JSON-LD/product URLs, only global sitemap; needs Square API or DOM render |

---

## 5. Platform deep-notes worth keeping
- **Squarespace**: `<storePage>?format=json` → `items[]` with `structuredContent`
  (`priceCents`, `variants[].sellingPrice`-equivalent, `onSale`). Prices in **cents**.
  Paginate via the response's own `pagination.nextPageOffset` — do NOT guess an
  `offset` (a stale guess 500s and would discard the page). `assetUrl` = main image.
- **Wix**: products sitemap at `/store-products-sitemap.xml` (off `/sitemap.xml`
  index); PDPs are `/product-page/<slug>` with **server-rendered** Product JSON-LD.
- **BigCommerce**: `xmlsitemap.php` is a sitemap index with a `?type=products` child;
  PDPs (root-level slugs) carry clean Product JSON-LD.
- **Shopify Hydrogen** (headless/Oxygen): `products.json`, `/products/<h>.js`,
  `.json` all 404; data is in a React-Router `<route>.data` turbo-stream endpoint
  (reference-encoded, fragile to parse) and renders client-side. We use the
  rendered-DOM heuristic. A cleaner future path = the Storefront API token (embedded
  in the page) or decoding the `.data` stream.
- **bonfire** (multi-tenant POD): pure SPA, only a GLOBAL sitemap (the universal
  adapter would ingest *other* tenants' products — why it was link-only). BUT its
  store page calls a **per-tenant** REST endpoint: `/rest/stores/<storeSlug>/` →
  `campaigns[].campaign` with `name`, `slug` (PDP = `bonfire.com/<slug>/`),
  `productTypes[].products[].sellingPrice`, and design images at
  `designs[].dimensions["900"]`. Scoped, no rendering. `bonfireAdapter` + `isBonfireHost`.
  **Finding a store's hidden JSON API beats rendering N PDPs** — capture XHR/fetch
  in puppeteer (bkmarketplace = Weebly `cdn*.editmysite.com/app/store/api/v*/…`).

---

## 6. Scanner (`merchScan.ts`) lessons
- **Store the resolved `finalUrl`** as `merch_url`, not the link href — a corps
  `/shop` that 301s off-domain (Crown → thecrownstore.com) must ingest at the dest.
- **curl fetch tier** between Node `fetch` and Browserbase: Node `fetch` (undici)
  gets a 403 Cloudflare challenge where curl gets 200 — but curl must send a
  **generic `Mozilla/5.0`** UA; a detailed Chrome UA trips the TLS-fingerprint
  mismatch (→ 403). Recovered Phantom Regiment.
- **Off-domain store hostnames** scored: a host containing shop/store/merch/gear
  (thephanshop, thecrownstore, troopstore, scoutsproshop).
- **Cloudflare rate-limits by IP under concurrency** — a c6 scan produced false
  "none"s that resolved at c2/c1. Re-run blocked sites at low concurrency; guard
  bulk re-runs with a before/after diff so a transient block can't overwrite good data.
- **Parked domains** render to a GoDaddy/`domainparking` lander (cadets.org) — not a
  scrape failure, a lapsed domain.

## 7. Dedup, canonical owners, out-of-stock
- **Shared storefronts**: sibling/feeder/alumni corps point at one shop (Blue Devils
  A/B/C → `store.bluedevils.org`). `electPrimaries` keeps ONE primary, demotes the
  rest to link-only; catalog also dedups by `product_url`. Correct behaviour.
- **Canonical-owner override** (`CANONICAL_OWNER` in `ingestMerch.ts`) for shared
  stores where the host matches NEITHER name: `bkmarketplace → Blue Knights` (else
  the shortest-name tiebreak picked "BKXperience").
- **Out-of-stock filtering** (read-model only, `merch.ts`): `IN_STOCK =
  (p.available IS NULL OR p.available <> 0)` in the JOINs hides *explicitly* sold-out
  products from catalog/teasers/detail/facets and recomputes the store directory
  count live. **Unknown (`NULL`) stays visible** — ~939 products (non-Shopify stores
  rarely report stock); hiding those would nuke whole catalogs. Takes effect on the
  next read-model emit (no re-ingest).

## 8. Operational runbook
- **Run from `sdk/`** with repo-root `.env` loaded (`loadRepoEnv`).
- Re-scan (slow, re-detects platforms): `npx tsx scripts/scanMerch.ts --corps-only
  --concurrency 2` (low concurrency avoids Cloudflare rate-limits). `--dry-run` first.
- Ingest: `npx tsx scripts/ingestMerch.ts --concurrency 2` (memory). Targeted:
  `--stores <store_id>` (skips the primary election — honours ids verbatim).
- Full chain + publish: `npx tsx scripts/syncMerch.ts --publish prod` (seed → ingest
  → emit → R2 → Coolify redeploy). Nightly cron `sync-merch.sh` @ 02:00 does this but
  **does not `--scan`** — moved storefronts need a manual `--scan`.
- Per-store writes are committed as the run proceeds, so a killed/restarted ingest
  keeps finished stores; upserts are idempotent + prune stale rows by `synced_at`.

## 9. Known gaps / TODO
- **DCI price coverage ~50%** — rendered-DOM price is best-effort. Cleaner: Storefront
  API or decode the React-Router `.data` turbo-stream.
- **Square Online** (`*.square.site`) still link-only — needs Square API or DOM render.
- **~19 `partial` (0-product) + ~8 `error` stores** unaudited — mix of genuinely-empty
  stores, Wix variants the products-sitemap path misses, and dead/parked sites.
- **Some Wix stores return 0** (e.g. "Buccaneers Alumni") — verify empty vs missed.
- **Slim ingest Docker image lacks Chromium** — the nightly job runs ON THE BOX
  (which has `/usr/bin/chromium`); if ever run in that image, install chromium there
  or it falls back to (free-plan-limited) Browserbase.
- **Browserbase free plan** — keep relying on local Chromium; don't let a code path
  fan out cloud sessions.

## 10. Current state (2026-06-15)
~48 `ok` stores, ~5,600 in-stock products (from 27 / 2,406). All flagship corps +
the DCI vendor store ingesting. Code changes NOT yet committed or published — the
out-of-stock filter and all adapter work take effect on the next emit/publish.
