import { createServerFileRoute } from '@tanstack/react-start/server';
import { renderOgPng, OG_HEADERS, ogText } from '@/lib/og/render';
import { BallotCard } from '@/lib/og/templates';
import { getDraftPool } from '@/lib/fantasy/score-db';
import { getPredictionPool } from '@/lib/server-fns/ballot';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRESET_LABELS: Record<string, string> = {
  finals: 'Finalists',
  semis: 'Semifinalists',
  world: 'World Class',
  open: 'Open Class',
  all: 'All corps',
};

/**
 * OG image for the (unlocked) /predict/finals editor — the arrangement lives in
 * the query params (?o=slug~slug…), so a shared link can unfurl with the actual
 * rankings without an account or a saved row. Slugs resolve to names
 * server-side; with no ?o= it renders the model's predicted order, so the plain
 * page gets a real image too. Params are part of the URL → the CDN cache keys
 * per arrangement (OG_HEADERS is a 1-day cache, fine for the default order
 * drifting as predictions update).
 */
export const ServerRoute = createServerFileRoute('/api/og/finals').methods({
  GET: async ({ request }) => {
    try {
      const url = new URL(request.url);
      const season = /^\d{4}$/.test(url.searchParams.get('season') ?? '')
        ? (url.searchParams.get('season') as string)
        : '2026';
      const presetLabel = PRESET_LABELS[url.searchParams.get('preset') ?? 'finals'] ?? 'Finalists';

      // slug → name from the season's performing pool (same identity mapping the
      // editor uses: page slug when known, else corps key).
      const pool = await getDraftPool(season).catch(() => []);
      const nameBySlug = new Map(pool.map((c) => [c.slug ?? c.corpsKey, c.name]));

      const oParam = url.searchParams.get('o') ?? '';
      let slugs = oParam.split('~').filter((s) => SLUG_RE.test(s) && nameBySlug.has(s));
      const custom = slugs.length >= 2;
      if (!custom) {
        // No valid arrangement → the model's predicted order (top of the pool).
        const predicted = await getPredictionPool({ data: season }).catch(() => []);
        slugs = predicted.map((c) => c.corpsSlug).filter((s) => nameBySlug.has(s));
      }
      if (slugs.length < 2) return new Response('Not found', { status: 404 });

      const today = new Date().toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });
      const png = await renderOgPng(
        BallotCard({
          title: custom ? `My ${season} Finals Prediction` : `${season} Predicted Finals Rankings`,
          author: null,
          sub: `${custom ? 'Fan prediction' : 'Model forecast'} - ${presetLabel} - ${today}`,
          rows: slugs.slice(0, 10).map((s, i) => ({ rank: i + 1, name: ogText(nameBySlug.get(s)!) })),
          more: Math.max(0, slugs.length - 10),
        })
      );
      return new Response(png, { headers: OG_HEADERS });
    } catch {
      return new Response('Unavailable', { status: 500 });
    }
  },
});
