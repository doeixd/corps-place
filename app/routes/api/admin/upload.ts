import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServerFileRoute } from '@tanstack/react-start/server';
import { requireCapability } from '@/lib/authz';

// Admin file drop (see /admin/uploads). Multipart POST → files land in
// UPLOADS_DIR on the /data volume (host: /data/corps-place/uploads), so they
// survive redeploys and are directly readable on the box. viewAdmin-gated;
// filenames are sanitized and timestamp-prefixed to avoid collisions/traversal.

const MAX_BYTES = 200 * 1024 * 1024; // per request

const uploadsDir = (): string => {
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return '/data/uploads';
  } catch {
    return path.resolve(process.cwd(), 'data-uploads');
  }
};

const safeName = (name: string): string => {
  const base = path
    .basename(name)
    .replace(/[^\w.\- ]+/g, '_')
    .slice(0, 120);
  return base || 'file';
};

export const ServerRoute = createServerFileRoute('/api/admin/upload').methods({
  POST: async ({ request }) => {
    try {
      await requireCapability(request, 'viewAdmin');
    } catch {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    const len = Number(request.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) {
      return new Response(JSON.stringify({ error: 'too large (200MB max)' }), {
        status: 413,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    const form = await request.formData();
    const dir = uploadsDir();
    fs.mkdirSync(dir, { recursive: true });
    const saved: { name: string; bytes: number }[] = [];
    for (const [, value] of form.entries()) {
      if (!(value instanceof File)) continue;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = `${stamp}_${safeName(value.name)}`;
      const buf = Buffer.from(await value.arrayBuffer());
      fs.writeFileSync(path.join(dir, name), buf);
      saved.push({ name, bytes: buf.length });
    }
    return new Response(JSON.stringify({ saved, dir }), {
      status: saved.length ? 200 : 400,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  },
});
