import { createServerFileRoute } from '@tanstack/react-start/server';
import { getBrand, BRAND_CONFIG } from '@/lib/brand';

/**
 * Web app manifest — makes the site installable (Add to Home Screen / PWA), which
 * is what lets Chrome/Android fire `beforeinstallprompt` and iOS offer a proper
 * standalone home-screen app. Served dynamically + host-aware so drumcorps.app
 * and pageantryjobs.com each get their own name + icons (mirrors the brand-aware
 * theme-color/favicon in __root). Icons are the pre-rendered PNGs in /public.
 */
const run = async ({ request }: { request: Request }): Promise<Response> => {
  const brand = getBrand(request);
  const id = BRAND_CONFIG[brand];
  const iconPrefix = brand === 'jobs' ? '/pwa-jobs' : '/pwa';
  const dark = '#0b0b0c';

  const body = {
    name: id.name,
    short_name: id.shortName,
    description: id.seo.description,
    id: '/',
    start_url: '/?utm_source=pwa',
    scope: '/',
    display: 'standalone',
    background_color: dark,
    theme_color: dark,
    icons: [
      { src: `${iconPrefix}-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${iconPrefix}-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: `${iconPrefix}-maskable-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };

  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};

export const ServerRoute = createServerFileRoute('/manifest.webmanifest').methods({ GET: run });
