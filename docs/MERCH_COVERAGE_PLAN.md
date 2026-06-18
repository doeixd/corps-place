# Merch Coverage Plan — get every group's products into the shop

**Goal:** every corps store, on every platform, with all its products ingested and
browsable on the site. No store silently invisible.

> Revised after reading `MERCH_DEPLOY.md`, `DATA_QUALITY_NOTES.md`, and
> `sdk/docs/web-research-and-scraping-field-guide.md` — folds in the `syncMerch`
> orchestrator, R2 distribution, the Browserbase fallback (and its limits), the
> image/media-cache pipeline, the scraping tool-ladder, and known data/SSR traps.

## Diagnosis (verified live, 2026-06-15)

Two independent root causes, not one:

1. **Discovery stored the wrong URL.** Many corps link off-domain to their real
   store; the scanner kept the corps homepage (or missed the link). Verified:
   - Carolina Crown: stored `carolinacrown.org` (a Squarespace *corps* site);
     real store is `thecrownstore.com` → **BigCommerce**.
   - Phantom Regiment: `has_merch=0` (missed entirely); real store is
     `thephanshop.com` → **Shopify** (would ingest with the *existing* adapter).
2. **No real adapters** for BigCommerce / Squarespace / Wix / Square. They fall
   through to `universalJsonLdAdapter`, which returns 0 (its `PRODUCT_URL_RE`
   doesn't match `/product-page/`, BigCommerce slugs are root-level, Squarespace
   needs its JSON endpoint).

Current DB: 27 stores `ok` (2,406 products, all Shopify/Woo/BigCartel), 38
`partial` (0 products), 10 `error`, 18 `link-only`.

**Per-platform feed routes (verified):**
- Squarespace: `<storePage>?format=json` → `items[]` with price (cents),
  variants, image asset URLs. (Music City: 44 items.)
- BigCommerce: `/sitemap.xml` + per-PDP schema.org Product JSON-LD.
- Wix: `/store-products-sitemap.xml` → `/product-page/<slug>` PDPs (JS-rendered →
  needs the Browserbase fallback, see below).
- Square Online (`*.square.site`): tenant sitemap + per-PDP JSON-LD.

**ACP/UCP:** Agent Commerce Protocol (OpenAI+Stripe) is checkout/payment, not
catalog discovery — useless for reading third-party catalogs. UCP (Google+Shopify)
covers discovery but is merchant-opt-in, no public read feed. So ingestion =
platform feeds + structured data, as below.

## Key facts the existing pipeline already gives us (don't reinvent)

- **One orchestrator: `sdk/scripts/syncMerch.ts`** chains seed → ingest → emit →
  push read-model → redeploy. Flags: `--scan` (re-detect platforms first, slower),
  `--publish <prod|dev>`, `--no-restart`. Use this, not manual script chains.
- **Distribution is R2, not Turso (2026-06-15).** `--publish` emits the read-model,
  uploads to the Cloudflare R2 bucket, and redeploys via the Coolify API so the
  container pulls the new generation on boot. (`MERCH_DEPLOY.md` §2; the Turso path
  was removed — recent commit `e7467d9`.)
- **Browserbase fallback already exists — but know its limit.**
  `fetchHtmlWithFallback` in `merchCatalog.ts` reads `BrowserbaseService` via
  `Effect.serviceOption` — adapters get it for free when `BROWSERBASE_API_KEY` is
  set, direct-only otherwise. ⚠️ Per the field guide §3b/§9, Browserbase
  `fetchHtml` returns **initial server HTML only — it does NOT hydrate SPA
  content.** So it's a *Cloudflare-bypass*, not an SPA renderer. Our adapters are
  fine because **all four platforms put the product data in the initial HTML**
  (Squarespace JSON endpoint; BigCommerce/Wix/Square emit Product JSON-LD in the
  raw HTML — Wix verified). We do **not** depend on hydrated DOM. If a future store
  hides products behind hydration, escalate to a real *rendering* browser
  (`renderHtml.ts`, free local puppeteer — field guide §3), not Browserbase.
- **Image allowlist already covers shopify/squarespace-cdn/wixstatic/bigcommerce**
  (`app/lib/media.ts`). Square's CDN may be missing — verify/add (see Step 5).
- **`CorpsMerchTeaser` already carries `storeUrl`** (`builders/merch.ts:68`) and is
  emitted as `rm_merch_corps_teaser` — the hook for link-only profile display.
- **Defect isolation:** `ingestMerch` wraps each store in `Effect.catchCause`; a
  bad store is marked `error` and the batch continues. Adapters should return `[]`
  (never throw) on "no products".

**Decisions (product owner):** ingest **full catalogs, paginated** (no artificial
cap); true link-only stores get **a store link on the corps profile page**, not a
standalone shop card.

## Scraping discipline (field guide)

- **Tool ladder, cheapest first** (field guide §1): curl `-A "Mozilla/5.0"` probe →
  direct fetch → free local puppeteer render (`renderHtml.ts`) → Browserbase ($).
  During adapter dev, prefer the free rungs; reserve Browserbase for stores a direct
  fetch can't reach.
- **Spike before coding each adapter:** `renderHtml.ts <pdp> out.html` (or `curl -A`)
  and grep for `application/ld+json` / the data endpoint to confirm where products
  actually live, *then* write the adapter. Cheap de-risking; one probe already
  corrected the Wix assumption below.
- **Verify URLs with curl `Content-Type` before trusting them** (field guide §6): a
  `200 text/html` for a product/image URL is a masquerading 404 — reject it. Real
  images are `Content-Type: image/*`. Used in the bad-store guard (1.2) and image
  warming (5.3).
- **Don't trust a WebFetch 404** (field guide §4) — re-check with curl/render.
- **Reviewable-diff before apply** (field guide §10): the Step-1 scanner rewrite
  changes stored URLs — dry-run and eyeball the diff before committing, so a bad
  latch (1.2) never silently overwrites a good `merch_url`.

---

## Step 1 — Rewrite the scanners (discovery)

Files: `sdk/src/merchScan.ts`, `sdk/scripts/scanMerch.ts`.

1.1 **Follow off-domain store links.** In `findMerchLink()`, when the best store
link points to a *different* host than the corps site, fetch and `classify()` that
**destination** and store its `merch_url`/`merch_platform`/`merch_signals`. Recovers
Phantom Regiment (→ Shopify) and Carolina Crown (→ BigCommerce) immediately.

1.2 **Guard against bad latches (DATA_QUALITY_NOTES §4 + field guide §6/§8).**
Following off-domain links *raises* the risk of latching a third party (a corps →
vicfirth.com via a Facebook link, a Google Play app, `fbclid=` URLs). Before
accepting a destination as a store, require ecommerce signals from `classify()`
(platform ≠ none/unknown, or a real product probe verified by curl `Content-Type`,
not just a 200). Reject vendor/social/app domains. Keep the `listed=0` +
null-`merch_url` remediation for any that slip through.

1.3 **Widen detection patterns:** add `/product-page/` (Wix), `*.square.site`
hosts, and map BigCommerce/Squarespace/Wix/Square to concrete platform values
instead of `other-ecommerce`. Keep `isLinkOnlyHost` (bonfire.com) intact.

1.4 **Preserve `corps_key` linkage** whether the store is on the corps domain
(Squarespace `/shop`) or off-domain (thecrownstore.com).

**Exit check:** dry-run scan over the ~12 named corps prints correct `merch_url` +
`merch_platform`; Phantom Regiment no longer `has_merch=0`; no new vendor/social
domains latched.

## Step 2 — Rescan

1. `npx tsx sdk/scripts/syncMerch.ts --scan` (locally, no publish) — re-detects
   platforms first, then seeds + ingests against the box DB. Note the nightly cron
   (`sync-merch.sh` @ 02:00) does **not** pass `--scan`, so this one-time scan is
   what repoints the stored URLs.
2. Diff results vs current `corps.merch_*`; spot-check the named corps + a sample of
   the 38 `partial` / 10 `error` stores.
3. Commit refreshed scan results under `sdk/results/merch-scan/`.

**Exit check:** every named corps has a non-null `merch_url` and a concrete platform
(no `other-ecommerce`/`none` for the known-good list).

## Step 3 — Write ingestion adapters

File: `sdk/src/merchCatalog.ts`. Each adapter returns `NormalizedProduct[]`, fully
paginated, uses `fetchHtmlWithFallback` (Browserbase-aware), and returns `[]` on
empty (never throws).

3.1 **BigCommerce adapter.** Sitemap discovery → fetch PDPs → reuse `productFromHtml`
JSON-LD path. `cartCapability: "prefill"` if a cart URL is derivable, else `"link"`.
Target: thecrownstore.com.

3.2 **Squarespace adapter.** GET `<storePage>?format=json`; map `items[]`:
`title`, `body`→description, `structuredContent.variants[]` (price cents→dollars,
SKU, stock), `assetUrl`/`items[].image`, productUrl = `<store>/<urlId>`. Paginate
via `?format=json&offset=`. ⚠️ Squarespace stores **`http://` image URLs** — fine,
the proxy upgrades http→https for allowlisted hosts (DATA_QUALITY_NOTES §5).

3.3 **Wix adapter.** Read `/store-products-sitemap.xml` (follow the index), fetch
each `/product-page/<slug>` via `fetchHtmlWithFallback`, extract JSON-LD with
`productFromHtml`. ✅ **Verified:** Wix server-renders `@type:Product` JSON-LD +
`product:price` og-tags in the *initial* HTML — a plain fetch gets it, **no SPA
hydration required** (Browserbase, if used, is only for a Cloudflare challenge, not
rendering). Add `/product-page/` to `PRODUCT_URL_RE`.

3.4 **Square Online adapter.** Scope strictly to the `*.square.site` tenant
subdomain (avoid cross-tenant bleed); read its sitemap, fetch PDPs, extract JSON-LD.

3.5 **Pagination / no cap.** Per decision, don't cap at 60 — paginate to completion
with a high safety ceiling, and `log()` if the ceiling is hit (visible truncation,
DATA_QUALITY_NOTES §4). Keep `UNIVERSAL_CONCURRENCY` polite.

3.6 **Wire `selectAdapter()`:** `bigcommerce`/`squarespace`/`wix`/`square` → new
adapters; keep Shopify/Woo/BigCartel; universal stays fallback for
`other-ecommerce`/`unknown`.

3.7 **Slim ingest image.** New adapters must stay within `Dockerfile.merch-ingest`
deps (tsx/effect/sql-libsql/libsql/cheerio/browserbase) — **no tfjs/Playwright**.
cheerio + Browserbase SDK cover all four adapters; no new deps expected.

**Exit check:** manual run of each adapter against one real store prints a non-empty,
well-formed list (title + price + image + url).

## Step 4 — Ingest / update data (run the pipeline)

Files: `seedMerchStores.ts`, `ingestMerch.ts`, `builders/merch.ts`.

1. `syncMerch --scan` (already run in Step 2) re-seeds with corrected platforms.
2. Ingest: confirm `sync_status` flips `partial→ok`, `product_count` populates.
3. **Shared-storefront dedup (DATA_QUALITY_NOTES §4):** siblings/feeder/alumni corps
   share one shop — `electPrimaries` keeps one primary, demotes the rest to
   link-only. Re-check after URL fixes (a corrected URL may newly collide).
4. **Prune stale rows:** ingest must delete `synced_at <> thisRun` after a non-empty
   fetch, or changed `external_id`s pile up as same-URL dupes. (Existing logic —
   verify it still fires for the new adapters.)
5. Locally inspect with a **full** emit (a `--only merch` partial does NOT publish
   and may leave deps empty — DATA_QUALITY_NOTES §3).

**Exit check:** `SELECT sync_status, count(*), sum(product_count) FROM merch_stores
GROUP BY 1` shows the `partial` bucket collapsing; total products well above 2,406.

## Step 5 — Display + images

5.1 **Ingested stores** flow through automatically (productCount > 0): landing
groups, `/shop/all` facets, store pages. No code change beyond data.

5.2 **Link-only stores → corps profile link.** Emit the `CorpsMerchTeaser`
(carries `storeUrl`) even when the corps has a store URL but 0 ingested products,
and render a "Visit {corps} store" link on the corps profile merch section.
⚠️ **Use a React short-circuit `{teaser && teaser.storeUrl ? <…> : null}`, NOT
`<Show>`** — `<Show>` evaluates children eagerly and 500'd `/corps/gold` for a corps
with no store (DATA_QUALITY_NOTES §6). Keep these stores filtered out of the shop
landing/catalog per decision.

5.3 **Images / media cache (DATA_QUALITY_NOTES §5) — don't skip.** Ingested products
are useless if images don't render:
   - Verify the new platforms' image hosts are in `isProxiableImageHost`
     (`app/lib/media.ts`): shopify/squarespace-cdn/wixstatic/bigcommerce are present;
     **add Square's CDN (`square.site`/`squarecdn.com`) if absent.**
   - Warm the cache: run `warmMerchImages.ts` after ingest so bytes land in the
     bind-mounted `media-cache.db` at the exact widths the UI requests (cards
     400/800, detail 720, gallery thumb 96).
   - Store logos: scrape the real brand mark (JSON-LD `Organization.logo` → og:image
     → header img → apple-touch-icon), never `/favicon.ico` (`scanStoreLogos.ts`).

5.4 Verify `/shop/stores` still lists everything with an accurate "N with browsable
catalogs" subtitle.

## Step 6 — Publish, verify, double-check

1. **Publish:** `npx tsx sdk/scripts/syncMerch.ts --publish prod` (emit → R2 →
   Coolify redeploy). The redeploy is required so the container pulls the new R2
   generation on boot. If Coolify token is absent it warns + exits 0 — don't treat a
   skipped redeploy as a failed sync (MERCH_DEPLOY §9).
2. **Verify the published box slot**, not the prod fallback: query
   `sdk/read-model.a.db` (or `.b` per `read-model.active`) — NOT
   `/data/corps-place/read-model.*.db` (DATA_QUALITY_NOTES §8).
3. **Verify live:** `curl -k -H 'Host: drumcorps.app' https://127.0.0.1/shop` (and a
   store page + a corps profile with a link-only store); allow ~30–60s after deploy.
4. **Walk the original list** (Blue Knights, Carolina Crown, Phantom Regiment,
   Troopers, Colts, Spirit of Atlanta, Madison Scouts, Pacific Crest, Music City,
   Seattle Cascades) — each reachable from the shop or its profile, products where
   ingestable.
5. **Rollups & quality:** re-run the `sync_status` rollup; investigate remaining
   `error` rows; sanity-check titles/prices/images/dead-links/dedup; confirm no
   pagination ceiling was silently hit (Step 3.5 logs).
6. **Ongoing:** the nightly `sync-merch.sh` (02:00 UTC) keeps catalogs fresh
   thereafter — but it doesn't `--scan`. Decide whether to add periodic `--scan`
   (e.g. weekly) so newly-moved storefronts get re-detected, balanced against scan
   cost / store politeness (MERCH_DEPLOY §4 cadence note).

---

## Sequencing & ROI
- **Steps 1–2 first** (cheap): recover off-domain Shopify stores (Phantom Regiment)
  with zero new adapter code.
- **Step 3 BigCommerce + Squarespace next**: biggest remaining gaps (and Squarespace
  has the richest feed).
- **Step 3 Wix + Square** (Wix needs Browserbase), then **4–6**.
- Treat **Step 5.3 (images)** as part of "done" — products with broken images read
  as a worse bug than missing products.
