/**
 * Fantasy corps-logo upload (plan §7.4 + §19.2 R1).
 *
 * Deliberately does NOT reuse `uploadShowMedia` — that path is coupled to the
 * show-wiki (ensureShowPage, the 'upload' capability, show_media keyed by
 * page_id) and would pollute wiki data. We reuse only the low-level pieces: the
 * sharp→WebP re-encode (which bakes EXIF orientation via .rotate() and drops all
 * metadata) and R2 putUpload/uploadKey. Rows live in the dedicated `fantasy_media`
 * table, served back via /api/fantasy-media/$id.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import * as v from 'valibot';
import { getContributionsDb, durableStorageStatus } from '@/lib/contributions-db';
import { getActor } from '@/lib/authz';
import { putUpload, uploadKey } from '@/lib/r2';

// Runtime-require sharp (same untraced-specifier trick as media.ts / media-cache.ts).
const nodeRequire = createRequire(import.meta.url);
let _sharp: typeof import('sharp') | null = null;
const getSharp = () =>
  (_sharp ??= nodeRequire(process.env.SHARP_MODULE ?? 'sharp') as typeof import('sharp'));

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB pre-encode cap
const MAX_DIM = 512; // logos are small; downscale to 512px longest axis

export interface FantasyLogoResult {
  mediaId: string;
  url: string;
  width: number;
  height: number;
}

const UploadInput = v.object({
  leagueId: v.string(),
  dataBase64: v.pipe(v.string(), v.minLength(1)),
});

export const uploadFantasyLogo = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UploadInput, d))
  .handler(async ({ data }): Promise<FantasyLogoResult> => {
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');

    const status = durableStorageStatus();
    if (!status.ready) throw new Error(`STORAGE_UNAVAILABLE: ${status.reason}`);

    const db = await getContributionsDb();
    // Authorize: actor must be an active member of the league.
    const member = (
      await db.execute({
        sql: "SELECT 1 FROM fantasy_members WHERE league_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
        args: [data.leagueId, actor.userId],
      })
    ).rows[0];
    if (!member) throw new Error('FORBIDDEN');

    const raw = Buffer.from(data.dataBase64, 'base64');
    if (raw.length === 0) throw new Error('Empty upload');
    if (raw.length > MAX_BYTES) throw new Error('Image too large (max 8 MB)');

    const { data: webp, info } = await getSharp()(raw)
      .rotate()
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });

    const mediaId = crypto.randomUUID();
    const key = uploadKey(`fantasy-logos/${data.leagueId}/${mediaId}.webp`);
    await putUpload(key, new Uint8Array(webp), 'image/webp');

    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO fantasy_media
              (media_id, league_id, user_id, r2_key, width, height, uploaded_by, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [mediaId, data.leagueId, actor.userId, key, info.width, info.height, actor.userId, now],
    });

    return {
      mediaId,
      url: `/api/fantasy-media/${mediaId}`,
      width: info.width,
      height: info.height,
    };
  });
