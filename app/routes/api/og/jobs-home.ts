import { createFileRoute } from '@tanstack/react-router';
import { renderOgPng, OG_HEADERS } from '@/lib/og/render';
import { HomeCard } from '@/lib/og/templates';
import { pageantryFaviconPngDataUri } from '@/lib/og/favicon.generated';

/** Default PageantryJobs social card (favicon + name + explainer). Brand-wide
 *  og:image fallback for jobs pages that don't set their own. */
export const Route = createFileRoute('/api/og/jobs-home')({
  server: {
    handlers: {
  GET: async () =>
    new Response(
      await renderOgPng(
        HomeCard({
          icon: pageantryFaviconPngDataUri,
          title: 'PageantryJobs',
          subtitle:
            'Jobs in drum corps, marching band, color guard, dance, pageants & the performing arts.',
          accent: 'rgba(46,111,158,0.30)',
        })
      ),
      { headers: OG_HEADERS }
    ),
    },
  },
});
