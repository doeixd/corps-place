import { Context, Effect, Layer } from 'effect';
import Browserbase from '@browserbasehq/sdk';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { DciNetworkError } from './errors.js';

/**
 * Renders web pages (bypassing Cloudflare and hydrating SPAs) so the merch
 * scan/ingest can read JS-injected JSON-LD. Two backends, cheapest first:
 *   1. **Local headless Chromium** (puppeteer-core + /usr/bin/chromium) — free,
 *      unlimited, parallel. The PRIMARY path.
 *   2. **Browserbase cloud session** — FALLBACK only (the free plan caps
 *      concurrency at 3 and burns limited minutes, so we avoid it when local
 *      Chromium is available).
 * Kept the name `BrowserbaseService` so callers/layers are unchanged.
 */
export interface BrowserbaseService {
  readonly fetchHtml: (url: string) => Effect.Effect<string, DciNetworkError, never>;
  readonly fetchJson: (url: string) => Effect.Effect<string, DciNetworkError, never>;
}

export const BrowserbaseService = Context.Service<BrowserbaseService>('BrowserbaseService');

const NAV_TIMEOUT_MS = 30000;
/** Cap Browserbase session PROVISIONING (projects.list / sessions.create /
 *  puppeteer.connect). page.goto has NAV_TIMEOUT_MS, but session setup had no
 *  timeout — a stuck session provisioning hung the whole scrape indefinitely
 *  (observed: a 15-min sleeping-at-0%-CPU scrape that froze score ingestion). */
const SESSION_TIMEOUT_MS = 30000;
/** Reject if `p` doesn't settle within `ms`, so a hung remote call can't stall a
 *  batch. The loser's timer is unref'd so it never keeps the process alive. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}
/** Recycle the shared local Chromium after this many renders to reap leaked
 *  renderer/helper processes (prevents OOM on small-RAM hosts over a long batch). */
const RENDER_RECYCLE_EVERY = 12;

// Process-exit reaping handlers are registered once per process (the service
// layer may be built more than once); guard so we don't stack duplicates.
let localReapRegistered = false;

/**
 * After domcontentloaded, wait briefly for product JSON-LD to be injected (SPAs
 * hydrate it post-load). Capped so we never block on the analytics/recaptcha/
 * Sentry connections that keep these pages from ever reaching network-idle —
 * the bug that made `networkidle2` wait the full nav timeout on every page.
 */
const settleForContent = async (page: Page): Promise<void> => {
  await page
    .waitForSelector('script[type="application/ld+json"]', { timeout: 8000 })
    .catch(() => {});
};

/** First existing local Chromium/Chrome binary, or null. */
const findLocalChrome = (): string | null => {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter((p): p is string => Boolean(p));
  return candidates.find((p) => existsSync(p)) ?? null;
};

/** Resolve a CDP base (e.g. http://localhost:9222) to its browser-level
 *  webSocketDebuggerUrl, so puppeteer can connect to an already-running Chrome. */
const resolveCdpWsEndpoint = async (base: string): Promise<string> => {
  const root = base.replace(/\/+$/, '');
  const res = await fetch(`${root}/json/version`, {
    signal: AbortSignal.timeout(8000),
  });
  const info = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl)
    throw new Error(`no webSocketDebuggerUrl at ${root}/json/version`);
  return info.webSocketDebuggerUrl;
};

export const BrowserbaseServiceLive = Layer.effect(
  BrowserbaseService,
  Effect.gen(function* () {
    const chromePath = findLocalChrome();
    const apiKey = process.env.BROWSERBASE_API_KEY;
    // A remote DevTools endpoint (e.g. the home Chrome reached over the Tailscale
    // reverse tunnel at http://localhost:9222). When set, rendering runs on THAT
    // machine — keeping heavy Chromium off a memory-tight box — and uses a real
    // desktop-Chrome fingerprint, which also clears bot walls that block our plain
    // fetch. Tried FIRST, ahead of local Chromium. See docs: tailnet bridge.
    const remoteCdpUrl = process.env.CHROME_CDP_URL || null;

    // --- Remote Chrome over CDP (preferred when configured). ---
    let remoteBrowser: Promise<Browser> | null = null;
    // Once the tunnel/home Chrome proves unreachable (connect throws — typically an
    // 8s CDP timeout), stop retrying it for the rest of THIS process so a batch
    // (e.g. a 48-page scrape) doesn't eat 8s per page falling through. It flips back
    // on only in a fresh process, so an intermittently-on home machine still gets
    // used on the next run.
    let remoteDead = false;
    const getRemote = (): Promise<Browser> => {
      if (!remoteBrowser) {
        remoteBrowser = resolveCdpWsEndpoint(remoteCdpUrl!)
          .then((browserWSEndpoint) =>
            withTimeout(
              puppeteer.connect({ browserWSEndpoint }),
              SESSION_TIMEOUT_MS,
              'remote CDP puppeteer.connect'
            )
          )
          .then((br) => {
            // If the tunnel/Chrome drops, clear the cache so the next call retries.
            br.on('disconnected', () => {
              remoteBrowser = null;
            });
            return br;
          })
          .catch((e) => {
            remoteBrowser = null;
            throw e;
          });
      }
      return remoteBrowser;
    };
    const renderRemote = async (url: string): Promise<string> => {
      const browser = await getRemote();
      // A fresh tab in the user's real Chrome; close the TAB only, never the browser.
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await settleForContent(page);
        return await page.content();
      } finally {
        await page.close().catch(() => {});
      }
    };

    // --- Local Chromium (primary) — one shared browser, a page per fetch. ---
    let localBrowser: Promise<Browser> | null = null;
    let renderCount = 0;
    let pagesInFlight = 0; // recycle only when idle, so we never close mid-render
    const getLocal = (): Promise<Browser> => {
      if (!localBrowser) {
        localBrowser = puppeteer
          .launch({
            executablePath: chromePath!,
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
            ],
          })
          .catch((e) => {
            localBrowser = null; // let a later call retry / fall through
            throw e;
          });
      }
      return localBrowser;
    };
    const closeLocal = async (): Promise<void> => {
      const b = localBrowser;
      localBrowser = null;
      if (b) await b.then((br) => br.close()).catch(() => {});
    };
    // Reap the shared local Chromium on process exit so a finished OR interrupted
    // run never orphans the renderer tree (small-RAM box OOM guard). puppeteer's
    // own signal handling kills the launched process; this also covers normal
    // completion (`beforeExit`) and re-asserts the close on signals.
    if (!localReapRegistered) {
      localReapRegistered = true;
      const reap = () => {
        void closeLocal();
      };
      process.once('beforeExit', reap);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, reap);
    }
    const renderLocal = async (url: string): Promise<string> => {
      // Chromium leaks renderer/helper processes that `page.close()` doesn't reap; on a
      // small-RAM box a long batch accumulates them until OOM. Recycle the whole browser
      // every N renders so the OS reaps the tree, then relaunch fresh — but only when no
      // pages are in flight, so a concurrent batch never closes a browser mid-render.
      if (
        renderCount > 0 &&
        renderCount % RENDER_RECYCLE_EVERY === 0 &&
        pagesInFlight === 0
      )
        await closeLocal();
      renderCount++;
      const browser = await getLocal();
      pagesInFlight++;
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await settleForContent(page);
        return await page.content();
      } finally {
        await page.close().catch(() => {});
        pagesInFlight--;
      }
    };

    // --- Camofox stealth-Firefox REST service (fallback before Browserbase). ---
    // A local camofox-browser server (tools/camofox, kept alive by
    // scripts/camofox-keepalive.sh) wrapping Camoufox — a Firefox fork with
    // engine-level fingerprint spoofing that clears Cloudflare walls headless
    // Chromium can't. One probe per process; a dead service is skipped in ~1.5s.
    const camofoxUrl = process.env.CAMOFOX_URL || 'http://localhost:9377';
    let camofoxDead: boolean | null = null; // null = not probed yet
    const camofoxAlive = async (): Promise<boolean> => {
      if (camofoxDead !== null) return !camofoxDead;
      try {
        const res = await fetch(`${camofoxUrl}/health`, { signal: AbortSignal.timeout(1500) });
        camofoxDead = !res.ok;
      } catch {
        camofoxDead = true;
      }
      return !camofoxDead;
    };
    const renderCamofox = async (url: string): Promise<string> => {
      const tabRes = await fetch(`${camofoxUrl}/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'scraper', sessionKey: 'scraper', url }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!tabRes.ok) throw new Error(`camofox tab create failed: ${tabRes.status}`);
      const { tabId } = (await tabRes.json()) as { tabId?: string };
      if (!tabId) throw new Error('camofox returned no tabId');
      try {
        const ev = await fetch(`${camofoxUrl}/tabs/${tabId}/evaluate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: 'scraper',
            expression: 'document.documentElement.outerHTML',
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const data = (await ev.json()) as { ok?: boolean; result?: unknown };
        if (!data.ok || typeof data.result !== 'string' || data.result.length === 0)
          throw new Error('camofox evaluate returned no HTML');
        return data.result;
      } finally {
        void fetch(`${camofoxUrl}/tabs/${tabId}?userId=scraper`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
      }
    };

    // --- Browserbase cloud session (fallback) — connect puppeteer over CDP. ---
    const bb = apiKey ? new Browserbase({ apiKey }) : null;
    let projectId: string | null = process.env.BROWSERBASE_PROJECT_ID ?? null;
    const renderViaSession = async (url: string): Promise<string> => {
      if (!bb) throw new Error('Browserbase API key not set');
      if (!projectId) {
        const projects = await withTimeout(bb.projects.list(), SESSION_TIMEOUT_MS, 'bb.projects.list');
        projectId = projects?.[0]?.id ?? null;
        if (!projectId) throw new Error('no Browserbase projects available');
      }
      const session = await withTimeout(
        bb.sessions.create({ projectId }),
        SESSION_TIMEOUT_MS,
        'bb.sessions.create'
      );
      const browser = await withTimeout(
        puppeteer.connect({ browserWSEndpoint: session.connectUrl }),
        SESSION_TIMEOUT_MS,
        'browserbase puppeteer.connect'
      );
      try {
        const page = (await browser.pages())[0] ?? (await browser.newPage());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await settleForContent(page);
        return await page.content();
      } finally {
        await browser.close().catch(() => {});
      }
    };

    yield* remoteCdpUrl
      ? Effect.logInfo(`[render] remote Chrome → ${remoteCdpUrl}${chromePath ? ' (local fallback)' : ''}`)
      : chromePath
        ? Effect.logInfo(`[render] local Chromium → ${chromePath}${bb ? ' (Browserbase fallback ready)' : ''}`)
        : bb
          ? Effect.logInfo('[render] no local Chromium; using Browserbase cloud')
          : Effect.logWarning('[render] no local Chromium and no Browserbase key — rendering disabled');

    const fetchHtml = (url: string): Effect.Effect<string, DciNetworkError, never> =>
      Effect.gen(function* () {
        // 0) Remote Chrome over the tunnel (keeps Chromium off this box). Skipped
        //    fast once the tunnel is known dead this run. A render ERROR (home
        //    machine offline / tunnel down) disables remote for the rest of the
        //    process; a successful-but-empty render does NOT (that's a page issue,
        //    not a transport one) so we just fall through for this one URL.
        if (remoteCdpUrl && !remoteDead) {
          const remote = yield* Effect.tryPromise(() => renderRemote(url)).pipe(
            Effect.result,
          );
          if (remote._tag === 'Success' && remote.success.trim().length > 0) {
            yield* Effect.logInfo(`[render] remote ${url} — ${remote.success.length} chars`);
            return remote.success;
          }
          if (remote._tag === 'Failure') {
            remoteDead = true;
            yield* Effect.logInfo(
              `[render] remote Chrome unreachable — disabling it for this run, falling back to local/Browserbase`,
            );
          }
        }
        // 1) Local Chromium (free). On failure, fall through to the cloud.
        if (chromePath) {
          const local = yield* Effect.tryPromise({
            try: () => renderLocal(url),
            catch: (cause) =>
              new DciNetworkError({
                message: `local render failed for ${url}: ${String(cause)}`,
                statusCode: 0,
                cause,
              }),
          }).pipe(Effect.catch(() => Effect.succeed('')));
          if (local.trim().length > 0) {
            yield* Effect.logInfo(`[render] local ${url} — ${local.length} chars`);
            return local;
          }
        }
        // 2) Camofox stealth Firefox — engine-level anti-detect; the rung that
        //    clears Cloudflare walls the plain fetch AND headless Chromium hit.
        if (yield* Effect.tryPromise(() => camofoxAlive()).pipe(
          Effect.catch(() => Effect.succeed(false))
        )) {
          const camo = yield* Effect.tryPromise(() => renderCamofox(url)).pipe(
            Effect.catch(() => Effect.succeed(''))
          );
          if (camo.trim().length > 0) {
            yield* Effect.logInfo(`[render] camofox ${url} — ${camo.length} chars`);
            return camo;
          }
          yield* Effect.logInfo(`[render] camofox failed for ${url}; falling through`);
        }
        // 3) Browserbase cloud session fallback.
        if (bb) {
          yield* Effect.logInfo(`[render] Browserbase ${url}`);
          return yield* Effect.tryPromise({
            try: () => renderViaSession(url),
            catch: (cause) =>
              new DciNetworkError({
                message: `Browserbase render failed for ${url}: ${String(cause)}`,
                statusCode: 0,
                cause,
              }),
          });
        }
        return yield* Effect.fail(
          new DciNetworkError({ message: `no renderer available for ${url}`, statusCode: 0 }),
        );
      });

    return { fetchHtml, fetchJson: fetchHtml };
  }),
);
