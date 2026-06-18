import { createServerFileRoute } from '@tanstack/react-start/server';

export const ServerRoute = createServerFileRoute('/favicon.ico').methods({
  GET: async () =>
    new Response(null, {
      status: 204,
      headers: {
        'cache-control': 'public, max-age=86400',
      },
    }),
});
