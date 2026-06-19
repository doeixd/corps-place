import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import { createRequire } from 'node:module';
import { getContributionsDb } from '@/lib/contributions-db';
import { ensureShowPage } from '@/lib/contrib/store';
import { requireCapability, type PageLock } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/contrib/rate-limit';
import { putUpload, uploadKey } from '@/lib/r2';

/**
 * Media upload (M5). Auth-gated ('upload', §6.2). Re-encodes to WebP with sharp —
 * which bakes EXIF orientation via .rotate() and DROPS all metadata (EXIF/GPS, L-1)
 * — then PutObjects to R2 under uploads/ and records the row in show_media. Served
 * back through /api/show-media/$id. Returns a ref the editor stores in a block.
 */

// Runtime-require sharp (same untraced-specifier trick as media-cache.ts).
const nodeRequire = createRequire(import.meta.url);
let _sharp: typeof import('sharp') | null = null;
const getSharp = () =>
  (_sharp ??= nodeRequire(process.env.SHARP_MODULE ?? 'sharp') as typeof import('sharp'));

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB pre-encode cap
const MAX_DIM = 2400; // downscale very large uploads

export interface UploadResult {
  mediaId: string;
  url: string;
  width: number;
  height: number;
}

export const uploadShowMedia = createServerFn({ method: 'POST' })
  .validator(
    (data: { corpsKey: string; season: string; kind?: string; alt?: string; dataBase64: string }) =>
      data
  )
  .handler(async ({ data }): Promise<UploadResult> => {
    const raw = Buffer.from(data.dataBase64, 'base64');
    if (raw.length === 0) throw new Error('Empty upload');
    if (raw.length > MAX_BYTES) throw new Error('Image too large (max 12 MB)');

    const db = await getContributionsDb();
    const lockLevel = ((
      await db.execute({
        sql: 'SELECT lock_level FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
        args: [data.corpsKey, data.season],
      })
    ).rows[0]?.lock_level ?? 'none') as PageLock;
    const actor = await requireCapability(getWebRequest(), 'upload', { lockLevel });
    await enforceRateLimit(db, actor, 'upload'); // M9 spam throttle (trusted+ exempt)

    // Re-encode to WebP: .rotate() bakes orientation; webp() emits no metadata → EXIF/GPS gone.
    const { data: webp, info } = await getSharp()(raw)
      .rotate()
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });

    const now = new Date().toISOString();
    const ctx = { authorId: actor.userId, actorRole: actor.role, now };
    const pageId = await ensureShowPage(db, data.corpsKey, data.season, ctx);

    const mediaId = crypto.randomUUID();
    const key = uploadKey(`${pageId}/${mediaId}.webp`);
    await putUpload(key, new Uint8Array(webp), 'image/webp');

    await db.execute({
      sql: `INSERT INTO show_media
              (media_id, page_id, block_id, r2_key, kind, width, height, alt, attribution, uploaded_by, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        mediaId,
        pageId,
        null,
        key,
        data.kind ?? 'image',
        info.width,
        info.height,
        data.alt ?? null,
        null,
        actor.userId,
        now,
      ],
    });

    return { mediaId, url: `/api/show-media/${mediaId}`, width: info.width, height: info.height };
  });
