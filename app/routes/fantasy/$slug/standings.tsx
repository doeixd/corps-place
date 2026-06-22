import { createFileRoute, notFound, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { getStandings } from '@/lib/server-fns/fantasy';
import { CAPTION_KEYS } from '@/lib/fantasy/captions';

type Standings = Awaited<ReturnType<typeof getStandings>>;
type Row = Standings['rows'][number];

export const Route = createFileRoute('/fantasy/$slug/standings')({
  beforeLoad: requireFantasyEnabled,
  loader: async ({ params }) => {
    try {
      return await getStandings({ data: { slug: params.slug } });
    } catch (e) {
      if ((e as Error).message.includes('NOT_FOUND')) throw notFound();
      throw e;
    }
  },
  head: ({ loaderData }) =>
    seoHead({
      title: loaderData ? `Standings — ${loaderData.league.name}` : 'Standings',
      description: 'Fantasy DCI league standings.',
      path: '/fantasy',
    }),
  component: StandingsPage,
});

const fmt = (n: number) => (n === 0 ? '—' : n.toFixed(3));

function StandingsPage() {
  const { league, rows } = Route.useLoaderData();
  const final = rows.some((r) => r.isFinal);

  return (
    <PageShell className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold">{league.name} — Standings</h1>
          <p className="text-sm text-muted-foreground">
            Season {league.season}
            {final ? ' · final' : rows.length ? ' · live' : ''}
          </p>
        </div>
        <Button
          variant="outline"
          render={<Link to="/fantasy/$slug" params={{ slug: league.slug }} />}
        >
          League
        </Button>
      </header>

      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          No standings yet — they appear once the draft is done and the first recap is scored.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-2 py-2">#</th>
                <th className="px-2 py-2">Corps</th>
                <th className="px-2 py-2 text-right font-semibold">Total</th>
                <th className="px-2 py-2 text-right">GE</th>
                <th className="px-2 py-2 text-right">Visual</th>
                <th className="border-r border-border px-2 py-2 text-right">Music</th>
                {CAPTION_KEYS.map((c) => (
                  <th key={c} className="px-2 py-2 text-right">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <StandingRow key={row.userId} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PageShell>
  );
}

function StandingRow({ row }: { row: Row }) {
  return (
    <tr
      className="border-b border-border/60"
      style={row.corpsColor ? { borderLeft: `3px solid ${row.corpsColor}` } : undefined}
    >
      <td className="px-2 py-2 text-muted-foreground">{row.rank ?? '—'}</td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-2">
          {row.corpsLogoMediaId ? (
            <img
              src={`/api/fantasy-media/${row.corpsLogoMediaId}`}
              alt=""
              className="size-6 rounded object-contain"
            />
          ) : null}
          <span className="font-medium">{row.corpsName || row.userName || 'Player'}</span>
        </div>
      </td>
      <td className="px-2 py-2 text-right font-semibold">{row.total.toFixed(3)}</td>
      <td className="px-2 py-2 text-right">{fmt(row.ge)}</td>
      <td className="px-2 py-2 text-right">{fmt(row.visual)}</td>
      <td className="border-r border-border px-2 py-2 text-right">{fmt(row.music)}</td>
      {CAPTION_KEYS.map((c) => (
        <td key={c} className="px-2 py-2 text-right text-muted-foreground">
          {fmt(row.perCaption[c] ?? 0)}
        </td>
      ))}
    </tr>
  );
}
