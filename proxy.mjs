// Zero-downtime reverse proxy (h3).
//
// Sits on a fixed public port (PROXY_PORT, default 3000) that the Cloudflare
// tunnel points at permanently. It forwards every request to whichever backend
// is named in the `.proxy-target` file. Deploys warm a new backend on a spare
// port, then atomically rewrite `.proxy-target`; this process picks the change
// up in-process (no restart), so the tunnel connection is never interrupted —
// the few-seconds reconnect gap of a tunnel restart disappears.
//
// Fate's live channel is Server-Sent Events (plain HTTP streaming), which
// `proxyRequest` forwards fine; there are no WebSocket upgrades to handle.
import { createServer } from 'node:http';
import { readFileSync, watchFile } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { createApp, toNodeListener, defineEventHandler, proxyRequest, setResponseHeader } from 'h3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PROXY_PORT ?? 3000);
const TARGET_FILE = path.resolve(__dirname, '.proxy-target');
const FALLBACK = `http://localhost:${process.env.PROXY_FALLBACK_PORT ?? 3001}`;

const readTarget = () => {
  try {
    const t = readFileSync(TARGET_FILE, 'utf8').trim();
    return t || FALLBACK;
  } catch {
    return FALLBACK;
  }
};

let target = readTarget();
console.log(`[proxy] listening on ${PORT} -> ${target}`);

// Poll the target file; swap the in-memory upstream when it changes. In-flight
// requests to the old backend finish on the old connection; new requests use
// the new target. The deployer leaves the old backend up briefly after the flip
// so nothing is dropped.
watchFile(TARGET_FILE, { interval: 300 }, () => {
  const next = readTarget();
  if (next && next !== target) {
    target = next;
    console.log(`[proxy] target -> ${target}`);
  }
});

// ── Cache-Control policy (origin-side; the CDN/edge obeys these) ──────────────
// The site is precomputed: page data comes from the read-model and only changes
// when it's re-emitted. So SSR HTML is *effectively static between emits* — we
// cache it at the edge with a short s-maxage + a long stale-while-revalidate so a
// new emit is picked up within minutes with no purge, while the origin (this VM)
// is hit at most once per page per window. Hashed assets + the content-addressed
// image proxy are immutable; live/RPC endpoints are never cached.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const HTML = 'public, s-maxage=300, stale-while-revalidate=86400';
// Read-model manifest/meta: the only revalidated entry point. Short max-age so a
// nightly emit is picked up within a minute; long SWR so the origin is rarely hit.
const REVALIDATE = 'public, max-age=60, stale-while-revalidate=86400';
const NO_STORE = 'no-store';
const ASSET_RE = /\.(?:js|mjs|css|woff2?|ttf|otf|svg|png|jpe?g|webp|gif|ico|map)$/;

// `query` is the parsed URLSearchParams for the request (used to detect the
// immutable `?v=` versioned read-model shards).
const cacheControlForPath = (p, query) => {
  if (p.startsWith('/api/fate')) return NO_STORE; // Fate live (SSE) + RPC reads
  if (p.startsWith('/api/media')) return IMMUTABLE; // content-addressed by ?u=&w=
  if (p.startsWith('/api/') || p.startsWith('/_server')) return NO_STORE; // server fns/RPC
  if (p.startsWith('/read-model/')) {
    // manifest.json/meta.json are the entry points (revalidated). Versioned shards
    // (events.json?v=, corps/<slug>.json?v=, …) are immutable — a new emit = a new
    // URL. A bare read-model URL with no ?v= is treated as revalidated (safe).
    if (p.endsWith('/manifest.json') || p.endsWith('/meta.json')) return REVALIDATE;
    return query.has('v') ? IMMUTABLE : REVALIDATE;
  }
  if (p.startsWith('/assets/') || p.startsWith('/_build/') || ASSET_RE.test(p)) return IMMUTABLE;
  return HTML; // SSR HTML
};

const applyCacheControl = (event, response) => {
  const method = event.method ?? 'GET';
  const [pathname, qs] = event.path.split('?');
  // Never cache mutations or error responses (don't pin a 5xx during an emit).
  const cc =
    method !== 'GET' && method !== 'HEAD'
      ? NO_STORE
      : response.status >= 400
        ? NO_STORE
        : cacheControlForPath(pathname, new URLSearchParams(qs));
  setResponseHeader(event, 'cache-control', cc);
};

const app = createApp();
app.use(
  defineEventHandler((event) => {
    // Lightweight health/introspection endpoint for the deploy script.
    if (event.path === '/__proxy_health') {
      return { ok: true, target, port: PORT };
    }
    return proxyRequest(event, `${target}${event.path}`, { onResponse: applyCacheControl });
  })
);

createServer(toNodeListener(app)).listen(PORT);
