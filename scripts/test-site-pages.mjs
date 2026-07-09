#!/usr/bin/env node
// Smoke-test the key pages of a deployment (default: dev.drumcorps.app) with a
// real headless Chromium under mobile emulation. For each page it checks:
//   • HTTP status of the document
//   • the page actually RENDERS (h1 / expected content selector, not a blank
//     hydration-crashed shell)
//   • no uncaught page errors / React hydration errors in the console
//   • no failed (>=400) same-origin subresource requests
//   • time to DOMContentLoaded + to the content selector, as a perf regression
//     canary
//
// Usage:
//   node scripts/test-site-pages.mjs                       # dev.drumcorps.app
//   node scripts/test-site-pages.mjs https://drumcorps.app # prod
//   node scripts/test-site-pages.mjs <base> --fast         # no CPU/net throttle
//
// Exit code: number of failing pages (0 = all good). Designed to be run on the
// box (uses the system chromium + the repo's puppeteer-core).

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = await import(
  require.resolve('puppeteer-core', { paths: ['/root/corps-place/node_modules'] })
).then((m) => m.default ?? m);

const BASE = (process.argv[2] && process.argv[2].startsWith('http') && process.argv[2]) ||
  'https://dev.drumcorps.app';
const FAST = process.argv.includes('--fast');

const CHROME = ['/usr/lib/chromium/chromium', '/usr/bin/chromium'].find((b) => {
  try {
    fs.accessSync(b, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
if (!CHROME) {
  console.error('No chromium binary found');
  process.exit(1);
}

// path → selector that proves the page rendered real content (not a shell).
// waitMs gives lazy content (recap tables) a bounded chance to appear.
const PAGES = [
  { path: '/', sel: 'h1, [class*=hero]', label: 'home' },
  { path: '/events', sel: '[data-grid-key], a[href*="/events/"]', label: 'events directory' },
  { path: '/scores', sel: 'table', label: 'scores (first recap TABLE — SSR-inlined)', waitMs: 12000 },
  { path: '/corps', sel: '[data-grid-key]', label: 'corps directory' },
  { path: '/corps/bluecoats', sel: 'h1', label: 'corps detail' },
  { path: '/judges', sel: '[data-grid-key], a[href*="/judges/"]', label: 'judges directory' },
  { path: '/judges/m-turner-1', sel: 'h1', label: 'judge detail (slimmed loader)' },
  // Rankings renders an SVG bump chart + a list (no <table>); the chart SVG is
  // the reliable "real content" signal.
  { path: '/rankings', sel: 'svg path, a[href*="/corps/"]', label: 'rankings', waitMs: 12000 },
  { path: '/vs', sel: 'h1', label: 'vs' },
  { path: '/shop', sel: 'a[href*="/shop/"]', label: 'shop' },
  {
    path: '/events/2026/2026-dci-world-championship-finals/prediction',
    sel: 'table, [class*=prediction]',
    label: 'event prediction',
  },
  { path: '/scores/2026-dci-west', sel: 'table', label: 'score recap detail', waitMs: 12000 },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

let failures = 0;
for (const p of PAGES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  if (!FAST) {
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: 1.6e6 / 8,
      uploadThroughput: 750e3 / 8,
      latency: 150,
    });
    await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }

  const problems = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 120)));
  page.on('console', (m) => {
    const t = m.text();
    // React hydration/render crashes surface as minified error codes.
    if (/Minified React error #(418|423|425|310|300)/.test(t)) pageErrors.push(t.slice(0, 120));
  });
  const badRequests = [];
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && u.startsWith(BASE)) badRequests.push(`${r.status()} ${u.slice(BASE.length, BASE.length + 70)}`);
  });

  const t0 = Date.now();
  let status = 0;
  try {
    const resp = await page.goto(BASE + p.path, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = resp?.status() ?? 0;
  } catch (e) {
    problems.push(`goto failed: ${String(e.message).slice(0, 80)}`);
  }
  const dcl = Date.now() - t0;
  if (status !== 200) problems.push(`HTTP ${status}`);

  let contentMs = null;
  try {
    await page.waitForSelector(p.sel, { timeout: p.waitMs ?? 8000 });
    contentMs = Date.now() - t0;
  } catch {
    problems.push(`content selector "${p.sel}" never appeared`);
  }
  // settle briefly to catch late hydration errors / failed lazy requests
  await new Promise((r) => setTimeout(r, 1500));
  if (pageErrors.length) problems.push(`page errors: ${pageErrors[0]}${pageErrors.length > 1 ? ` (+${pageErrors.length - 1})` : ''}`);
  // Ignore singleton 4xx noise (auth probes etc.) but flag repeats or 5xx.
  const serious = badRequests.filter((b) => b.startsWith('5') || badRequests.length > 2);
  if (serious.length) problems.push(`failed requests: ${serious.slice(0, 3).join(' | ')}`);

  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${p.label.padEnd(42)} ${p.path.padEnd(55)} dcl=${dcl}ms content=${contentMs ?? '—'}ms${ok ? '' : '\n    ' + problems.join('\n    ')}`
  );
  await page.close();
}
await browser.close();
console.log(failures === 0 ? `\nAll ${PAGES.length} pages OK on ${BASE}` : `\n${failures} page(s) FAILED on ${BASE}`);
process.exit(failures);
