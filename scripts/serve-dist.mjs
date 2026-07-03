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
          res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
          res.end(await readFile(p));
          return;
        }
      } catch {}
    }
    const request = new Request('http://localhost:' + (process.env.PORT||3187) + req.url, {
      method: req.method, headers: req.headers,
      body: ['GET','HEAD'].includes(req.method) ? undefined : req, duplex: 'half',
    });
    const r = await handler(request);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(process.env.PORT||3187, () => console.log('listening', process.env.PORT||3187));
