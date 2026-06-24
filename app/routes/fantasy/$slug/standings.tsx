import { createFileRoute, notFound } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { LeagueTabs } from '@/components/fantasy/league-tabs';
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
import { standingsCollection } from '@/db/fantasy-collections';
import { HybridCollection } from '@/components/hybrid-collection';
import { CAPTION_KEYS } from '@/lib/fantasy/captions';
import { Explain } from '@/components/fantasy/explain';

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
      description: 'Fantasy drum corps league standings.',
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
  const lastUpdated = rows.reduce<string | null>(
    (max, r) => (r.computedAt && (!max || r.computedAt > max) ? r.computedAt : max),
    null
  );

  return (
    <PageShell className="flex flex-col gap-6">
      <header className="space-y-3">
        <BackLink to="/fantasy/$slug" params={{ slug: league.slug }} label="League home" />
        <div className="space-y-1">
          <p className="text-[11px] tracking-wider text-text-secondary lowercase [font-variant:small-caps]">
            {league.name} · Season {league.season}
          </p>
          <h1 className="text-2xl font-bold text-text-primary">Standings</h1>
          <p className="text-sm text-text-secondary">
            {final
              ? 'Final results'
              : rows.length
                ? 'Live — updates as recaps land'
                : 'Not started yet'}
            {lastUpdated ? ` · updated ${new Date(lastUpdated).toLocaleDateString()}` : ''}
          </p>
        </div>
        <LeagueTabs
          slug={league.slug}
          active="standings"
          isMember={league.viewerIsMember}
          quizEnabled={league.quizEnabled}
        />
      </header>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No standings yet — they appear once the draft is done and the first recap is scored.
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Each player&apos;s total is the sum of their drafted corps&apos; caption scores from
            real drum corps <Explain term="recap">recaps</Explain>. On a wider screen the total breaks down
            by General Effect, Visual, Music, and the eight captions — hover any code to see what it
            means.
          </p>
          <Table containerClassName="overflow-x-auto">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">#</TableHead>
                <TableHead>Corps</TableHead>
                <TableHead className="text-right font-semibold">Total</TableHead>
                <TableHead className="hidden text-right sm:table-cell">GE</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Visual</TableHead>
                <TableHead className="hidden border-r border-border text-right sm:table-cell">
                  Music
                </TableHead>
                {CAPTION_KEYS.map((c) => (
                  <TableHead key={c} className="hidden text-right lg:table-cell">
                    <Explain term={c}>{c}</Explain>
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
        </>
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
      <TableCell className="hidden text-right sm:table-cell">{fmt(row.ge)}</TableCell>
      <TableCell className="hidden text-right sm:table-cell">{fmt(row.visual)}</TableCell>
      <TableCell className="hidden border-r border-border text-right sm:table-cell">
        {fmt(row.music)}
      </TableCell>
      {CAPTION_KEYS.map((c) => (
        <TableCell key={c} className="hidden text-right text-muted-foreground lg:table-cell">
          {fmt(row.perCaption[c] ?? 0)}
        </TableCell>
      ))}
    </TableRow>
  );
}
