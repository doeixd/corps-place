import { createFileRoute } from '@tanstack/react-router';

/**
 * Reports this build's id (compiled in via Vite `define`, see vite.config.ts). The
 * client's AutoUpdater polls this and reloads when the id differs from its own —
 * i.e. after a deploy. Always no-store so a CDN/browser never serves a stale id.
 *
 * NOTE: the `/api/version` literal isn't in the generated `ServerFileRoutesByPath`
 * until the route tree is regenerated (dev/build) — same escape hatch as the other
 * API routes.
 */
export const Route = createFileRoute('/api/version')({
  server: {
    handlers: {
  GET: async () =>
    new Response(JSON.stringify({ id: __APP_VERSION__ }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store, no-cache, must-revalidate',
      },
    }),
    },
  },
});
