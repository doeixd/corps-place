// Generates a compact favorite-colored favicon. The URL includes the palette and
// an artwork version, so it is safe to cache immutably without pinning old icons.
import { createFileRoute } from '@tanstack/react-router';
import { APP_ICON_VERSION, DEFAULT_APP_ICON_HREF, favoriteIconMarkup } from '@/lib/logo-recolor';

export const Route = createFileRoute('/app-icon.svg')({
  server: {
    handlers: {
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const primary = url.searchParams.get('p');
    const version = url.searchParams.get('v');

    if (!primary || version !== APP_ICON_VERSION) {
      return Response.redirect(new URL(DEFAULT_APP_ICON_HREF, url.origin), 302);
    }

    const recolored = favoriteIconMarkup(primary);
    if (!recolored) {
      return Response.redirect(new URL(DEFAULT_APP_ICON_HREF, url.origin), 302);
    }

    return new Response(recolored, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        // Deterministic per (p, d), so cache hard. Favoriting changes the URL.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  },
    },
  },
});
