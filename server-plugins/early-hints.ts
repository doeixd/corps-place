// Nitro plugin: emit `Link: rel=preload` headers for the render-blocking CSS
// and the primary webfont on HTML responses.
//
// Why: the SSR HTML's <head> starts with a ~100KB inline loader-data script, so
// the browser doesn't DISCOVER the stylesheet link until most of the document
// has downloaded — measured: CSS request starts ~350ms in and then competes
// with 40 modulepreloaded JS chunks for a throttled link (23KB of CSS taking
// 1.25s on slow 4G; FCP/LCP are text waiting on exactly that CSS). A Link
// header is parsed before any HTML, so the CSS fetch starts immediately — and
// with Cloudflare's Early Hints enabled (dashboard: Speed → Optimization) the
// edge replays it as a 103 during origin/cache think-time.
//
// Asset hashes change per build, so the filenames are resolved once at startup
// by scanning the built public dir (same dirs the OG route probes).
import * as fs from 'node:fs';
import * as path from 'node:path';

type NitroAppLike = {
  hooks: { hook: (name: string, fn: (...args: any[]) => void) => void };
};

const findAssets = (): string | null => {
  for (const base of ['.output/public/assets/r1', 'public/assets/r1']) {
    const dir = path.resolve(process.cwd(), base);
    try {
      const files = fs.readdirSync(dir);
      const css = files.find((f) => /^main-[\w-]+\.css$/.test(f));
      const font = files.find((f) => /^instrument-sans-latin-wght-normal-[\w-]+\.woff2$/.test(f));
      const parts: string[] = [];
      if (css) parts.push(`</assets/r1/${css}>; rel=preload; as=style`);
      if (font)
        parts.push(`</assets/r1/${font}>; rel=preload; as=font; type=font/woff2; crossorigin`);
      if (parts.length) return parts.join(', ');
    } catch {
      /* try next */
    }
  }
  return null;
};

let linkHeader: string | null | undefined;

// HTML navigations only: no file extension, not an API/data path.
const isHtmlPath = (p: string | undefined): boolean =>
  Boolean(
    p &&
    !p.includes('.') &&
    !p.startsWith('/api/') &&
    !p.startsWith('/_serverFn/') &&
    !p.startsWith('/read-model/')
  );

export default ((nitroApp: NitroAppLike) => {
  nitroApp.hooks.hook('request', (event: any) => {
    if (!isHtmlPath(event?.path)) return;
    const res = event?.node?.res;
    if (!res || typeof res.setHeader !== 'function') return;
    if (linkHeader === undefined) linkHeader = findAssets();
    if (linkHeader) res.setHeader('link', linkHeader);
  });
}) as unknown as (app: unknown) => void;
