import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead } from '@/lib/seo';
import { resolveVsSeries } from '@/lib/server-fns/vs';
import { getCorpsDirectory } from '@/lib/server-fns/hybrid';
import { VsChart } from '@/components/vs/vs-chart';
import { decodeVsSeries, encodeVsSeries, vsSeriesToken } from '@/lib/vs/codec';
import { AddSeries } from '@/components/vs/add-series';
import { VS_SERIES_CAP, type VsSeries } from '@/lib/vs/types';

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
    const [resolved, dir] = await Promise.all([
      resolveVsSeries({ data: { series: seriesFor(deps.s) } }),
      getCorpsDirectory(),
    ]);
    const corpsOptions = dir
      .filter((c) => c.slug)
      .map((c) => ({ slug: c.slug as string, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ...resolved, corpsOptions };
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
  const { series, corpsOptions } = Route.useLoaderData();
  const { s } = Route.useSearch();
  const navigate = Route.useNavigate();

  const current = seriesFor(s);
  const atCap = current.length >= VS_SERIES_CAP;

  // Normalize (dedupe + cap) through the codec so the URL stays canonical.
  const pushSeries = (next: VsSeries[]) => {
    const canon = encodeVsSeries(decodeVsSeries(encodeVsSeries(next)));
    navigate({ search: { s: canon || undefined }, replace: true });
  };

  // Remove a series by its id (which equals its URL token).
  const onRemove = (id: string) => pushSeries(current.filter((spec) => vsSeriesToken(spec) !== id));
  const onAdd = (spec: VsSeries) => pushSeries([...current, spec]);

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
          <VsChart series={series} onRemove={series.length > 1 ? onRemove : undefined} />
          <div className="flex items-center gap-3 px-1">
            <AddSeries onAdd={onAdd} disabled={atCap} corpsOptions={corpsOptions} />
            {atCap ? (
              <span className="text-xs text-muted-foreground">
                Showing the max of {VS_SERIES_CAP} series — remove one to add another.
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
}
