import { createServerFileRoute } from '@tanstack/react-start/server';
import { DEFAULT_APP_ICON_HREF } from '@/lib/logo-recolor';

/**
 * Browsers request `/favicon.ico` implicitly whenever no usable `<link rel="icon">`
 * is in the document — including the brief windows when client-side head management
 * re-syncs on navigation. This used to return 204 (no content), so during those gaps
 * the tab icon went blank. Redirect to the real (small) favicon so there is always
 * something to show.
 */
export const ServerRoute = createServerFileRoute('/favicon.ico').methods({
  GET: async () =>
    new Response(null, {
      status: 302,
      headers: {
        location: DEFAULT_APP_ICON_HREF,
        'cache-control': 'public, max-age=86400',
      },
    }),
});
