import { lazy, Suspense } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead, SITE_URL } from '@/lib/seo';
import { getAccuracy } from '@/lib/server-fns/accuracy';

// Lazy: recharts (~330KB) is deferred so the stat tiles + tables render immediately.
const DailyMaeChart = lazy(() =>
  import('@/components/accuracy/accuracy-charts').then((m) => ({ default: m.DailyMaeChart }))
);
const LeadTimeChart = lazy(() =>
  import('@/components/accuracy/accuracy-charts').then((m) => ({ default: m.LeadTimeChart }))
);
const ErrorHistogram = lazy(() =>
  import('@/components/accuracy/accuracy-charts').then((m) => ({ default: m.ErrorHistogram }))
);

export const Route = createFileRoute('/accuracy')({
  loader: async () => {
    const { payload } = await getAccuracy();
    return { payload };
  },
  head: ({ loaderData }) => {
    const n = loaderData?.payload?.summary.n ?? 0;
    return seoHead({
      title: 'How accurate are our predictions?',
      description:
        `An honest scorecard for our AI drum corps forecasts: mean error, hit rates, ` +
        `winner-called %, and accuracy over the season across ${n || 'hundreds of'} scored ` +
        `corps-events (World + Open Class).`,
      path: '/accuracy',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'WebPage',
          name: 'Prediction accuracy',
          url: `${SITE_URL}/accuracy`,
          description: 'How accurate our DCI score predictions were.',
        },
      ],
    });
  },
  staleTime: 5 * 60_000,
  component: AccuracyPage,
});

const fmt = (x: number, d = 2) =>
  x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDate = (iso: string) => {
  const dt = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? iso
    : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

function StatTile({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="space-y-1 py-4">
        <p className="text-2xl font-semibold tabular-nums text-text-primary sm:text-3xl">{value}</p>
        <p className="text-sm font-medium text-text-secondary">{label}</p>
        {sub ? <p className="text-xs text-text-muted">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

function ChartPlaceholder({ h }: { h: string }) {
  return <div className={`${h} w-full animate-pulse rounded-lg bg-muted/40`} />;
}

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      {hint ? <p className="mt-0.5 text-sm text-text-muted">{hint}</p> : null}
    </div>
  );
}

const BiasArrow = ({ bias }: { bias: number }) => {
  if (Math.abs(bias) < 0.05) return <span className="text-text-muted">≈0</span>;
  const under = bias < 0; // predicted below actual
  return (
    <span className={under ? 'text-info' : 'text-warning'}>
      {under ? '▼' : '▲'} {fmt(Math.abs(bias))}
    </span>
  );
};

function AccuracyPage() {
  const { payload } = Route.useLoaderData();

  if (!payload) {
    return (
      <PageShell>
        <BackLink to="/" label="Back" />
        <h1 className="mt-2 text-2xl font-bold text-text-primary">
          How accurate are our predictions?
        </h1>
        <p className="mt-4 text-text-secondary">
          Accuracy data isn&apos;t available right now. Please check back once this season&apos;s
          shows have been scored.
        </p>
      </PageShell>
    );
  }

  const s = payload.summary;
  const biasWord = s.bias < 0 ? 'under-predict' : 'over-predict';

  return (
    <PageShell>
      <BackLink to="/" label="Back" />

      <header className="mt-2 space-y-2">
        <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">
          How accurate are our predictions?
        </h1>
        <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
          Every forecast we serve is the model&apos;s best guess <em>before</em> a show happens.
          Once the real scores post, we grade ourselves. This is the honest scorecard for the{' '}
          {payload.season} season — {payload.scope} only.
        </p>
        <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
          Want the story behind the numbers? Read the{' '}
          <Link to="/accuracy-report" className="text-primary hover:underline">
            2026 season accuracy report
          </Link>{' '}
          — including the model we rolled back mid-season and how championships graded out.
        </p>
      </header>

      {/* Hero stat tiles */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          value={`${fmt(s.mae)} pts`}
          label="Average error (MAE)"
          sub={`${s.n} corps-events`}
        />
        <StatTile
          value={`${fmt(s.within2Pct, 0)}%`}
          label="Within 2 points"
          sub={`${fmt(s.within1Pct, 0)}% within 1 pt`}
        />
        <StatTile
          value={`${fmt(s.winnerPct, 0)}%`}
          label="Winner called"
          sub={`${s.nShows} shows`}
        />
        <StatTile
          value={`${fmt(s.rankExactPct, 0)}%`}
          label="Exact placement"
          sub={`±${fmt(s.meanRankDisp, 2)} avg places off`}
        />
      </div>

      {/* Accuracy over the season */}
      <section className="mt-10">
        <SectionHeading
          title="Accuracy over the season"
          hint="Average error per show date. Dashed lines mark model upgrades."
        />
        <Card>
          <CardContent className="py-4">
            <Suspense fallback={<ChartPlaceholder h="h-64" />}>
              <DailyMaeChart daily={payload.daily} eras={payload.eras} />
            </Suspense>
          </CardContent>
        </Card>
      </section>

      {/* Error vs lead time */}
      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading
            title="Forecasts sharpen near showtime"
            hint="Average error grouped by how many days before the show the forecast was made."
          />
          <Card>
            <CardContent className="py-4">
              <Suspense fallback={<ChartPlaceholder h="h-56" />}>
                <LeadTimeChart leadTime={payload.leadTime} />
              </Suspense>
            </CardContent>
          </Card>
        </div>

        <div>
          <SectionHeading
            title="Which way do we miss?"
            hint={`Distribution of signed error. On average we ${biasWord} by ${fmt(Math.abs(s.bias))} pts.`}
          />
          <Card>
            <CardContent className="py-4">
              <Suspense fallback={<ChartPlaceholder h="h-56" />}>
                <ErrorHistogram histogram={payload.histogram} />
              </Suspense>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Per-corps accuracy */}
      <section className="mt-10">
        <SectionHeading
          title="Accuracy by corps"
          hint="Best forecast to worst. ▼ = we tend to under-score them, ▲ = over-score. Min 3 shows."
        />
        <Card>
          <CardContent className="px-0 py-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-4 py-2 font-medium">Corps</th>
                    <th className="px-4 py-2 text-right font-medium">Avg error</th>
                    <th className="px-4 py-2 text-right font-medium">Bias</th>
                    <th className="px-4 py-2 text-right font-medium">Shows</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.perCorps.map((c) => (
                    <tr
                      key={c.corpsSlug || c.corpsName}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="px-4 py-2 font-medium text-text-primary">
                        {c.corpsSlug ? (
                          <Link
                            to="/corps/$slug/{-$season}"
                            params={{ slug: c.corpsSlug }}
                            className="hover:text-primary hover:underline"
                          >
                            {c.corpsName}
                          </Link>
                        ) : (
                          c.corpsName
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">
                        {fmt(c.mae)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        <BiasArrow bias={c.bias} />
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-muted">{c.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Per-event table */}
      <section className="mt-10">
        <SectionHeading
          title="Show by show"
          hint="Most recent first. Tap a show to see the full forecast-vs-actual diff."
        />
        <Card>
          <CardContent className="px-0 py-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-4 py-2 font-medium">Show</th>
                    <th className="px-4 py-2 text-right font-medium">Avg error</th>
                    <th className="px-4 py-2 font-medium">Biggest miss</th>
                    <th className="hidden px-4 py-2 font-medium sm:table-cell">Model</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.events.map((e) => (
                    <tr
                      key={`${e.eventSlug}-${e.division}`}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="px-4 py-2">
                        <Link
                          to="/events/$yearSlug/$slug/prediction"
                          params={{ yearSlug: e.yearSlug, slug: e.showSlug }}
                          search={{ view: 'diff' }}
                          className="font-medium text-text-primary hover:text-primary hover:underline"
                        >
                          {e.eventName}
                        </Link>
                        <div className="text-xs text-text-muted">
                          {fmtDate(e.date)} · {e.division.replace(' Class', '')}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">
                        {fmt(e.mae)}
                      </td>
                      <td className="px-4 py-2 text-text-secondary">
                        {e.biggestMissCorps}{' '}
                        <span className="tabular-nums text-text-muted">
                          ({e.biggestMissError > 0 ? '+' : ''}
                          {fmt(e.biggestMissError)})
                        </span>
                      </td>
                      <td className="hidden px-4 py-2 sm:table-cell">
                        <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
                          {e.eraLabel}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Per model era */}
      {payload.perEra.length > 1 ? (
        <section className="mt-10">
          <SectionHeading
            title="By model version"
            hint="How each served model era graded out. Newer models cover only the latest shows."
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {payload.perEra.map((e) => (
              <Card key={e.key}>
                <CardContent className="space-y-1 py-4">
                  <p className="text-sm font-semibold text-text-primary">{e.label}</p>
                  <p className="text-xl font-semibold tabular-nums text-text-primary">
                    {fmt(e.mae)} pts
                  </p>
                  <p className="text-xs text-text-muted">
                    MAE over {e.n} corps-events · bias {e.bias > 0 ? '+' : ''}
                    {fmt(e.bias)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {/* Methodology */}
      <section className="mt-12 border-t border-border pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">
          Methodology
        </h2>
        <div className="mt-3 max-w-prose space-y-2 text-sm leading-relaxed text-text-muted">
          <p>
            &ldquo;What we said going in&rdquo; is the last forecast saved <em>strictly before</em>{' '}
            each event&apos;s start — exactly what was served the night before the show. Because the
            model never sees the show it&apos;s forecasting, these numbers are leakage-safe.
          </p>
          <p>
            Predictions are joined to the official posted scores per corps. Scope is World Class and
            Open Class only — the models don&apos;t cover all-age, so those shows are excluded.
            &ldquo;Error&rdquo; is predicted total minus actual total; MAE is the average of its
            absolute value. &ldquo;Winner called&rdquo; is how often the predicted first-place corps
            actually won. The lead-time chart uses <em>every</em> saved run, not just the final one.
          </p>
          <p>
            The model has changed over the season (final2 → v10.5 → v11 field-pace ensemble); each
            show is graded against whichever model actually served it. These are AI-generated
            forecasts — an estimate for fun, not a guarantee.
          </p>
        </div>
      </section>
    </PageShell>
  );
}
