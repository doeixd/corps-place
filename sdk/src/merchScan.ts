// Merch / ecommerce footprint detection for corps + drum-corps vendors.
//
// Effect-native: scanTarget/scanTargets return Effects. The homepage/merch-page
// fetch reuses the BrowserbaseService LAYER opportunistically via serviceOption
// (direct fetch first; Browserbase fallback when blocked/empty and the layer is
// provided). Fetch failures are folded into the result's `error` field, so a scan
// never fails its Effect — callers always get a MerchScanResult per target.
//
// Driven by scripts/scanMerch.ts; results persist to JSON + the corps table.

import * as cheerio from "cheerio";
import { execFile } from "node:child_process";
import { Effect, Option } from "effect";
import { MerchFetchError } from "./errors.js";
import { BrowserbaseService } from "./browserbaseService.js";

export type MerchPlatform =
  | "shopify"
  | "woocommerce"
  | "squarespace"
  | "bigcommerce"
  | "wix"
  | "bigcartel"
  | "other-ecommerce"
  | "none"
  | "unknown";

export interface MerchScanTarget {
  readonly name: string;
  readonly kind: "corps" | "vendor";
  readonly corpsKey?: string | null;
  readonly website: string;
}

export interface MerchScanResult {
  readonly name: string;
  readonly kind: "corps" | "vendor";
  readonly corpsKey: string | null;
  readonly website: string;
  readonly merchUrl: string | null;
  readonly finalUrl: string | null;
  readonly hasMerch: boolean;
  readonly platform: MerchPlatform;
  readonly signals: ReadonlyArray<string>;
  readonly passwordProtected: boolean;
  readonly parked: boolean;
  readonly fetchVia: "direct" | "browserbase" | "none";
  readonly error: string | null;
  readonly checkedAt: string;
}

export interface MerchScanOptions {
  /** Per-request timeout in ms (default 15000). */
  readonly timeoutMs?: number;
  /** ISO timestamp for the run; pass one in so a batch shares a stamp. */
  readonly checkedAt?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 15000;

interface PageFetch {
  readonly status: number;
  readonly finalUrl: string;
  readonly html: string;
  readonly headers: Record<string, string>;
  readonly via: "direct" | "browserbase";
}

const normalizeUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProto = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    return new URL(withProto).toString();
  } catch {
    return null;
  }
};

/** Direct fetch with timeout + UA; follows redirects, returns final URL + headers. */
const directFetch = (
  url: string,
  timeoutMs: number,
): Effect.Effect<PageFetch, MerchFetchError> =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
          signal: controller.signal,
        });
        const html = await response.text();
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        return {
          status: response.status,
          finalUrl: response.url || url,
          html,
          headers,
          via: "direct" as const,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    catch: (cause) =>
      new MerchFetchError({
        message: String((cause as Error)?.message ?? cause),
        url,
        statusCode: 0,
        cause,
      }),
  });

/**
 * curl fetch — passes most Cloudflare bot checks that Node's `fetch` fails (undici's
 * TLS fingerprint gets a 403 challenge where curl's TLS stack gets 200). Free, and the
 * box has curl. Returns null if curl is absent/errors so callers fall through. We can't
 * cheaply get response headers here, so this reports `via: "direct"` with empty headers —
 * classify() then relies on HTML signals (cdn.shopify/wixstatic/bigcommerce/…), which is
 * sufficient. Final (post-redirect) URL + status come from a `-w` sentinel.
 */
const SENTINEL = "\n__CURLMETA__";
const curlFetch = (
  url: string,
  timeoutMs: number,
): Effect.Effect<PageFetch | null, never, never> =>
  Effect.callback<PageFetch | null>((resume) => {
    execFile(
      "curl",
      [
        "-sL",
        "--compressed",
        // A *generic* UA — Cloudflare flags a curl request that claims to be Chrome
        // (UA/TLS-fingerprint mismatch → 403); a plain "Mozilla/5.0" passes.
        "-A",
        "Mozilla/5.0",
        "--max-redirs",
        "5",
        "-m",
        String(Math.ceil(timeoutMs / 1000)),
        "-w",
        `${SENTINEL}%{url_effective}\t%{http_code}`,
        url,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resume(Effect.succeed(null));
        const i = stdout.lastIndexOf(SENTINEL);
        if (i < 0) return resume(Effect.succeed(null));
        const [finalUrl, code] = stdout
          .slice(i + SENTINEL.length)
          .split("\t");
        const html = stdout.slice(0, i);
        resume(
          Effect.succeed({
            status: Number(code) || 0,
            finalUrl: finalUrl || url,
            html,
            headers: {},
            via: "direct" as const,
          }),
        );
      },
    );
  });

/** Browserbase-rendered HTML when the layer is provided, else "" (no R requirement). */
const fallbackHtml = (url: string): Effect.Effect<string, never, never> =>
  Effect.gen(function* () {
    const bb = yield* Effect.serviceOption(BrowserbaseService);
    if (Option.isNone(bb)) return "";
    return yield* bb.value
      .fetchHtml(url)
      .pipe(Effect.catch(() => Effect.succeed("")));
  });

const browserbasePage = (url: string, html: string): PageFetch => ({
  status: 200,
  finalUrl: url,
  html,
  headers: {},
  via: "browserbase",
});

const isBlocked = (p: PageFetch): boolean =>
  p.status === 403 || p.status === 429 || p.status === 503;
const isUsable = (p: PageFetch): boolean =>
  !isBlocked(p) && p.html.trim().length > 0;
/** A curl response that looks like a Cloudflare interstitial rather than the page. */
const isCfChallenge = (html: string): boolean =>
  /just a moment|checking your browser|cf-chl|enable javascript and cookies/i.test(
    html.slice(0, 4000),
  );

/**
 * Fetch a page, escalating cheapest→costliest (field guide tool ladder):
 * Node fetch → curl (passes Cloudflare) → Browserbase. Returns the first usable
 * response; falls back through the rest on block/empty/throw.
 */
const fetchPage = (
  url: string,
  timeoutMs: number,
): Effect.Effect<PageFetch, MerchFetchError, never> => {
  const viaCurlThenBb = (
    fallbackTo: Effect.Effect<PageFetch, MerchFetchError, never>,
  ) =>
    curlFetch(url, timeoutMs).pipe(
      Effect.flatMap((curl) =>
        curl && isUsable(curl) && !isCfChallenge(curl.html)
          ? Effect.succeed(curl)
          : fallbackHtml(url).pipe(
              Effect.flatMap((html) =>
                html.trim().length > 0
                  ? Effect.succeed(browserbasePage(url, html))
                  : fallbackTo,
              ),
            ),
      ),
    );
  return directFetch(url, timeoutMs).pipe(
    Effect.flatMap((direct) =>
      isUsable(direct) ? Effect.succeed(direct) : viaCurlThenBb(Effect.succeed(direct)),
    ),
    // Direct fetch threw: try curl → Browserbase, or re-raise if neither helps.
    Effect.catch((err) => viaCurlThenBb(Effect.fail(err))),
  );
};

// --- Link detection (pure) ------------------------------------------------

const MERCH_TEXT =
  /\b(shop|store|merch|merchandise|apparel|gear|pro\s?shop|spirit\s?wear)\b/i;
const MERCH_PATH =
  /(^|\/)(shop|store|merch|merchandise|products|collections|apparel|store-?front)(\/|$|\?|#)/i;
const EXCLUDE_TEXT =
  /\b(app\s?store|play\s?store|google\s?play|in[-\s]?store|food|snack)\b/i;
const SOCIAL_HOST =
  /(facebook|instagram|twitter|x\.com|youtube|tiktok|linkedin|threads|paypal|venmo)\./i;
const APP_STORE_HOST =
  /(play\.google\.com|apps\.apple\.com|itunes\.apple\.com|chrome\.google\.com)$/i;

const findMerchLink = (html: string, baseUrl: string): string | null => {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const candidates: { url: string; score: number }[] = [];

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (EXCLUDE_TEXT.test(text)) return;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/i.test(abs.protocol)) return;
    if (SOCIAL_HOST.test(abs.hostname)) return;
    if (APP_STORE_HOST.test(abs.hostname)) return;
    const path = abs.pathname + abs.search;
    const offDomain = abs.hostname.replace(/^www\./i, "") !== base.hostname.replace(/^www\./i, "");
    let score = 0;
    if (MERCH_TEXT.test(text)) score += 5;
    if (MERCH_PATH.test(path)) score += 3;
    if (/^(shop|store|merch)\./i.test(abs.hostname)) score += 4;
    // Off-domain vanity store domains (thephanshop.com, thecrownstore.com,
    // troopstore.org, scoutsproshop.com): the store word is *inside* the host,
    // not a subdomain prefix. classify() + the products probe verify it's real.
    if (offDomain && /(shop|store|merch|gear|proshop|spiritwear)/i.test(abs.hostname))
      score += 4;
    if (/myshopify\.com$/i.test(abs.hostname)) score += 6;
    if (/bigcartel\.com$/i.test(abs.hostname)) score += 4;
    if (score > 0) candidates.push({ url: abs.toString(), score });
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.url;
};

// --- Platform classification (pure) --------------------------------------

const PARKED =
  /(domain (is )?for sale|buy this domain|sedoparking|parkingcrew|this domain is parked|godaddy\.com\/domains|hugedomains)/i;

interface Classification {
  platform: MerchPlatform;
  signals: string[];
  passwordProtected: boolean;
  parked: boolean;
}

const classify = (page: PageFetch, productsJson: boolean): Classification => {
  const html = page.html;
  const signals: string[] = [];
  const parked = PARKED.test(html);

  if (page.via === "direct") {
    for (const h of [
      "x-shopify-stage",
      "x-shopid",
      "x-sorting-hat-shopid",
      "x-shopify-shop-api-call-limit",
    ]) {
      if (page.headers[h] !== undefined) signals.push(`header:${h}`);
    }
    const poweredBy =
      page.headers["powered-by"] ?? page.headers["x-powered-by"] ?? "";
    if (/shopify/i.test(poweredBy)) signals.push("header:powered-by-shopify");
  }

  if (/cdn\.shopify\.com/i.test(html)) signals.push("html:cdn.shopify.com");
  if (/cdn\/shop\//i.test(html)) signals.push("html:cdn/shop");
  if (/myshopify\.com/i.test(html)) signals.push("html:myshopify.com");
  if (
    /Shopify\.theme|window\.Shopify|shopify-features|Shopify\.shop/i.test(html)
  )
    signals.push("html:Shopify-js");
  if (productsJson) signals.push("endpoint:products.json");

  const shopify = signals.length > 0;

  const passwordProtected =
    /\/password(\b|\/|$)/i.test(page.finalUrl) ||
    (shopify &&
      /opening soon|store is password protected|enter store using password/i.test(
        html,
      ));
  if (passwordProtected) signals.push("shopify:password-page");

  if (shopify || passwordProtected) {
    return { platform: "shopify", signals, passwordProtected, parked };
  }

  const other: Array<[MerchPlatform, RegExp, string]> = [
    [
      "woocommerce",
      /woocommerce|wp-content\/plugins\/woocommerce/i,
      "html:woocommerce",
    ],
    [
      "squarespace",
      /static1\.squarespace\.com|squarespace-commerce|Squarespace\.Constants/i,
      "html:squarespace",
    ],
    [
      "bigcommerce",
      /cdn\d*\.bigcommerce\.com|bigcommerce\.com\/s-/i,
      "html:bigcommerce",
    ],
    [
      "wix",
      /wixstatic\.com|static\.parastorage\.com|wix\s?stores|_wixCss/i,
      "html:wix",
    ],
    ["bigcartel", /bigcartel\.com|data-bigcartel/i, "html:bigcartel"],
  ];
  for (const [platform, re, sig] of other) {
    if (re.test(html)) {
      signals.push(sig);
      return { platform, signals, passwordProtected: false, parked };
    }
  }

  if (/add to cart|\/cart\b|checkout|add-to-cart/i.test(html)) {
    signals.push("html:generic-cart");
    return {
      platform: "other-ecommerce",
      signals,
      passwordProtected: false,
      parked,
    };
  }

  return {
    platform: parked ? "unknown" : "none",
    signals,
    passwordProtected: false,
    parked,
  };
};

/** Probe `<origin>/products.json` — Shopify's most reliable cross-theme tell. */
const probeProductsJson = (
  origin: string,
  timeoutMs: number,
): Effect.Effect<boolean, never, never> =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(
          new URL("/products.json?limit=1", origin).toString(),
          {
            headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
            redirect: "follow",
            signal: controller.signal,
          },
        );
        if (!res.ok) return false;
        if (!/json/i.test(res.headers.get("content-type") ?? "")) return false;
        const body = (await res.json()) as { products?: unknown };
        return Array.isArray(body.products);
      } finally {
        clearTimeout(timer);
      }
    },
    // Keep the error channel honest (return the cause, not a domain value); the
    // probe is best-effort, so any failure folds to `false` below.
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(false)));

const resultBase = (target: MerchScanTarget, checkedAt: string) => ({
  name: target.name,
  kind: target.kind,
  corpsKey: target.corpsKey ?? null,
  website: target.website,
  checkedAt,
});

const emptyResult = (
  base: ReturnType<typeof resultBase>,
  error: string,
  platform: MerchPlatform = "unknown",
): MerchScanResult => ({
  ...base,
  merchUrl: null,
  finalUrl: null,
  hasMerch: false,
  platform,
  signals: [],
  passwordProtected: false,
  parked: false,
  fetchVia: "none",
  error,
});

/**
 * Scan a single target for a merch / ecommerce footprint. Never fails its Effect:
 * fetch failures become a result with `error` set. Makes at most homepage + one
 * merch page + two products.json probes.
 */
export const scanTarget = (
  target: MerchScanTarget,
  options: MerchScanOptions = {},
): Effect.Effect<MerchScanResult, never, never> =>
  Effect.suspend(() => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const checkedAt = options.checkedAt ?? new Date().toISOString();
    const base = resultBase(target, checkedAt);

    const homeUrl = normalizeUrl(target.website);
    if (!homeUrl)
      return Effect.succeed(emptyResult(base, "no/invalid website on file"));

    const core = Effect.gen(function* () {
      const home = yield* fetchPage(homeUrl, timeoutMs);
      const merchLink = findMerchLink(home.html, home.finalUrl);

      // Fetch the merch page and prefer its *resolved* URL — a corps `/shop` that
      // 301s to an off-domain storefront (carolinacrown.org/shop → thecrownstore.com)
      // must be ingested at the destination, not the redirect link.
      let page = home;
      let merchUrl = merchLink;
      if (merchLink && merchLink !== home.finalUrl) {
        const fetched = yield* fetchPage(merchLink, timeoutMs).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (fetched) {
          page = fetched;
          merchUrl = fetched.finalUrl;
        }
      }

      const origins = new Set<string>();
      for (const u of [page.finalUrl, home.finalUrl]) {
        try {
          origins.add(new URL(u).origin);
        } catch {
          /* ignore */
        }
      }
      let productsJson = false;
      for (const origin of origins) {
        if (yield* probeProductsJson(origin, timeoutMs)) {
          productsJson = true;
          break;
        }
      }

      const { platform, signals, passwordProtected, parked } = classify(
        page,
        productsJson,
      );
      const hasMerch = merchUrl !== null || platform !== "none";
      return {
        ...base,
        merchUrl,
        finalUrl: page.finalUrl,
        hasMerch: parked ? false : hasMerch,
        platform,
        signals,
        passwordProtected,
        parked,
        fetchVia: page.via,
        error: null,
      } satisfies MerchScanResult;
    });

    return core.pipe(
      Effect.catch((err) =>
        Effect.succeed(
          emptyResult(base, `homepage fetch failed: ${err.message}`),
        ),
      ),
    );
  });

/** Scan many targets with bounded concurrency; onResult fires per completion. */
export const scanTargets = (
  targets: ReadonlyArray<MerchScanTarget>,
  options: MerchScanOptions & {
    concurrency?: number;
    onResult?: (r: MerchScanResult) => void;
  } = {},
): Effect.Effect<MerchScanResult[], never, never> =>
  Effect.suspend(() => {
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
    const checkedAt = options.checkedAt ?? new Date().toISOString();
    return Effect.forEach(
      targets,
      (t) =>
        scanTarget(t, { ...options, checkedAt }).pipe(
          Effect.tap((r) =>
            options.onResult
              ? Effect.sync(() => options.onResult!(r))
              : Effect.void,
          ),
        ),
      { concurrency },
    );
  });

/** Default drum-corps vendor seeds (non-corps). Extend freely. */
export const VENDOR_SEEDS: ReadonlyArray<MerchScanTarget> = [
  {
    name: "Drum Corps International (DCI)",
    kind: "vendor",
    website: "https://www.dci.org/",
  },
  { name: "DCI Shop", kind: "vendor", website: "https://shop.dci.org/" },
  {
    name: "General Effect Media",
    kind: "vendor",
    website: "https://www.generaleffectmedia.com/",
  },
  {
    name: "Funliner Productions",
    kind: "vendor",
    website: "https://funlinerproductions.com/",
  },
  { name: "Lot Riot", kind: "vendor", website: "https://lotriot.com/" },
];
