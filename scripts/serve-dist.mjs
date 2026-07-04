import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.cwd();
const srv = await import(path.join(root, 'dist/server/server.js'));
const handler = srv.default.fetch;
const MIME = { '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.json':'application/json' };
createServer(async (req, res) => {
  try {
    const clean = decodeURIComponent(req.url.split('?')[0]);
    const p = path.join(root, 'dist/client', clean);
    if (clean !== '/' && p.startsWith(path.join(root, 'dist/client'))) {
      try {
        const st = await stat(p);
        if (st.isFile()) {
          const headers = { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' };
          if (clean.startsWith('/assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
          if (clean === '/sw.js') headers['cache-control'] = 'no-cache';
          res.writeHead(200, headers);
          res.end(await readFile(p));
          return;
        }
      } catch {}
      // 2026-07-02 Cloudflare incident guard: a missing hashed asset (rollout
      // window, stale HTML) must be an uncacheable 404 — NEVER a cacheable
      // response the edge can pin for a year.
      if (clean.startsWith('/assets/')) {
        res.writeHead(404, { 'cache-control': 'no-store' });
        res.end('Not found');
        return;
      }
    }
    const request = new Request('http://localhost:' + (process.env.PORT||3187) + req.url, {
      method: req.method, headers: req.headers,
      body: ['GET','HEAD'].includes(req.method) ? undefined : req, duplex: 'half',
    });
    const r = await handler(request);
    const headers = Object.fromEntries(r.headers);
    if (r.status >= 400) headers['cache-control'] = 'no-store';
    // Documents must never be reused from browser/edge caches: a cached HTML
    // shell references hashed assets that die on the next deploy — the page
    // then loads with no JS at all ('site is dead' reports). Same for /sw.js:
    // a stale service worker must be replaceable immediately.
    const ct = headers['content-type'] ?? '';
    if (!headers['cache-control'] && (ct.includes('text/html') || clean === '/sw.js')) {
      headers['cache-control'] = 'no-cache';
    }
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(process.env.PORT||3187, () => console.log('listening', process.env.PORT||3187));
