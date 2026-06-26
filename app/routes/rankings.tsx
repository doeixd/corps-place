import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
import { parseMetric, parseDivs, parseRecency } from '@/lib/rankings/codec';

const DEFAULT_RECENCY = [7, 14, 28];
const DIVISION_LABELS: Record<string, string> = { world: 'World', open: 'Open', 'all-age': 'All-Age' };

function RecencySettings({
  recency,
  onChange,
}: {
  recency: number[];
  onChange: (r: number[]) => void;
}) {
  const labels = ['Fresh ≤', 'Recent ≤', 'Stale ≤'];
  return (
    <Popover>
      <PopoverTrigger className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        Recency…
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 space-y-2 p-3">
        <p className="text-xs text-muted-foreground">
          Dim corps that haven&apos;t performed in this many days.
        </p>
        {recency.map((v, i) => (
          <label key={i} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-text-secondary">{labels[i]}</span>
            <input
              type="number"
              min={1}
              value={v}
              onChange={(e) => {
                const next = [...recency];
                next[i] = Math.max(1, Number(e.target.value) || 1);
                onChange([...next].sort((a, b) => a - b));
              }}
              className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary/60"
            />
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

interface RankSearch {
  season?: string;
  asof?: string;
  metric?: RankMetric;
  agg?: RankAgg;
  group?: RankGroup;
  div?: string[];
  recency?: number[];
}

export const Route = createFileRoute('/rankings')({
  validateSearch: (s: Record<string, unknown>): RankSearch => ({
    season: typeof s.season === 'string' ? s.season : undefined,
    asof: typeof s.asof === 'string' ? s.asof : undefined,
    metric: parseMetric(s.metric),
    agg: s.agg === 'last3' ? 'last3' : undefined,
    group: s.group === 'division' ? 'division' : undefined,
    div: parseDivs(s.div),
    recency: parseRecency(s.recency),
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
  const divs = search.div ?? DEFAULT_DIVISIONS;
  const recency = search.recency ?? DEFAULT_RECENCY;

  const set = (patch: Partial<RankSearch>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  const toggleDiv = (d: string) => {
    const next = divs.includes(d) ? divs.filter((x) => x !== d) : [...divs, d];
    const isDefault = next.length === 2 && next.includes('world') && next.includes('open');
    set({ div: next.length === 0 || isDefault ? undefined : next });
  };

  if (!season) {
    return (
      <PageShell className="flex flex-col gap-5">
        <h1 className="text-2xl font-bold text-text-primary">Rankings</h1>
        <p className="text-sm text-muted-foreground">No ranking data is available yet.</p>
      </PageShell>
    );
  }

  return (
    <PageShell className="flex flex-col gap-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-text-primary">Rankings</h1>
        <p className="text-sm text-muted-foreground">
          {season} season standings + a rank bump chart ·{' '}
          {agg === 'best' ? 'highest score so far' : 'average of last 3 shows'}
          {result.asof ? ` · as of ${result.asof}` : ''}
          {agg === 'last3' ? ' · * = fewer than 3 shows' : ''}.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Season" className="flex flex-wrap gap-1">
          {seasons.slice(0, 10).map((y) => (
            <button key={y} type="button" aria-pressed={y === season} className={pill(y === season)} onClick={() => set({ season: y, asof: undefined })}>
              {y}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Ranking metric" className="flex flex-wrap gap-1">
          {RANK_METRICS.map((m) => (
            <button key={m} type="button" aria-pressed={m === metric} className={pill(m === metric)} onClick={() => set({ metric: m === 'total' ? undefined : m })}>
              {RANK_METRIC_LABELS[m]}
            </button>
          ))}
        </div>
        <div role="group" aria-label="Aggregation" className="flex gap-1">
          <button type="button" aria-pressed={agg === 'best'} className={pill(agg === 'best')} onClick={() => set({ agg: undefined })}>Best</button>
          <button type="button" aria-pressed={agg === 'last3'} className={pill(agg === 'last3')} onClick={() => set({ agg: 'last3' })}>Last 3</button>
        </div>
        <div role="group" aria-label="Grouping" className="flex gap-1">
          <button type="button" aria-pressed={group === 'overall'} className={pill(group === 'overall')} onClick={() => set({ group: undefined })}>Overall</button>
          <button type="button" aria-pressed={group === 'division'} className={pill(group === 'division')} onClick={() => set({ group: 'division' })}>By division</button>
        </div>
        <div role="group" aria-label="Divisions" className="flex gap-1">
          {RANK_DIVISIONS.map((d) => (
            <button key={d} type="button" aria-pressed={divs.includes(d)} className={pill(divs.includes(d))} onClick={() => toggleDiv(d)}>
              {DIVISION_LABELS[d]}
            </button>
          ))}
        </div>
        <RecencySettings
          recency={recency}
          onChange={(r) =>
            set({ recency: r.join(',') === DEFAULT_RECENCY.join(',') ? undefined : r })
          }
        />
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
        recency={recency}
        hoveredSlug={hovered}
        onHover={setHovered}
      />
    </PageShell>
  );
}
