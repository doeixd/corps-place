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
/** Recycle the shared local Chromium after this many renders to reap leaked
 *  renderer/helper processes (prevents OOM on small-RAM hosts over a long batch). */
const RENDER_RECYCLE_EVERY = 20;

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

export const BrowserbaseServiceLive = Layer.effect(
  BrowserbaseService,
  Effect.gen(function* () {
    const chromePath = findLocalChrome();
    const apiKey = process.env.BROWSERBASE_API_KEY;

    // --- Local Chromium (primary) — one shared browser, a page per fetch. ---
    let localBrowser: Promise<Browser> | null = null;
    let renderCount = 0;
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
    const renderLocal = async (url: string): Promise<string> => {
      // Chromium leaks renderer/helper processes that `page.close()` doesn't reap; on a
      // small-RAM box a long batch accumulates them until OOM. Recycle the whole browser
      // every N renders so the OS reaps the tree, then relaunch fresh.
      if (renderCount > 0 && renderCount % RENDER_RECYCLE_EVERY === 0) await closeLocal();
      renderCount++;
      const browser = await getLocal();
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await settleForContent(page);
        return await page.content();
      } finally {
        await page.close().catch(() => {});
      }
    };

    // --- Browserbase cloud session (fallback) — connect puppeteer over CDP. ---
    const bb = apiKey ? new Browserbase({ apiKey }) : null;
    let projectId: string | null = process.env.BROWSERBASE_PROJECT_ID ?? null;
    const renderViaSession = async (url: string): Promise<string> => {
      if (!bb) throw new Error('Browserbase API key not set');
      if (!projectId) {
        const projects = await bb.projects.list();
        projectId = projects?.[0]?.id ?? null;
        if (!projectId) throw new Error('no Browserbase projects available');
      }
      const session = await bb.sessions.create({ projectId });
      const browser = await puppeteer.connect({ browserWSEndpoint: session.connectUrl });
      try {
        const page = (await browser.pages())[0] ?? (await browser.newPage());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await settleForContent(page);
        return await page.content();
      } finally {
        await browser.close().catch(() => {});
      }
    };

    yield* chromePath
      ? Effect.logInfo(`[render] local Chromium → ${chromePath}${bb ? ' (Browserbase fallback ready)' : ''}`)
      : bb
        ? Effect.logInfo('[render] no local Chromium; using Browserbase cloud')
        : Effect.logWarning('[render] no local Chromium and no Browserbase key — rendering disabled');

    const fetchHtml = (url: string): Effect.Effect<string, DciNetworkError, never> =>
      Effect.gen(function* () {
        // 1) Local Chromium first (free). On failure, fall through to the cloud.
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
        // 2) Browserbase cloud session fallback.
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
