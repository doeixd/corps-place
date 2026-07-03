import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
  GET: async ({ request }) => {
    const origin = new URL(request.url).origin;
    const body = `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
    return new Response(body, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=86400',
      },
    });
  },
    },
  },
});
