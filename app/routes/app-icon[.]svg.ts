// Generates the favicon: the site logo recolored to a corps's brand palette,
// baked into a static SVG. The favorited corps's colors arrive as query params
// (`p` = primary hex, `d` = --logo-dark oklch), so the URL is deterministic and
// CDN-cacheable per corps, and the same href can be rendered identically by the
// server (root head()) and the client store — no hydration mismatch. With no `p`
// it redirects to the default logo.
import { createServerFileRoute } from '@tanstack/react-start/server';
import { recolorLogoMarkup } from '@/lib/logo-recolor';

export const ServerRoute = createServerFileRoute('/app-icon.svg').methods({
  GET: async ({ request }) => {
    const url = new URL(request.url);
    const primary = url.searchParams.get('p');
    const logoDark = url.searchParams.get('d');

    // No corps color → just serve the default logo.
    if (!primary) {
      return Response.redirect(new URL('/logo.svg', url.origin), 302);
    }

    const res = await fetch(new URL('/logo.svg', url.origin));
    const markup = res.ok ? await res.text() : null;
    const recolored = markup ? recolorLogoMarkup(markup, primary, logoDark) : null;
    if (!recolored) {
      return Response.redirect(new URL('/logo.svg', url.origin), 302);
    }

    return new Response(recolored, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        // Deterministic per (p, d), so cache hard. Favoriting changes the URL.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  },
});
