import { createServerFileRoute } from '@tanstack/react-start/server';
import { getContributionsDb } from '@/lib/contributions-db';
import { getUpload, isUploadKey } from '@/lib/r2';

/**
 * Serve a fantasy corps logo by its media_id (plan §19.2 R1): look up the R2 key
 * in fantasy_media, stream the bytes with an immutable cache header (keys are
 * content-stable UUIDs). The `isUploadKey` guard ensures we only ever read our
 * own uploads/ prefix. Mirrors /api/show-media/$id.ts.
 */
export const ServerRoute = createServerFileRoute('/api/fantasy-media/$id').methods({
  GET: async ({ params }) => {
    const db = await getContributionsDb();
    const row = (
      await db.execute({
        sql: 'SELECT r2_key FROM fantasy_media WHERE media_id = ? LIMIT 1',
        args: [params.id],
      })
    ).rows[0] as unknown as { r2_key: string } | undefined;
    if (!row || !isUploadKey(row.r2_key)) return new Response('Not found', { status: 404 });

    const obj = await getUpload(row.r2_key);
    if (!obj) return new Response('Not found', { status: 404 });

    return new Response(obj.body as unknown as BodyInit, {
      headers: {
        'Content-Type': obj.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  },
});
