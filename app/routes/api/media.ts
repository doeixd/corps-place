import { createFileRoute } from '@tanstack/react-router';
import {
  getOrFetchMedia,
  getOrFetchResizedMedia,
  getOrFetchDarkMedia,
  getThumbhash,
} from '@/lib/media-cache';

/**
 * Caching image proxy: `/api/media?u=<encoded DCI asset url>`. Serves the bytes
 * from our `media-cache.db` (fetching + storing on first miss) so images survive
 * the source being removed. DCI asset URLs are content-hashed, so the response is
 * safe to cache immutably.
 *
 * NOTE: the `/api/media` literal isn't in the generated `ServerFileRoutesByPath`
 * until the route tree is regenerated (dev/build) — same escape hatch as the
 * other API routes.
 */
export const Route = createFileRoute('/api/media')({
  server: {
    handlers: {
  GET: async ({ request }) => {
    const params = new URL(request.url).searchParams;
    const u = params.get('u');
    if (!u) return new Response('Missing "u" query parameter', { status: 400 });

    // `?thumbhash=1` returns the base64-encoded thumbhash as JSON. Client
    // components decode it via thumbHashToDataURL for an instant placeholder.
    if (params.get('thumbhash') === '1') {
      const hash = await getThumbhash(u);
      if (!hash) return new Response('No thumbhash available', { status: 404 });
      return new Response(JSON.stringify({ thumbhash: hash }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Optional `?w=<px>` serves a width-matched WebP variant (resized + cached)
    // instead of the full-resolution original — see getOrFetchResizedMedia.
    const wRaw = params.get('w');
    const width = wRaw ? Number(wRaw) : NaN;
    const hasWidth = Number.isFinite(width) && width > 0;
    // `?dark=1` serves a luminance-inverted (light-ink) variant for logos that
    // are primarily dark — used in dark mode. Needs a width to size the variant.
    const dark = params.get('dark') === '1';
    const media =
      dark && hasWidth
        ? await getOrFetchDarkMedia(u, width)
        : hasWidth
          ? await getOrFetchResizedMedia(u, width)
          : await getOrFetchMedia(u);
    if (!media) return new Response('Image unavailable', { status: 404 });

    // Copy into a plain ArrayBuffer (a guaranteed BodyInit) — sidesteps the
    // ArrayBufferLike typing on Uint8Array.
    const buffer = new ArrayBuffer(media.body.byteLength);
    new Uint8Array(buffer).set(media.body);

    return new Response(buffer, {
      headers: {
        'content-type': media.contentType,
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  },
    },
  },
});
