import { useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead } from '@/lib/seo';
import { resolveVsSeries, getVsSeasonAvailability } from '@/lib/server-fns/vs';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { VsChart } from '@/components/vs/vs-chart';
import { decodeVsSeries, encodeVsSeries, vsSeriesToken } from '@/lib/vs/codec';
// Old popover-based builder — replaced by <AddCompareSection> below, kept (not
// deleted) for reference / quick rollback.
// import { AddSeries } from '@/components/vs/add-series';
import { AddCompareSection } from '@/components/vs/add-compare-section';
import { VS_SERIES_CAP, type VsResolvedSeries, type VsSeries } from '@/lib/vs/types';

// Default comparison when `?s=` is absent (plan M3): two finalist corps' most
// recent complete season + the 1st-place reference curve.
const DEFAULT_SERIES: VsSeries[] = [
  { kind: 'corps', corpsSlug: 'blue-devils', season: '2025' },
  { kind: 'corps', corpsSlug: 'bluecoats', season: '2025' },
  { kind: 'baseline', rank: 1 },
];

const seriesFor = (s: string | undefined): VsSeries[] => {
  const decoded = decodeVsSeries(s);
  return decoded.length > 0 ? decoded : DEFAULT_SERIES;
};

export const Route = createFileRoute('/vs')({
  validateSearch: (search: Record<string, unknown>): { s?: string } => ({
    s: typeof search.s === 'string' && search.s ? search.s : undefined,
  }),
  loaderDeps: ({ search }) => ({ s: search.s }),
  loader: async ({ deps }) => {
    const [resolved, dir, availability] = await Promise.all([
      resolveVsSeries({ data: { series: seriesFor(deps.s) } }),
      getCorpsDirectory(),
      getVsSeasonAvailability().catch(() => ({ bySeason: {} as Record<string, string[]> })),
    ]);
    const corpsOptions = dir
      .filter((c) => c.slug)
      .map((c) => ({
        slug: c.slug as string,
        name: c.name,
        // Logo sources for the theme-aware <CorpsLogo> in the search results.
        corps_logo: c.corps_logo,
        corps_logo_dark: c.corps_logo_dark,
        corps_logo_dark_url: c.corps_logo_dark_url,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ...resolved, corpsOptions, availabilityBySeason: availability.bySeason };
  },
  head: () =>
    seoHead({
      title: 'VS — Compare drum corps scores',
      description:
        'Compare any corps, seasons, and reference baselines on one curve, aligned by % through the season.',
      path: '/vs',
    }),
  component: VsPage,
});

function VsPage() {
  const { series, corpsOptions, availabilityBySeason } = Route.useLoaderData();
  const { s } = Route.useSearch();
  const navigate = Route.useNavigate();

  const current = seriesFor(s);
  const atCap = current.length >= VS_SERIES_CAP;
  // Tokens already in the comparison — so the picker can mark options "added"
  // instead of silently de-duping to a no-op (e.g. the default 1st-place line).
  const addedTokens = new Set(
    current.map((c) => vsSeriesToken(c)).filter((t): t is string => !!t)
  );

  // Normalize (dedupe + cap) through the codec so the URL stays canonical.
  const pushSeries = (next: VsSeries[]) => {
    const canon = encodeVsSeries(decodeVsSeries(encodeVsSeries(next)));
    navigate({ search: { s: canon || undefined }, replace: true });
  };

  // Remove a series by its id (which equals its URL token).
  const onRemove = (id: string) => pushSeries(current.filter((spec) => vsSeriesToken(spec) !== id));
  // Toggle a series: clicking an option that's already in the comparison removes
  // it; otherwise it's added. (The picker drives this for every option.)
  const onToggle = (spec: VsSeries) => {
    const token = vsSeriesToken(spec);
    if (token && current.some((c) => vsSeriesToken(c) === token)) onRemove(token);
    else pushSeries([...current, spec]);
  };

  // Hover-preview: resolve the hovered spec to a ghost line on the chart. Cached
  // per token; `wantedRef` guards against a stale resolve landing after the
  // pointer has already moved on (or been cleared).
  const [preview, setPreview] = useState<VsResolvedSeries | null>(null);
  const previewCache = useRef(new Map<string, VsResolvedSeries | null>());
  const wantedToken = useRef<string | null>(null);

  const onPreview = (spec: VsSeries | null) => {
    const token = spec ? vsSeriesToken(spec) : null;
    // Nothing to preview, or it's already a committed line → no ghost.
    if (!spec || !token || current.some((c) => vsSeriesToken(c) === token)) {
      wantedToken.current = null;
      setPreview(null);
      return;
    }
    wantedToken.current = token;
    const cached = previewCache.current.get(token);
    if (cached !== undefined) {
      setPreview(cached);
      return;
    }
    resolveVsSeries({ data: { series: [spec] } })
      .then((r) => {
        const resolved = r.series[0] ?? null;
        previewCache.current.set(token, resolved);
        if (wantedToken.current === token) setPreview(resolved);
      })
      .catch(() => {});
  };

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold text-text-primary">VS — Score Comparison</h1>
        <p className="text-sm text-muted-foreground">
          Compare corps, seasons, and reference baselines on one curve. The x-axis is{' '}
          <span className="font-medium text-text-secondary">% through the season</span> — 0% = first
          show, 100% = finals — so different seasons line up.
        </p>
      </div>
      <Card>
        <CardContent className="space-y-3 px-2 py-4">
          <VsChart
            series={series}
            onRemove={series.length > 1 ? onRemove : undefined}
            preview={preview}
          />
          {/* Old inline popover trigger — replaced by the <AddCompareSection>
              below; kept commented out (not deleted) for reference / rollback.
          <div className="flex items-center gap-3 px-1">
            <AddSeries onAdd={onAdd} disabled={atCap} corpsOptions={corpsOptions} />
            {atCap ? (
              <span className="text-xs text-muted-foreground">
                Showing the max of {VS_SERIES_CAP} series — remove one to add another.
              </span>
            ) : null}
          </div>
          */}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="px-4 py-4">
          <AddCompareSection
            onAdd={onToggle}
            onPreview={onPreview}
            corpsOptions={corpsOptions}
            availabilityBySeason={availabilityBySeason}
            addedTokens={addedTokens}
            atCap={atCap}
            capMessage={`Showing the max of ${VS_SERIES_CAP} series — remove one to add another.`}
          />
        </CardContent>
      </Card>
    </PageShell>
  );
}
