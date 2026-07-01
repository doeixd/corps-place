import { useState, type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FilterChips, type FilterChipItem } from '@/components/filter-chips';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { seoHead } from '@/lib/seo';
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
import {
  parseMetric,
  parseDivs,
  parseRecency,
  rankingsCanonicalPath,
} from '@/lib/rankings/codec';

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
      <PopoverTrigger className="inline-flex h-7 items-center rounded-[min(var(--radius-md),12px)] border border-input px-2.5 text-[0.8rem] font-medium text-text-secondary transition-colors hover:bg-muted hover:text-foreground">
        Recency settings
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
    // Years are bare integers, so the router's JSON parseSearch decodes
    // `?season=2025` back as the NUMBER 2025 (see router.tsx) — coerce to string
    // rather than rejecting it, otherwise every season chip silently resets to
    // the default season.
    season:
      typeof s.season === 'string'
        ? s.season
        : typeof s.season === 'number'
          ? String(s.season)
          : undefined,
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
    const metric: RankMetric = deps.metric ?? 'total';
    const result = await getRankings({
      data: {
        season,
        asof: deps.asof,
        metric,
        agg: deps.agg ?? 'best',
        div: deps.div ?? DEFAULT_DIVISIONS,
      },
    });
    // pSEO canonical: collapse all non-major filters onto the season×metric base
    // (newest season → bare /rankings). Same helper feeds the sitemap.
    const canonical = rankingsCanonicalPath(season, metric, seasons[0] ?? season);
    return { seasons, season, metric, canonical, result };
  },
  head: ({ loaderData }) => {
    const season = loaderData?.season;
    const metric = loaderData?.metric ?? 'total';
    const metricLabel = RANK_METRIC_LABELS[metric];
    const isTotal = metric === 'total';
    const title = season
      ? `${season} ${isTotal ? '' : `${metricLabel} `}Drum Corps Rankings`
      : 'Drum Corps Rankings — season standings';
    const description = season
      ? `${season} drum corps ${isTotal ? 'overall' : metricLabel.toLowerCase()} season standings` +
        ' — filter by metric, division, and as-of date, with a rank bump chart.'
      : 'Season standings and a rank bump chart — filter by metric, division, and as-of date.';
    return seoHead({ title, description, path: loaderData?.canonical ?? '/rankings' });
  },
  // Static read-model data; a moderate window keeps repeat navs fast.
  staleTime: 5 * 60_000,
  component: RankingsPage,
});

// A labeled filter group: a short caption + its control, so the wall of pills
// reads as discrete, named filters. Inline on a single row (label can sit left
// of a horizontally-scrolling chip set thanks to `min-w-0` on the control).
function LabeledField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-text-secondary">
        {label}
      </span>
      {children}
    </div>
  );
}

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

  const seasonItems: FilterChipItem[] = seasons.slice(0, 10).map((y) => ({ value: y, label: y }));
  const metricItems: FilterChipItem[] = RANK_METRICS.map((m) => ({
    value: m,
    label: RANK_METRIC_LABELS[m],
  }));

  // Apply a new division multi-selection. Empty or the default (world+open)
  // clears the param so the URL stays clean and the resolver falls back.
  const setDivs = (next: string[]) => {
    const valid = next.filter((d) => (RANK_DIVISIONS as readonly string[]).includes(d));
    const isDefault = valid.length === 2 && valid.includes('world') && valid.includes('open');
    set({ div: valid.length === 0 || isDefault ? undefined : valid });
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

      {/* Controls — single-select chips reuse the site-wide FilterChips; the
          two-option filters are segmented ToggleGroups; divisions is a
          multi-select ToggleGroup. */}
      <div className="flex flex-col gap-3">
        <LabeledField label="Season">
          <FilterChips
            ariaLabel="Season"
            className="min-w-0"
            value={season}
            items={seasonItems}
            onSelect={(y) => set({ season: y, asof: undefined })}
          />
        </LabeledField>

        <LabeledField label="Metric">
          <FilterChips
            ariaLabel="Ranking metric"
            className="min-w-0"
            value={metric}
            items={metricItems}
            onSelect={(m) => set({ metric: m === 'total' ? undefined : (m as RankMetric) })}
          />
        </LabeledField>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <LabeledField label="Aggregation">
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Aggregation"
              value={[agg]}
              onValueChange={(v) => {
                const next = v[0] as RankAgg | undefined;
                if (next) set({ agg: next === 'best' ? undefined : 'last3' });
              }}
            >
              <ToggleGroupItem value="best">Best</ToggleGroupItem>
              <ToggleGroupItem value="last3">Last 3</ToggleGroupItem>
            </ToggleGroup>
          </LabeledField>

          <LabeledField label="View">
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Grouping"
              value={[group]}
              onValueChange={(v) => {
                const next = v[0] as RankGroup | undefined;
                if (next) set({ group: next === 'overall' ? undefined : 'division' });
              }}
            >
              <ToggleGroupItem value="overall">Overall</ToggleGroupItem>
              <ToggleGroupItem value="division">By division</ToggleGroupItem>
            </ToggleGroup>
          </LabeledField>

          <LabeledField label="Divisions">
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Divisions"
              value={divs}
              onValueChange={(v) => setDivs(v as string[])}
            >
              {RANK_DIVISIONS.map((d) => (
                <ToggleGroupItem key={d} value={d}>
                  {DIVISION_LABELS[d]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </LabeledField>

          <RecencySettings
            recency={recency}
            onChange={(r) =>
              set({ recency: r.join(',') === DEFAULT_RECENCY.join(',') ? undefined : r })
            }
          />
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
        recency={recency}
        hoveredSlug={hovered}
        onHover={setHovered}
      />
    </PageShell>
  );
}
