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
import { Forbidden, MediaInvalid } from './errors';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

// Runtime-require sharp (same untraced-specifier trick as media-cache.ts).
const nodeRequire = createRequire(import.meta.url);
let _sharp: typeof import('sharp') | null = null;
const getSharp = () =>
  (_sharp ??= nodeRequire(process.env.SHARP_MODULE ?? 'sharp') as typeof import('sharp'));

const MAX_BYTES = 16 * 1024 * 1024; // 16 MB pre-encode cap (raw phone photos can be large)
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
    // Typed validation failures so the boundary surfaces the exact message (legacy
    // parity) — a defect would be swallowed into a generic 500.
    if (raw.length === 0) return yield* Effect.fail(new MediaInvalid({ message: 'Empty upload' }));
    if (raw.length > MAX_BYTES)
      return yield* Effect.fail(new MediaInvalid({ message: 'Image too large (max 16 MB)' }));

    // sharp throws on formats it can't decode (e.g. HEIC without libheif, or a
    // non-image file). Catch it and surface a clear, typed message instead of a 500
    // — the client also re-encodes to JPEG first, so this is the last resort.
    const encoded = yield* Effect.promise(async () => {
      try {
        const out = await getSharp()(raw)
          .rotate()
          .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer({ resolveWithObject: true });
        return { ok: true as const, webp: out.data, info: out.info };
      } catch {
        return { ok: false as const };
      }
    });
    if (!encoded.ok)
      return yield* Effect.fail(
        new MediaInvalid({
          message: "Couldn't read that image — please try a JPG, PNG, or a screenshot.",
        })
      );
    const { webp, info } = encoded;

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
