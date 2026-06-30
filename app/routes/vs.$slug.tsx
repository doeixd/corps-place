// Per-corps pSEO comparison: /vs/<slug> — a focused "2026 vs 2025 scores" page
// for every corps in the 2026 field that also competed in 2025. Reuses the VS
// chart (seeded with the corps' 2025 + 2026 actuals + 2026 predicted-to-finals)
// and adds indexable headings/summary text. Only emitted for qualifying corps;
// others 404. Listed in the sitemap.
import { createFileRoute, notFound, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { Card, CardContent } from '@/components/ui/card';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { VsChart } from '@/components/vs/vs-chart';
import { getVsCorpsComparison } from '@/lib/server-fns/vs';
import { seoHead, breadcrumbLd } from '@/lib/seo';

const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(3));
const fmtDate = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
};

export const Route = createFileRoute('/vs/$slug')({
  loader: async ({ params }) => {
    const data = await getVsCorpsComparison({ data: { slug: params.slug } });
    if (!data) throw notFound();
    return data;
  },
  head: ({ loaderData }) => {
    if (!loaderData)
      return seoHead({ title: 'VS — Compare drum corps scores', description: '', path: '/vs' });
    const { corps, summary } = loaderData;
    const bits: string[] = [];
    if (summary.final2025 != null) bits.push(`2025 finals ${fmt(summary.final2025)}`);
    if (summary.projected2026 != null) bits.push(`2026 projected finals ~${fmt(summary.projected2026)}`);
    return seoHead({
      title: `${corps.name} 2026 vs 2025 Scores — Drum Corps`,
      description:
        `Compare ${corps.name}'s 2026 and 2025 DCI scores on one curve, aligned by percent ` +
        `through the season, with the model's projected finish.${bits.length ? ` ${bits.join('; ')}.` : ''}`,
      path: `/vs/${corps.slug}`,
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'VS — Score Comparison', path: '/vs' },
          { name: `${corps.name} 2026 vs 2025`, path: `/vs/${corps.slug}` },
        ]),
      ],
    });
  },
  component: VsCorpsPage,
});

function VsCorpsPage() {
  const { corps, series, summary } = Route.useLoaderData();
  const date2026 = fmtDate(summary.latest2026Date);
  const up = summary.delta != null && summary.delta >= 0;

  return (
    <PageShell className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <CorpsLogo
          name={corps.name}
          logo={corpsLogoSource(corps.logo)}
          width={48}
          className="size-12 shrink-0"
        />
        <div className="space-y-1">
          <h1 className="text-2xl font-bold text-text-primary">
            {corps.name} — 2026 vs 2025 Scores
          </h1>
          <p className="text-sm text-muted-foreground">
            {corps.name}&rsquo;s 2026 DCI season compared with 2025, scored show-by-show and aligned
            by <span className="font-medium text-text-secondary">% through the season</span> so the
            two line up. Includes the model&rsquo;s projected 2026 finish.
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="px-2 py-4">
          <VsChart series={series} />
        </CardContent>
      </Card>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-text-primary">2025 season</h2>
        <p className="text-sm text-text-secondary">
          {summary.final2025 != null ? (
            <>
              In 2025, {corps.name} finished the season with a score of{' '}
              <span className="font-semibold tabular-nums text-text-primary">
                {fmt(summary.final2025)}
              </span>
              . The full 2025 curve is plotted above for comparison.
            </>
          ) : (
            <>{corps.name}&rsquo;s 2025 season is plotted above for comparison.</>
          )}
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold text-text-primary">2026 season so far</h2>
        <p className="text-sm text-text-secondary">
          {summary.latest2026 != null ? (
            <>
              {corps.name}&rsquo;s most recent 2026 score is{' '}
              <span className="font-semibold tabular-nums text-text-primary">
                {fmt(summary.latest2026)}
              </span>
              {summary.latest2026Event ? ` at ${summary.latest2026Event}` : ''}
              {date2026 ? ` (${date2026})` : ''}.{' '}
            </>
          ) : (
            <>{corps.name} hasn&rsquo;t performed a scored 2026 show yet. </>
          )}
          {summary.projected2026 != null ? (
            <>
              The model projects a 2026 finals score around{' '}
              <span className="font-semibold tabular-nums text-text-primary">
                {fmt(summary.projected2026)}
              </span>{' '}
              (the dashed line).
            </>
          ) : null}
        </p>
      </section>

      {summary.delta != null ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold text-text-primary">2026 vs 2025</h2>
          <p className="text-sm text-text-secondary">
            On the model&rsquo;s projection, {corps.name} is tracking{' '}
            <span className={up ? 'font-semibold text-emerald-600' : 'font-semibold text-orange-600'}>
              {up ? 'up' : 'down'} {fmt(Math.abs(summary.delta))}
            </span>{' '}
            versus its 2025 finals score.
          </p>
        </section>
      ) : null}

      <p className="text-sm text-muted-foreground">
        <Link
          to="/vs"
          search={{ s: `corps~${corps.slug}~2026,corps~${corps.slug}~2025` }}
          className="font-medium text-primary hover:underline"
        >
          Open in the full comparison tool →
        </Link>{' '}
        to add other corps, seasons, captions, and baselines, or{' '}
        <Link
          to="/corps/$slug/{-$season}"
          params={{ slug: corps.slug, season: '2026' }}
          className="font-medium text-primary hover:underline"
        >
          view {corps.name}&rsquo;s profile
        </Link>
        .
      </p>
    </PageShell>
  );
}
