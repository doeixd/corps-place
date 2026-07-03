import { createFileRoute } from '@tanstack/react-router';
import {
  getHybridEventBasic,
  getHybridEventFullRecap,
  getHybridAllEvents,
} from '@/lib/server-fns/hybrid';
import { renderOgPng, OG_HEADERS } from '@/lib/og/render';
import { ScoreCard, SeasonCard } from '@/lib/og/templates';
import { formatEventDate } from '@/lib/format';

const isYear = (s: string) => /^\d{4}$/.test(s);
const place = (c?: string | null, st?: string | null) => [c, st].filter(Boolean).join(', ');

/** Generated OG image for a scored event (podium) or a season archive (/scores/$year). */
export const Route = createFileRoute('/api/og/score/$slug')({
  server: {
    handlers: {
  GET: async ({ params }) => {
    const slug = params.slug;
    try {
      if (isYear(slug)) {
        const all = await getHybridAllEvents().catch(() => []);
        const count = all.filter((e) => e.season === slug && e.scores_released).length;
        return new Response(await renderOgPng(SeasonCard({ season: slug, count })), {
          headers: OG_HEADERS,
        });
      }
      const event = await getHybridEventBasic({ data: slug }).catch(() => null);
      if (!event) return new Response('Not found', { status: 404 });
      const recap = await getHybridEventFullRecap({ data: slug }).catch(() => null);
      const year = slug.match(/^(\d{4})/)?.[1] ?? '';
      const name = event.event_name || event.name || slug;
      const rows = (recap?.corps ?? []) as Array<{
        corps?: string;
        corps_name?: string;
        name?: string;
        rank?: number | null;
        total_score?: number | null;
        total?: number | null;
      }>;
      const podium = [...rows]
        .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))
        .slice(0, 3)
        .map((c) => ({
          corps: c.corps ?? c.corps_name ?? c.name ?? '',
          score:
            (c.total_score ?? c.total) != null ? Number(c.total_score ?? c.total).toFixed(3) : '',
        }))
        .filter((p) => p.corps);
      const sub = [year, formatEventDate(event.start_date), place(event.location_city, event.location_state)]
        .filter(Boolean)
        .join(' · ');
      return new Response(await renderOgPng(ScoreCard({ title: name, sub, podium })), {
        headers: OG_HEADERS,
      });
    } catch {
      return new Response('og error', { status: 500 });
    }
  },
    },
  },
});
