import { useState } from 'react';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { LeagueTabs } from '@/components/fantasy/league-tabs';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead } from '@/lib/seo';
import { requireFantasyEnabled } from '@/lib/fantasy/flag';
import { getStandings } from '@/lib/server-fns/fantasy';
import { standingsCollection } from '@/db/fantasy-collections';
import { HybridCollection } from '@/components/hybrid-collection';
import { Explain } from '@/components/fantasy/explain';
import { SectionErrorBoundary } from '@/components/error-boundary';
import { ScoreRecapTable } from '@/components/prediction/score-recap-table';
import {
  cycleSort,
  type RecapRow,
  type RangeKey,
  type SortEntry,
} from '@/lib/prediction-scenario';
import type { SortMode } from '@/machines/score-table-machine';

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

/** A standings row reshaped into the recap table's RecapRow (same caption keys). */
const toRecapRow = (row: Row): RecapRow => ({
  corps: row.corpsName || row.userName || 'Player',
  rank: row.rank ?? undefined,
  total: row.total,
  GE: row.ge,
  Visual: row.visual,
  Music: row.music,
  GE1: row.perCaption.GE1 ?? 0,
  GE2: row.perCaption.GE2 ?? 0,
  VP: row.perCaption.VP ?? 0,
  VA: row.perCaption.VA ?? 0,
  CG: row.perCaption.CG ?? 0,
  MB: row.perCaption.MB ?? 0,
  MA: row.perCaption.MA ?? 0,
  MP: row.perCaption.MP ?? 0,
  // Fantasy corps identity logo (rendered by the table's CorpsNameCell override).
  logo: row.corpsLogoMediaId ? `/api/fantasy-media/${row.corpsLogoMediaId}` : undefined,
});

function StandingsContent({ league, rows }: { league: Standings['league']; rows: Row[] }) {
  const final = rows.some((r) => r.isFinal);
  const lastUpdated = rows.reduce<string | null>(
    (max, r) => (r.computedAt && (!max || r.computedAt > max) ? r.computedAt : max),
    null
  );

  // Same sort interactions as the prediction recap table (cycle desc → asc →
  // off; stack vs exclusive), managed locally — no URL sync needed here.
  const [sorts, setSorts] = useState<SortEntry[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>('exclusive');

  const recapRows = rows.map(toRecapRow);

  return (
    <PageShell className="flex flex-col gap-6">
      <header className="space-y-3">
        <BackLink to="/fantasy/$slug" params={{ slug: league.slug }} label="League home" />
        <div className="space-y-1">
          <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
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
        <SectionErrorBoundary label="the standings table">
          <p className="text-sm text-muted-foreground">
            Each player&apos;s total is built from their drafted corps&apos; season-best caption
            scores from real drum corps <Explain term="recap">recaps</Explain>, DCI-style: GE plus
            half of Visual and Music. Captions where no drafted corps has scored yet show an em
            dash and fill in as the season goes. Tap a column to sort.
          </p>
          <ScoreRecapTable
            rows={recapRows}
            corpsLookup={() => undefined}
            title="Standings"
            classFilters={[]}
            onSetClassFilters={() => {}}
            sorts={sorts}
            onCycleSort={(key: RangeKey) => setSorts((prev) => cycleSort(prev, key, sortMode))}
            onSetSorts={setSorts}
            sortMode={sortMode}
            onSetSortMode={setSortMode}
            // Standings are point scores — no prediction intervals, no Ranges toggle.
            showRanges={false}
            onSetShowRanges={() => {}}
            groupByClass={false}
            onSetGroupByClass={() => {}}
          />
        </SectionErrorBoundary>
      )}
    </PageShell>
  );
}
