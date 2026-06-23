import { createFileRoute, notFound, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { getStandings } from '@/lib/server-fns/fantasy';
import { standingsCollection } from '@/lib/fantasy/collections';
import { HybridCollection } from '@/components/hybrid-collection';
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
  const { slug } = Route.useParams();
  // Loader SSRs first paint; the live collection takes over after hydration so a
  // recompute (or another tab) reflects without a manual reload.
  return (
    <HybridCollection collection={standingsCollection(slug)} loader={rows}>
      {(liveRows) => <StandingsContent league={league} rows={liveRows} />}
    </HybridCollection>
  );
}

function StandingsContent({ league, rows }: { league: Standings['league']; rows: Row[] }) {
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
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No standings yet — they appear once the draft is done and the first recap is scored.
          </CardContent>
        </Card>
      ) : (
        <Table containerClassName="overflow-x-auto">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">#</TableHead>
              <TableHead>Corps</TableHead>
              <TableHead className="text-right font-semibold">Total</TableHead>
              <TableHead className="text-right">GE</TableHead>
              <TableHead className="text-right">Visual</TableHead>
              <TableHead className="border-r border-border text-right">Music</TableHead>
              {CAPTION_KEYS.map((c) => (
                <TableHead key={c} className="text-right">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <StandingRow key={row.userId} row={row} />
            ))}
          </TableBody>
        </Table>
      )}
    </PageShell>
  );
}

function StandingRow({ row }: { row: Row }) {
  return (
    <TableRow style={row.corpsColor ? { borderLeft: `3px solid ${row.corpsColor}` } : undefined}>
      <TableCell className="text-muted-foreground">{row.rank ?? '—'}</TableCell>
      <TableCell>
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
      </TableCell>
      <TableCell className="text-right font-semibold">{row.total.toFixed(3)}</TableCell>
      <TableCell className="text-right">{fmt(row.ge)}</TableCell>
      <TableCell className="text-right">{fmt(row.visual)}</TableCell>
      <TableCell className="border-r border-border text-right">{fmt(row.music)}</TableCell>
      {CAPTION_KEYS.map((c) => (
        <TableCell key={c} className="text-right text-muted-foreground">
          {fmt(row.perCaption[c] ?? 0)}
        </TableCell>
      ))}
    </TableRow>
  );
}
