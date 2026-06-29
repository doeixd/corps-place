// Site analytics (first-party, cookieless). Pageviews/uniques, top paths &
// referrers, domain events, brand/device splits, engagement. Read-only; gated by
// viewAdmin. Data comes from analytics.db via getAnalyticsSummary.
import { createFileRoute, useRouterState } from '@tanstack/react-router';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { getAnalyticsSummary, type AnalyticsSummary } from '@/lib/server-fns/analytics';
import { seoHead } from '@/lib/seo';

type AnalyticsSearch = { range?: string; metric?: Metric };

export const Route = createFileRoute('/admin/analytics')({
  // Filters live in the URL (same pattern as the rest of the site) so they survive
  // refresh and are shareable. `range` drives the server load; `metric` is UI-only.
  validateSearch: (s: Record<string, unknown>): AnalyticsSearch => {
    const out: AnalyticsSearch = {};
    if (typeof s.range === 'string' && RANGES.some((r) => r.key === s.range)) out.range = s.range;
    if (s.metric === 'views' || s.metric === 'visitors') out.metric = s.metric;
    return out;
  },
  loaderDeps: ({ search }) => ({ range: search.range ?? '30d' }),
  loader: adminLoader('viewAdmin', async ({ deps }) => ({
    summary: await getAnalyticsSummary({ data: { range: (deps as { range: string }).range } }),
  })),
  head: () =>
    seoHead({ title: 'Admin — Analytics', description: 'Site analytics', path: '/admin/analytics' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => (data ? <Analytics summary={data.summary} /> : null)}</AdminPage>;
  },
});

const RANGES = [
  { key: '1h', label: '1h' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: '1y', label: '1y' },
  { key: 'all', label: 'All' },
] as const;
type Metric = 'views' | 'visitors';

function Analytics({ summary }: { summary: AnalyticsSummary }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const range = search.range ?? '30d';
  const metric: Metric = search.metric ?? 'views';
  // Pending while the loader refetches a new range → disables the pills.
  const busy = useRouterState({ select: (s) => s.status === 'pending' });

  // Write filters to the URL. `range` changes loaderDeps → server refetch; `metric`
  // leaves loaderDeps untouched → instant, no refetch.
  const load = (r: string) => navigate({ search: (p) => ({ ...p, range: r }) });
  const setMetric = (m: Metric) => navigate({ search: (p) => ({ ...p, metric: m }) });

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="First-party · cookieless · no third parties"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => void load(r.key)}
            disabled={busy}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
              r.key === range
                ? 'border-primary/60 bg-accent text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {r.label}
          </button>
        ))}
        {!summary.available ? (
          <span className="text-xs text-text-secondary">No analytics data yet.</span>
        ) : null}
      </div>

      {/* Totals */}
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Pageviews" value={summary.totals.views} />
        <Stat label="Unique visitors" value={summary.totals.visitors} />
        <Stat label="Events" value={summary.totals.events} />
        <Stat
          label="Avg engagement"
          value={`${summary.engagement.avgSeconds}s · ${summary.engagement.avgScroll}%`}
        />
      </div>

      {/* Time series — toggle pageviews vs unique visitors */}
      <Card className="mt-4">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-text-secondary">
            {metric === 'views' ? 'Pageviews' : 'Unique visitors'} over time
          </CardTitle>
          <div className="flex gap-1">
            {(['views', 'visitors'] as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetric(m)}
                className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
                  m === metric
                    ? 'border-primary/60 bg-accent text-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {m === 'views' ? 'Views' : 'Visitors'}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {summary.series.length ? (
            <LineChart series={summary.series} metric={metric} bucketMs={summary.bucketMs} />
          ) : (
            <p className="text-sm text-text-secondary">No data in this range yet.</p>
          )}
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <TableCard
          title="Top pages"
          rows={summary.topPaths.map((p) => [p.path, `${p.views} · ${p.visitors}u`])}
          empty="No pageviews yet"
        />
        <TableCard
          title="Top referrers"
          rows={summary.topReferrers.map((r) => [r.host, r.views])}
          empty="No external referrers"
        />
        <TableCard
          title="Events"
          rows={summary.topEvents.map((e) => [e.name, e.count])}
          empty="No events yet"
        />
        <TableCard
          title="By brand · device"
          rows={[
            ...summary.byBrand.map((b) => [`brand: ${b.brand}`, b.views] as [string, number]),
            ...summary.byDevice.map((d) => [`device: ${d.device}`, d.views] as [string, number]),
          ]}
          empty="—"
        />
      </div>

      {/* Core Web Vitals (field) — p75 is the score Google grades on. */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Core Web Vitals · p75 (field)
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {summary.webVitals.length ? (
            <div className="flex flex-wrap gap-4">
              {summary.webVitals.map((v) => (
                <div key={v.metric} className="min-w-24">
                  <div className="text-xs text-text-secondary">{v.metric}</div>
                  <div className={`text-xl font-bold tabular-nums ${vitalColor(v.metric, v.p75)}`}>
                    {formatVital(v.metric, v.p75)}
                  </div>
                  <div className="text-[10px] text-text-muted">{v.samples} samples</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-text-secondary">No web-vitals data yet (collecting on real visits).</p>
          )}
        </CardContent>
      </Card>

      <div className="mt-4">
        <TableCard
          title="Slowest pages · INP p75 (ms)"
          rows={summary.inpByPath.map((r) => [r.path, `${r.p75}ms · ${r.samples}`])}
          empty="No INP data yet"
        />
      </div>
    </>
  );
}

/** Format a bucket start time for the chart axis, granularity-aware. */
function formatBucket(t: number, bucketMs: number): string {
  const d = new Date(t);
  if (bucketMs < 86_400_000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (bucketMs >= 28 * 86_400_000)
    return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Lightweight inline SVG line chart (area + line) over the bucketed series. */
function LineChart({
  series,
  metric,
  bucketMs,
}: {
  series: { t: number; views: number; visitors: number }[];
  metric: Metric;
  bucketMs: number;
}) {
  const W = 720;
  const H = 160;
  const P = 8;
  const max = Math.max(1, ...series.map((d) => d[metric]));
  const x = (i: number) => (series.length <= 1 ? W / 2 : P + (i / (series.length - 1)) * (W - 2 * P));
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = series.map((d, i) => `${x(i)},${y(d[metric])}`).join(' ');
  const area = `${x(0)},${H - P} ${line} ${x(series.length - 1)},${H - P}`;
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full text-primary"
        style={{ height: H }}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${metric} over time`}
      >
        <polygon points={area} className="fill-primary/10" />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-text-muted">
        <span>{formatBucket(series[0].t, bucketMs)}</span>
        <span>peak {max.toLocaleString()}</span>
        <span>{formatBucket(series[series.length - 1].t, bucketMs)}</span>
      </div>
    </div>
  );
}

// CWV "good / needs-improvement / poor" thresholds (stored units: ms; CLS is ×1000).
const VITAL_THRESHOLDS: Record<string, [good: number, poor: number]> = {
  INP: [200, 500],
  LCP: [2500, 4000],
  CLS: [100, 250],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};
function vitalColor(metric: string, v: number): string {
  const t = VITAL_THRESHOLDS[metric];
  if (!t) return 'text-text-primary';
  return v <= t[0] ? 'text-green-600' : v <= t[1] ? 'text-amber-600' : 'text-destructive';
}
function formatVital(metric: string, v: number): string {
  return metric === 'CLS' ? (v / 1000).toFixed(3) : `${v}ms`;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-2xl font-bold tabular-nums">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </div>
        <div className="text-xs text-text-secondary">{label}</div>
      </CardContent>
    </Card>
  );
}

function TableCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: [string, number | string][];
  empty: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold text-text-secondary">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {rows.length ? (
          <ul className="flex flex-col gap-1">
            {rows.map(([k, v], i) => (
              <li key={`${k}-${i}`} className="flex justify-between gap-3">
                <span className="truncate text-text-secondary">{k}</span>
                <span className="shrink-0 tabular-nums">{v}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-text-secondary">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}
