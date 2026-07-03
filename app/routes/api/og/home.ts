import { createFileRoute } from '@tanstack/react-router';
import { renderOgPng, OG_HEADERS } from '@/lib/og/render';
import { HomeCard } from '@/lib/og/templates';
import { faviconPngDataUri } from '@/lib/og/favicon.generated';

/** Default DrumCorps.app social card (favicon + name + explainer). Used as the
 *  brand-wide og:image fallback for pages that don't set their own. */
export const Route = createFileRoute('/api/og/home')({
  server: {
    handlers: {
  GET: async () =>
    new Response(
      await renderOgPng(
        HomeCard({
          icon: faviconPngDataUri,
          title: 'DrumCorps.app',
          subtitle:
            'Live drum corps scores, schedules, AI predictions, and judge, staff & show profiles.',
          accent: 'rgba(253,80,7,0.22)',
        })
      ),
      { headers: OG_HEADERS }
    ),
    },
  },
});
