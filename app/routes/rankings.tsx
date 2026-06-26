import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead } from '@/lib/seo';
import { cn } from '@/lib/utils';
import { getRankings, getRankingSeasons } from '@/lib/server-fns/rankings';
import { RankingsList } from '@/components/rankings/rankings-list';
import { RankBumpChart } from '@/components/rankings/rank-bump-chart';
import { AsofScrubber } from '@/components/rankings/asof-scrubber';
import {
  RANK_METRICS,
  RANK_METRIC_LABELS,
  RANK_DIVISIONS,
  DEFAULT_DIVISIONS,
  type RankAgg,
  type RankGroup,
  type RankMetric,
} from '@/lib/rankings/types';

const DEFAULT_RECENCY = [7, 14, 28];
const isMetric = (v: unknown): v is RankMetric => RANK_METRICS.includes(v as RankMetric);

interface RankSearch {
  season?: string;
  asof?: string;
  metric?: RankMetric;
  agg?: RankAgg;
  group?: RankGroup;
  div?: string[];
}

export const Route = createFileRoute('/rankings')({
  validateSearch: (s: Record<string, unknown>): RankSearch => ({
    season: typeof s.season === 'string' ? s.season : undefined,
    asof: typeof s.asof === 'string' ? s.asof : undefined,
    metric: isMetric(s.metric) ? s.metric : undefined,
    agg: s.agg === 'last3' ? 'last3' : undefined,
    group: s.group === 'division' ? 'division' : undefined,
    div:
      typeof s.div === 'string' && s.div
        ? s.div.split(',').filter((d) => (RANK_DIVISIONS as readonly string[]).includes(d))
        : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const { seasons } = await getRankingSeasons();
    const season = deps.season && seasons.includes(deps.season) ? deps.season : seasons[0] ?? '';
    const result = await getRankings({
      data: {
        season,
        asof: deps.asof,
        metric: deps.metric ?? 'total',
        agg: deps.agg ?? 'best',
        div: deps.div ?? DEFAULT_DIVISIONS,
      },
    });
    return { seasons, season, result };
  },
  head: () =>
    seoHead({
      title: 'Rankings — Drum corps season standings',
      description:
        'Season standings and a rank bump chart — filter by metric, division, and as-of date.',
      path: '/rankings',
    }),
  component: RankingsPage,
});

const pill = (active: boolean) =>
  cn(
    'rounded-md border px-2.5 py-1 text-xs transition-colors',
    active
      ? 'border-primary/60 bg-accent text-foreground'
      : 'border-border text-muted-foreground hover:text-foreground'
  );

function RankingsPage() {
  const { seasons, season, result } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [hovered, setHovered] = useState<string | null>(null);

  const metric: RankMetric = search.metric ?? 'total';
  const agg: RankAgg = search.agg ?? 'best';
  const group: RankGroup = search.group ?? 'overall';

  const set = (patch: Partial<RankSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  return (
    <PageShell className="flex flex-col gap-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-text-primary">Rankings</h1>
        <p className="text-sm text-muted-foreground">
          Season standings + a rank bump chart. {agg === 'best' ? 'Highest score so far' : 'Average of last 3 shows'}
          {result.asof ? ` · as of ${result.asof}` : ''}.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-1">
          {seasons.slice(0, 10).map((y) => (
            <button key={y} type="button" className={pill(y === season)} onClick={() => set({ season: y, asof: undefined })}>
              {y}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {RANK_METRICS.map((m) => (
            <button key={m} type="button" className={pill(m === metric)} onClick={() => set({ metric: m === 'total' ? undefined : m })}>
              {RANK_METRIC_LABELS[m]}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button type="button" className={pill(agg === 'best')} onClick={() => set({ agg: undefined })}>Best</button>
          <button type="button" className={pill(agg === 'last3')} onClick={() => set({ agg: 'last3' })}>Last 3</button>
        </div>
        <div className="flex gap-1">
          <button type="button" className={pill(group === 'overall')} onClick={() => set({ group: undefined })}>Overall</button>
          <button type="button" className={pill(group === 'division')} onClick={() => set({ group: 'division' })}>By division</button>
        </div>
      </div>

      {/* As-of scrubber: time-travel through the season's competition dates. */}
      <AsofScrubber
        dates={result.allDates}
        asof={result.asof}
        onSelect={(date) => set({ asof: date ?? undefined })}
      />

      <Card>
        <CardContent className="px-2 py-4">
          <RankBumpChart
            rows={result.rows}
            dates={result.dates}
            hoveredSlug={hovered}
            onHover={setHovered}
          />
        </CardContent>
      </Card>

      <RankingsList
        rows={result.rows}
        season={season}
        metric={metric}
        group={group}
        recency={DEFAULT_RECENCY}
        hoveredSlug={hovered}
        onHover={setHovered}
      />
    </PageShell>
  );
}
