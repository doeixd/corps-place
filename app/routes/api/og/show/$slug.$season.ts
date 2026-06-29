import { createServerFileRoute } from '@tanstack/react-start/server';
import { getCorps, getShowDetail } from '@/lib/server-fns/hybrid';
import { renderOgPng, OG_HEADERS } from '@/lib/og/render';
import { ShowCard } from '@/lib/og/templates';

/** Generated OG image for a per-corps show page (/shows/$slug/$season). */
export const ServerRoute = createServerFileRoute('/api/og/show/$slug/$season').methods({
  GET: async ({ params }) => {
    try {
      const corps = await getCorps({ data: params.slug }).catch(() => null);
      if (!corps?.corps_key) return new Response('Not found', { status: 404 });
      const show = await getShowDetail({
        data: { corpsKey: corps.corps_key, season: params.season },
      }).catch(() => null);
      const title = show?.title || `${params.season} Program`;
      return new Response(
        await renderOgPng(
          ShowCard({
            corps: corps.name ?? '',
            season: params.season,
            title,
            sub: show?.subtitle ?? undefined,
          })
        ),
        { headers: OG_HEADERS }
      );
    } catch {
      return new Response('og error', { status: 500 });
    }
  },
});
