import { createServerFileRoute } from '@tanstack/react-start/server';
import { renderOgPng, OG_HEADERS, ogText, logoDataUri } from '@/lib/og/render';
import { BallotCard } from '@/lib/og/templates';
import { getContributionsDb } from '@/lib/contributions-db';
import { getDraftPool } from '@/lib/fantasy/score-db';

/**
 * Generated OG image for a locked prediction ballot: title/author, lock date,
 * and the top 10 of the predicted order. Ballots are immutable, so the image for
 * an id never changes — the shared OG_HEADERS long cache is safe. Also fetched
 * directly by the share page's "Download image" button (one rendering path).
 */
export const ServerRoute = createServerFileRoute('/api/og/ballot/$id').methods({
  GET: async ({ params }) => {
    const id = params.id;
    if (!/^[a-f0-9]{16}$/.test(id)) return new Response('Not found', { status: 404 });
    try {
      const db = await getContributionsDb();
      const row = (
        await db.execute({
          sql: `SELECT season, preset, title, display_name, orders_json, locked_at
                FROM prediction_ballots WHERE ballot_id = ?`,
          args: [id],
        })
      ).rows[0];
      if (!row) return new Response('Not found', { status: 404 });

      const season = row.season as string;
      const preset = row.preset as string;
      const overall =
        (JSON.parse(row.orders_json as string) as { overall: { slug: string; name: string }[] })
          .overall ?? [];
      const presetLabel =
        { finals: 'Finalists', semis: 'Semifinalists', world: 'World Class', open: 'Open Class', all: 'All corps', custom: 'Custom field' }[
          preset
        ] ?? preset;
      const lockedDate = new Date(row.locked_at as string).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      });

      // orders_json only stores slug+name; logos come from the season pool.
      const pool = await getDraftPool(season).catch(() => []);
      const logoBySlug = new Map(pool.map((c) => [c.slug ?? c.corpsKey, c.corpsLogo]));
      const shown = overall.slice(0, 12);
      const logos = await Promise.all(shown.map((e) => logoDataUri(logoBySlug.get(e.slug))));
      const png = await renderOgPng(
        BallotCard({
          title: ogText((row.title as string | null) || `${season} Finals Prediction`),
          author: row.display_name ? ogText(row.display_name as string) : null,
          sub: `Locked ${lockedDate} - ${presetLabel}`,
          rows: shown.map((e, i) => ({ rank: i + 1, name: ogText(e.name), logo: logos[i] })),
          more: Math.max(0, overall.length - 12),
        })
      );
      return new Response(png, { headers: OG_HEADERS });
    } catch {
      return new Response('Unavailable', { status: 500 });
    }
  },
});
