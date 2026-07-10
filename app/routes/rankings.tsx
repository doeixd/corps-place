import { useState, type ReactNode } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { Icon } from '@/components/icon';
import { ArrowDown01Icon } from '@/components/icons/generated';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FilterChips, type FilterChipItem } from '@/components/filter-chips';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { seoHead, SITE_URL } from '@/lib/seo';
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
  type RankChartMode,
  type RankGroup,
  type RankMetric,
} from '@/lib/rankings/types';
import {
  parseChart,
  parseMetric,
  parseDivs,
  parseRecency,
  rankingsCanonicalPath,
} from '@/lib/rankings/codec';

// Data-driven from 2022–25 World/Open Jun–Aug inter-show gaps (n=2150): corps
// compete every 1–2 days (median 2), and ≤3d covers 87% of consecutive-show gaps,
// ≤5d = p95, ≤8d = p98. So Fresh ≤3 (on the normal cadence), Recent ≤5 (a short
// break), Stale ≤8 (a real break); beyond that is rare (extended absence / done).
const DEFAULT_RECENCY = [3, 5, 8];
const DIVISION_LABELS: Record<string, string> = { world: 'World', open: 'Open', 'all-age': 'All-Age' };

// SEO phrase for the selected divisions — drives the h1/title/description so the
// page reads as its own landing page per filter ("2026 Open Class Drum Corps
// Rankings"). `title` is the h1/title infix; `body` the description wording.
const DIVISION_SEO: Record<string, string> = {
  world: 'World Class',
  open: 'Open Class',
  'all-age': 'All-Age',
};
function divisionSeoPhrase(divs: readonly string[]): { title: string; body: string } {
  const labels = divs.map((d) => DIVISION_SEO[d]).filter(Boolean);
  const isDefault =
    divs.length === 2 && divs.includes('world') && divs.includes('open');
  if (isDefault || labels.length === 0) {
    // The flagship page: name both classes for search coverage.
    return { title: 'DCI', body: 'World Class & Open Class' };
  }
  const joined = labels.join(' & ');
  return { title: joined, body: joined };
}

function RecencySettings({
  recency,
  onChange,
}: {
  recency: number[];
  onChange: (r: number[]) => void;
}) {
  // One row per tier; the dot colors + descriptions mirror how rankings-list.tsx
  // fades each corps by days-since-last-competed (opacity 1 / 0.82 / 0.64 / 0.48).
  const tiers = [
    { label: 'Fresh', dot: 'bg-emerald-500', desc: 'full brightness' },
    { label: 'Recent', dot: 'bg-amber-500', desc: 'lightly faded' },
    { label: 'Stale', dot: 'bg-orange-500', desc: 'more faded' },
  ];
  return (
    <Popover>
      <PopoverTrigger className="inline-flex h-7 items-center rounded-[min(var(--radius-md),12px)] border border-input px-2.5 text-[0.8rem] font-medium text-text-secondary transition-colors hover:bg-muted hover:text-foreground">
        Recency settings
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Recency fading</p>
          <p className="text-xs leading-snug text-muted-foreground">
            Corps that haven&apos;t competed recently have staler standings, so each is
            faded by how many days since its last show. Set the day cutoff for each tier:
          </p>
        </div>
        {recency.map((v, i) => (
          <div key={i} className="space-y-0.5">
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2 text-text-secondary">
                <span className={`size-1.5 shrink-0 rounded-full ${tiers[i]?.dot ?? ''}`} />
                {tiers[i]?.label ?? ''} ≤
              </span>
              <span className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  value={v}
                  onChange={(e) => {
                    const next = [...recency];
                    next[i] = Math.max(1, Number(e.target.value) || 1);
                    onChange([...next].sort((a, b) => a - b));
                  }}
                  className="w-16 rounded-lg border border-border bg-background px-2 py-1 text-sm outline-none focus:border-primary/60"
                />
                <span className="text-xs text-muted-foreground">days</span>
              </span>
            </label>
            <p className="pl-3.5 text-[11px] text-muted-foreground">
              Competed within {v} days → {tiers[i]?.desc ?? ''}.
            </p>
          </div>
        ))}
        <p className="border-t border-border pt-2 text-[11px] leading-snug text-muted-foreground">
          <span className="mr-1 inline-block size-1.5 rounded-full bg-red-500 align-middle" />
          Longer than the Stale cutoff → most faded. Fresh corps show with no marker;
          the others get a colored dot and a “Nd ago” note.
        </p>
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
  // A single division stays a PLAIN STRING (`?div=open`) so the URL round-trips
  // without the router's JSON-array 307 (`?div=%5B%22open%22%5D`) — the canonical
  // and sitemap use the plain form, and a canonical URL must not redirect.
  div?: string | string[];
  recency?: number[];
  // Which value the season line chart plots: `rank` (default) or `score`.
  chart?: RankChartMode;
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
    div: (() => {
      const parsed = parseDivs(s.div);
      return parsed === undefined ? undefined : parsed.length === 1 ? parsed[0] : parsed;
    })(),
    recency: parseRecency(s.recency),
    chart: parseChart(s.chart),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const { seasons } = await getRankingSeasons();
    const season = deps.season && seasons.includes(deps.season) ? deps.season : seasons[0] ?? '';
    const metric: RankMetric = deps.metric ?? 'total';
    const selectedDivs = parseDivs(deps.div);
    const divs = selectedDivs ?? DEFAULT_DIVISIONS;
    const result = await getRankings({
      data: {
        season,
        asof: deps.asof,
        metric,
        agg: deps.agg ?? 'best',
        div: divs,
      },
    });
    // pSEO canonical: season×metric base (+ a single selected division — its own
    // landing page). Everything else collapses. Same helper feeds the sitemap.
    const canonical = rankingsCanonicalPath(season, metric, seasons[0] ?? season, selectedDivs);
    return { seasons, season, metric, divs, canonical, result };
  },
  head: ({ loaderData }) => {
    const season = loaderData?.season;
    const metric = loaderData?.metric ?? 'total';
    const metricLabel = RANK_METRIC_LABELS[metric];
    const isTotal = metric === 'total';
    const divisionPhrase = divisionSeoPhrase(loaderData?.divs ?? DEFAULT_DIVISIONS);
    const title = season
      ? `${season} ${divisionPhrase.title} Drum Corps Rankings${isTotal ? '' : ` — ${metricLabel}`}`
      : 'Drum Corps Rankings — DCI season standings';
    const description = season
      ? `${season} DCI ${divisionPhrase.body} drum corps rankings — ` +
        `${isTotal ? 'overall' : metricLabel.toLowerCase()} season standings with scores, ` +
        'a rank bump chart, and filters for caption, division, and as-of date.'
      : 'DCI season standings and a rank bump chart — filter by caption, division, and as-of date.';
    const path = loaderData?.canonical ?? '/rankings';
    // "Updated when": the most recent competition day in this season's rankings is
    // when the data last changed — emit it as Dataset.dateModified so search engines
    // see the page's freshness. Falls back to the resolved as-of day.
    const updated = loaderData?.result?.allDates?.at(-1) ?? loaderData?.result?.asof ?? undefined;
    return seoHead({
      title,
      description,
      path,
      jsonLd: updated
        ? [
            {
              '@context': 'https://schema.org',
              '@type': 'Dataset',
              name: title,
              description,
              url: `${SITE_URL}${path}`,
              ...(season ? { temporalCoverage: season } : {}),
              dateModified: updated,
              isAccessibleForFree: true,
              creator: { '@type': 'Organization', name: 'DrumCorps.app' },
            },
          ]
        : undefined,
    });
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
  const divs = parseDivs(search.div) ?? DEFAULT_DIVISIONS;
  const recency = search.recency ?? DEFAULT_RECENCY;
  const chartMode: RankChartMode = search.chart === 'score' ? 'score' : 'rank';

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
    // Single division → plain string (clean, canonical-stable, redirect-free URL).
    set({
      div:
        valid.length === 0 || isDefault ? undefined : valid.length === 1 ? valid[0] : valid,
    });
  };

  if (!season) {
    return (
      <PageShell className="flex flex-col gap-5">
        <h1 className="text-2xl font-bold text-text-primary">Rankings</h1>
        <p className="text-sm text-muted-foreground">No ranking data is available yet.</p>
      </PageShell>
    );
  }

  const divisionPhrase = divisionSeoPhrase(divs);
  const metricLabel = RANK_METRIC_LABELS[metric];

  return (
    <PageShell className="flex flex-col gap-5">
      <BackLink to="/" label="Back" />
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-text-primary">
          {season} {divisionPhrase.title} Drum Corps Rankings
          {metric !== 'total' ? ` — ${metricLabel}` : ''}
        </h1>
        <p className="text-sm text-muted-foreground">
          DCI {divisionPhrase.body}{' '}
          {metric === 'total' ? 'season standings' : `${metricLabel.toLowerCase()} standings`} + a
          rank bump chart · {agg === 'best' ? 'highest score so far' : 'average of last 3 shows'}
          {result.asof ? ` · as of ${result.asof}` : ''}
          {agg === 'last3' ? ' · * = fewer than 3 shows' : ''}.
        </p>
      </div>

      {/* Controls — collapsed into a compact disclosure so they don't push the
          rankings down. Single-select chips reuse the site-wide FilterChips; the
          two-option filters are segmented ToggleGroups; divisions is a
          multi-select ToggleGroup. */}
      <details className="group rounded-lg border border-border">
        <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
          <span>Filters &amp; options</span>
          <Icon
            icon={ArrowDown01Icon}
            size="sm"
            className="shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="flex flex-col gap-3 border-t border-border p-3">
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
      </details>

      {/* As-of scrubber: time-travel through the season's competition dates. */}
      <AsofScrubber
        dates={result.allDates}
        asof={result.asof}
        onSelect={(date) => set({ asof: date ?? undefined })}
      />

      <Card>
        <CardContent className="px-2 py-4">
          {/* Chart view toggle: rank bump vs. raw score over the season. Score
              lets you see how tightly corps are packed competitively. */}
          <div className="mb-2 flex items-center justify-between gap-2 px-2">
            <span className="text-xs font-medium uppercase tracking-wide text-text-secondary">
              {chartMode === 'score' ? 'Scores over the season' : 'Rankings over the season'}
            </span>
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              aria-label="Chart view"
              value={[chartMode]}
              onValueChange={(v) => {
                const next = v[0] as RankChartMode | undefined;
                if (next) set({ chart: next === 'score' ? 'score' : undefined });
              }}
            >
              <ToggleGroupItem value="rank">Rank</ToggleGroupItem>
              <ToggleGroupItem value="score">Score</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <RankBumpChart
            rows={result.rows}
            dates={result.dates}
            hoveredSlug={hovered}
            onHover={setHovered}
            mode={chartMode}
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
