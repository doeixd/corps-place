// Site analytics (first-party, cookieless). Pageviews/uniques, top paths &
// referrers, domain events, brand/device splits, engagement. Read-only; gated by
// viewAdmin. Data comes from analytics.db via getAnalyticsSummary.
import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { adminLoader } from '@/lib/admin-loader';
import { AdminPage } from '@/components/admin/admin-page';
import { PageHeader } from '@/components/page-header';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { getAnalyticsSummary, type AnalyticsSummary } from '@/lib/server-fns/analytics';
import { seoHead } from '@/lib/seo';

export const Route = createFileRoute('/admin/analytics')({
  loader: adminLoader('viewAdmin', async () => ({
    summary: await getAnalyticsSummary({ data: { days: 30 } }),
  })),
  head: () =>
    seoHead({ title: 'Admin — Analytics', description: 'Site analytics', path: '/admin/analytics' }),
  component: () => {
    const { gate, data } = Route.useLoaderData();
    return <AdminPage gate={gate}>{() => (data ? <Analytics initial={data.summary} /> : null)}</AdminPage>;
  },
});

const RANGES = [7, 30, 90] as const;

function Analytics({ initial }: { initial: AnalyticsSummary }) {
  const [summary, setSummary] = useState(initial);
  const [days, setDays] = useState(initial.rangeDays);
  const [busy, setBusy] = useState(false);

  const load = async (d: number) => {
    setBusy(true);
    setDays(d);
    try {
      setSummary(await getAnalyticsSummary({ data: { days: d } }));
    } finally {
      setBusy(false);
    }
  };

  const peakDay = Math.max(1, ...summary.perDay.map((d) => d.views));

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="First-party · cookieless · no third parties"
      />

      <div className="mb-4 flex items-center gap-2">
        {RANGES.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => void load(d)}
            disabled={busy}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
              d === days
                ? 'border-primary/60 bg-accent text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {d}d
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

      {/* Per-day pageviews */}
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-sm font-semibold text-text-secondary">
            Pageviews / day
          </CardTitle>
        </CardHeader>
        <CardContent>
          {summary.perDay.length ? (
            <div className="flex items-end gap-1" style={{ height: 120 }}>
              {summary.perDay.map((d) => (
                <div
                  key={d.day}
                  title={`${d.day}: ${d.views} views, ${d.visitors} visitors`}
                  className="flex-1 rounded-t bg-primary/70 hover:bg-primary"
                  style={{ height: `${Math.max(2, (d.views / peakDay) * 100)}%` }}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">—</p>
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
