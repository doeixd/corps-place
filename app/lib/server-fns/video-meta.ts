import { createServerFn } from '@tanstack/react-start/client';
import { parseVideo } from '@/lib/video-embed';

/**
 * Fetch a video's title from the provider's oEmbed endpoint (YouTube/Vimeo only),
 * to auto-fill the title when a contributor pastes a video link.
 *
 * No SSRF: the fetch target is always a fixed, allow-listed host
 * (youtube.com / vimeo.com) and the user URL is passed only as a query param — we
 * never fetch the user's URL directly. `parseVideo` gates it to recognised video
 * links. Returns null for non-videos or on any failure.
 *
 * Kept in its own module (imports only `createServerFn` + the pure `parseVideo`)
 * so importing it into a client component can't pull server-only deps (sharp /
 * r2 / node:*) into the client bundle.
 */
export const fetchVideoMeta = createServerFn({ method: 'GET' })
  .validator((url: string) => url)
  .handler(async ({ data }): Promise<{ title: string; thumbnailUrl: string | null } | null> => {
    const v = parseVideo(data);
    if (!v) return null;
    const endpoint =
      v.provider === 'youtube'
        ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(data)}`
        : `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(data)}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(endpoint, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      clearTimeout(timer);
      if (!res.ok) return null;
      const json = (await res.json()) as { title?: unknown; thumbnail_url?: unknown };
      const title = typeof json.title === 'string' ? json.title.slice(0, 200) : '';
      const thumbnailUrl =
        typeof json.thumbnail_url === 'string' ? json.thumbnail_url : v.thumbnailUrl;
      return { title, thumbnailUrl };
    } catch {
      return null;
    }
  });
