import { createServerFileRoute } from '@tanstack/react-start/server';
import { renderOgPng, OG_HEADERS } from '@/lib/og/render';
import { HomeCard } from '@/lib/og/templates';

/** Default DrumCorps.app social card (favicon + name + explainer). Used as the
 *  brand-wide og:image fallback for pages that don't set their own. */
export const ServerRoute = createServerFileRoute('/api/og/home').methods({
  GET: async () =>
    new Response(
      await renderOgPng(
        HomeCard({
          title: 'DrumCorps.app',
          subtitle:
            'Live drum corps scores, schedules, AI predictions, and judge, staff & show profiles.',
        })
      ),
      { headers: OG_HEADERS }
    ),
});
