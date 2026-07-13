import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServerFn } from '@tanstack/react-start';
import { getWebRequest } from '@tanstack/react-start/server';
import { requireCapability } from '@/lib/authz';

// List/delete for the /admin/uploads file drop (upload itself is the multipart
// route at /api/admin/upload — server-fns can't stream files).

const uploadsDir = (): string => {
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    return '/data/uploads';
  } catch {
    return path.resolve(process.cwd(), 'data-uploads');
  }
};

export type UploadEntry = { name: string; bytes: number; mtime: string };

export const listAdminUploads = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{ dir: string; files: UploadEntry[] }> => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const dir = uploadsDir();
    let files: UploadEntry[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .map((name) => {
          const st = fs.statSync(path.join(dir, name));
          return { name, bytes: st.size, mtime: st.mtime.toISOString() };
        })
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    } catch {
      /* dir not created yet */
    }
    return { dir, files };
  }
);

export const deleteAdminUpload = createServerFn({ method: 'POST' })
  .validator((name: string) => name)
  .handler(async ({ data }) => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const name = path.basename(data); // no traversal
    fs.unlinkSync(path.join(uploadsDir(), name));
    return { ok: true };
  });
