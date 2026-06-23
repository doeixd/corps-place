/**
 * MediaService (migration plan §3.3 / P4c) — fantasy corps-logo upload on the
 * Effect path. Ports `server-fns/fantasy-media.ts`: member-gate, sharp→WebP
 * re-encode, R2 upload, `fantasy_media` row. The sharp/R2 calls (infra) are
 * wrapped via Effect.promise; validation failures are typed DraftConflict-free
 * MediaConflict-free — kept as plain failures the boundary maps.
 *
 * SERVER-ONLY.
 */
import { Context, Effect, Layer } from 'effect';
import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Actor } from '@/lib/authz';
import { putUpload, uploadKey } from '@/lib/r2';
import { Forbidden } from './errors';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

// Runtime-require sharp (same untraced-specifier trick as media-cache.ts).
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

const makeMediaService = Effect.gen(function* () {
  const sql = yield* ContributionsSql;

  const uploadLogo = Effect.fn('MediaService.uploadLogo')(function* (input: {
    actor: Actor;
    leagueId: string;
    dataBase64: string;
  }) {
    yield* requireDurableStorage;

    const member = yield* sql<{ one: number }>`
      SELECT 1 AS one FROM fantasy_members
      WHERE league_id = ${input.leagueId} AND user_id = ${input.actor.userId} AND status = 'active' LIMIT 1
    `.pipe(Effect.orDie);
    if (!member[0]) return yield* Effect.fail(new Forbidden());

    const raw = Buffer.from(input.dataBase64, 'base64');
    // Plain validation failures (empty / too large) — these become 500-ish defects,
    // matching the legacy thrown Errors (the upload UI surfaces a generic failure).
    if (raw.length === 0) return yield* Effect.die(new Error('Empty upload'));
    if (raw.length > MAX_BYTES) return yield* Effect.die(new Error('Image too large (max 8 MB)'));

    const { webp, info } = yield* Effect.promise(async () => {
      const out = await getSharp()(raw)
        .rotate()
        .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      return { webp: out.data, info: out.info };
    });

    const mediaId = randomUUID();
    const key = uploadKey(`fantasy-logos/${input.leagueId}/${mediaId}.webp`);
    yield* Effect.promise(() => putUpload(key, new Uint8Array(webp), 'image/webp'));

    const now = new Date().toISOString();
    yield* sql`
      INSERT INTO fantasy_media
        (media_id, league_id, user_id, r2_key, width, height, uploaded_by, uploaded_at)
      VALUES (${mediaId}, ${input.leagueId}, ${input.actor.userId}, ${key}, ${info.width},
              ${info.height}, ${input.actor.userId}, ${now})
    `.pipe(Effect.orDie);

    return {
      mediaId,
      url: `/api/fantasy-media/${mediaId}`,
      width: info.width,
      height: info.height,
    };
  });

  return { uploadLogo };
});

export class MediaService extends Context.Service<
  MediaService,
  Effect.Success<typeof makeMediaService>
>()('MediaService') {}

export const MediaServiceLive = Layer.effect(MediaService, makeMediaService).pipe(
  Layer.provide(ContributionsSqlLive)
);
