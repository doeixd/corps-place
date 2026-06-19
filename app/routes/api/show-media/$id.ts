import { createServerFileRoute } from '@tanstack/react-start/server';
import { getContributionsDb } from '@/lib/contributions-db';
import { getUpload, isUploadKey } from '@/lib/r2';

/**
 * Serve a user-uploaded image by its media_id: looks up the R2 key in show_media,
 * streams the bytes from R2 with an immutable cache header (keys are content-stable,
 * one per upload). The `isUploadKey` guard ensures we only ever read our own
 * uploads/ prefix, never an arbitrary bucket object.
 *
 * NOTE: the '/api/show-media/$id' literal isn't in the generated route types until
 * the route tree is regenerated (dev/build) — same escape hatch as the other API routes.
 */
export const ServerRoute = createServerFileRoute('/api/show-media/$id').methods({
  GET: async ({ params }) => {
    const db = await getContributionsDb();
    const row = (
      await db.execute({
        sql: 'SELECT r2_key FROM show_media WHERE media_id = ? LIMIT 1',
        args: [params.id],
      })
    ).rows[0] as unknown as { r2_key: string } | undefined;
    if (!row || !isUploadKey(row.r2_key)) return new Response('Not found', { status: 404 });

    const obj = await getUpload(row.r2_key);
    if (!obj) return new Response('Not found', { status: 404 });

    return new Response(obj.body as BodyInit, {
      headers: {
        'Content-Type': obj.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  },
});
