import { createFileRoute, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { BackLink } from '@/components/back-link';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead, SITE_URL } from '@/lib/seo';
import { getAccuracy } from '@/lib/server-fns/accuracy';

// The 2026 season retrospective. Companion to /accuracy (the live dashboard):
// that page is the always-current scorecard, this one is the narrative — what
// we shipped, where it broke, and what the championship stretch graded out at.
//
// LOADER PAYLOAD IS DESERIALIZED INTO THE SSR HTML, so we deliberately return
// ONLY the handful of summary numbers we render (not the full rm_accuracy
// payload, which carries per-corps/per-event/histogram arrays). The headline
// stats are read live so this page never drifts from /accuracy; the era,
// benchmark and model-comparison tables are editorial and hardcoded below.

interface ReportStats {
  n: number;
  nShows: number;
  mae: number;
  medianAbs: number;
  bias: number;
  within1Pct: number;
  within2Pct: number;
  rankExactPct: number;
  meanRankDisp: number;
  winnerPct: number;
  leadTime: { bucket: string; mae: number }[];
}

// Verified season-final figures. Used as-is when the live shard is unavailable,
// so the story always reads with real numbers behind it.
const FALLBACK: ReportStats = {
  n: 436,
  nShows: 61,
  mae: 1.67,
  medianAbs: 1.34,
  bias: -0.65,
  within1Pct: 40,
  within2Pct: 68,
  rankExactPct: 57,
  meanRankDisp: 1.09,
  winnerPct: 82,
  leadTime: [
    { bucket: 'Same day', mae: 1.84 },
    { bucket: '1–3 days', mae: 2.01 },
    { bucket: '3–7 days', mae: 2.31 },
    { bucket: '7–14 days', mae: 2.65 },
    { bucket: '14+ days', mae: 3.04 },
  ],
};

export const Route = createFileRoute('/accuracy-report')({
  loader: async (): Promise<{ stats: ReportStats }> => {
    const { payload } = await getAccuracy().catch(() => ({ payload: null }));
    if (!payload) return { stats: FALLBACK };
    const s = payload.summary;
    return {
      stats: {
        n: s.n,
        nShows: s.nShows,
        mae: s.mae,
        medianAbs: s.medianAbs,
        bias: s.bias,
        within1Pct: s.within1Pct,
        within2Pct: s.within2Pct,
        rankExactPct: s.rankExactPct,
        meanRankDisp: s.meanRankDisp,
        winnerPct: s.winnerPct,
        leadTime: payload.leadTime.length
          ? payload.leadTime.map((l) => ({ bucket: l.bucket, mae: l.mae }))
          : FALLBACK.leadTime,
      },
    };
  },
  head: () =>
    seoHead({
      title: '2026 prediction accuracy report',
      description:
        'Our 2026 DCI season in review: 436 graded forecasts across 61 shows at 1.67 pts average ' +
        'error, the model regression we shipped and rolled back in July, and a 0.59-point Finals night.',
      path: '/accuracy-report',
      type: 'article',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: '2026 prediction accuracy report',
          url: `${SITE_URL}/accuracy-report`,
          datePublished: '2026-08-12',
          description:
            'A season retrospective on how our DCI score predictions performed in 2026, ' +
            'including a model regression that was caught and rolled back.',
        },
      ],
    }),
  staleTime: 10 * 60_000,
  component: AccuracyReportPage,
});

const fmt = (x: number, d = 2) =>
  x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

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

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      {hint ? <p className="mt-0.5 text-sm text-text-muted">{hint}</p> : null}
    </div>
  );
}

function Act({
  n,
  title,
  dates,
  tone,
  children,
}: {
  n: number;
  title: string;
  dates: string;
  tone: 'primary' | 'warning' | 'success';
  children: React.ReactNode;
}) {
  const badge =
    tone === 'warning'
      ? 'bg-warning/15 text-warning'
      : tone === 'success'
        ? 'bg-success/15 text-success'
        : 'bg-primary/15 text-primary';
  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${badge}`}
          >
            {n}
          </span>
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-text-secondary">
            {dates}
          </span>
        </div>
        <div className="max-w-prose space-y-2 text-sm leading-relaxed text-text-secondary">
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

function AccuracyReportPage() {
  const { stats: s } = Route.useLoaderData();

  return (
    <PageShell>
      <BackLink to="/" label="Back" />

      <header className="mt-2 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
          Season retrospective
        </p>
        <h1 className="text-2xl font-bold text-text-primary sm:text-3xl">
          How our 2026 predictions actually did
        </h1>
        <p className="max-w-prose text-sm leading-relaxed text-text-secondary">
          Every night of the summer we published a forecast for every upcoming show, then graded
          ourselves against the posted scores. This is the full-season write-up: the headline
          numbers, the week we shipped a worse model and had to roll it back, and a Finals night
          that came in under six tenths of a point. For the always-current version of these metrics,
          see the{' '}
          <Link to="/accuracy" className="text-primary hover:underline">
            live accuracy dashboard
          </Link>
          .
        </p>
      </header>

      {/* Headline */}
      <section className="mt-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            value={`${fmt(s.mae)} pts`}
            label="Average error (MAE)"
            sub={`${s.n} graded predictions`}
          />
          <StatTile
            value={`${fmt(s.within2Pct, 0)}%`}
            label="Within 2 points"
            sub={`${fmt(s.within1Pct, 0)}% within 1 pt`}
          />
          <StatTile
            value={`${fmt(s.winnerPct, 0)}%`}
            label="Show winner called"
            sub={`${s.nShows} shows`}
          />
          <StatTile
            value={`${fmt(s.rankExactPct, 0)}%`}
            label="Exact placement"
            sub={`${fmt(s.meanRankDisp, 2)} places off on average`}
          />
        </div>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-text-muted">
          Median absolute error was {fmt(s.medianAbs)} points and our season bias was{' '}
          {s.bias < 0 ? '−' : '+'}
          {fmt(Math.abs(s.bias))} — meaning we ran slightly{' '}
          {s.bias < 0 ? 'cold, under-scoring corps' : 'hot, over-scoring corps'} on average. Scope
          is World Class and Open Class; a &ldquo;prediction&rdquo; is the last forecast saved
          before a show started, so nothing here is graded with hindsight.
        </p>
      </section>

      {/* Three acts */}
      <section className="mt-10">
        <SectionHeading
          title="A season in three acts"
          hint="The season-long average hides three very different stretches."
        />
        <div className="space-y-3">
          <Act n={1} title="Finding the range" dates="Through Jul 19" tone="primary">
            <p>
              The model serving most of the summer was <strong>final2</strong> — a v9 network
              wrapped in an adaptive serving layer: a persistence anchor off each corps&apos; last
              score, seasonal growth curves, comparable-corps effects, and a nightly bias
              correction. It graded out around 1.5 points of average error across June and early
              July.
            </p>
            <p>
              The weak spot was cold starts. For a corps&apos; first show of the season there is no
              2026 history to anchor to, so the forecast leans on last year and on comparables — and
              those early-June debuts are where our largest misses of the year live.
            </p>
          </Act>

          <Act n={2} title="The experiment week" dates="Jul 20 – Jul 26" tone="warning">
            <p>
              In late July we promoted two newer models in sequence — <strong>v10.5</strong>, then{' '}
              <strong>v11</strong>. Both were better on our historical backtests. Both were worse in
              the field.
            </p>
            <p>
              Late July is when scores inflate hardest, and the new models systematically failed to
              follow the climb — they under-predicted by roughly 3 points and served at{' '}
              <strong>3.2–3.4 MAE</strong>, roughly double our season average. Our nightly grading
              caught it on matched shows within days, and we rolled back to final2 on{' '}
              <strong>Jul 26</strong>.
            </p>
            <p className="text-text-primary">
              We&apos;d rather say this plainly than bury it: we shipped a regression, our
              monitoring caught it, and we reverted. The reason we can tell you exactly how much it
              cost is the same reason we caught it — every version is graded against real posted
              scores, every night.
            </p>
          </Act>

          <Act n={3} title="The championships stretch" dates="Jul 26 – Finals" tone="success">
            <p>
              With final2 back in front, the last two weeks were the best of the season:{' '}
              <strong>1.03 MAE</strong> with near-zero bias. Prelims on Aug 6 came in at{' '}
              <strong>1.04</strong> across 30 corps, and Finals on Aug 8 at <strong>0.59</strong> —
              our best full-show number of the year.
            </p>
            <p>
              We kept v10.5 and v11 running in shadow mode over the same shows. They stayed near 2.9
              MAE the whole way, which puts a number on the rollback: about{' '}
              <strong>1.8 points saved per prediction</strong> through championships.
            </p>
          </Act>
        </div>
      </section>

      {/* Model comparison */}
      <section className="mt-10">
        <SectionHeading
          title="What the rollback was worth"
          hint="Matched shows, Jul 26 – Aug 8 · 120 matched predictions per model."
        />
        <Card>
          <CardContent className="px-0 py-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 text-right font-medium">Avg error</th>
                    <th className="px-4 py-2 text-right font-medium">Bias</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { name: 'final2', role: 'served', mae: 1.03, bias: -0.04, served: true },
                    { name: 'v10.5', role: 'shadow', mae: 2.86, bias: -2.68, served: false },
                    { name: 'v11', role: 'shadow', mae: 2.88, bias: -2.72, served: false },
                  ].map((m) => (
                    <tr key={m.name} className="border-b border-border/50 last:border-0">
                      <td className="px-4 py-2">
                        <span className="font-medium text-text-primary">{m.name}</span>{' '}
                        <span
                          className={`ml-1 rounded-full px-2 py-0.5 text-xs ${
                            m.served ? 'bg-success/15 text-success' : 'bg-muted text-text-secondary'
                          }`}
                        >
                          {m.role}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">
                        {fmt(m.mae)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">
                        {m.bias > 0 ? '+' : '−'}
                        {fmt(Math.abs(m.bias))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-text-muted">
          The bias column is the tell. The shadow models weren&apos;t noisy — they were pointed the
          wrong way, sitting nearly 2.7 points below reality on every prediction because they never
          learned how steeply championship-week scoring climbs.
        </p>
      </section>

      {/* Lead time */}
      <section className="mt-10">
        <SectionHeading
          title="Forecasts sharpen near showtime"
          hint="Average error by how far ahead the forecast was made, across every saved run."
        />
        <Card>
          <CardContent className="px-0 py-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-4 py-2 font-medium">Made</th>
                    <th className="px-4 py-2 text-right font-medium">Avg error</th>
                  </tr>
                </thead>
                <tbody>
                  {s.leadTime.map((l) => (
                    <tr key={l.bucket} className="border-b border-border/50 last:border-0">
                      <td className="px-4 py-2 font-medium text-text-primary">{l.bucket}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-secondary">
                        {fmt(l.mae)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-text-muted">
          A forecast two weeks out is worth about a point and a quarter less than the one we publish
          the night before. That&apos;s the honest shelf life of a prediction on this site.
        </p>
      </section>

      {/* Details */}
      <section className="mt-10">
        <SectionHeading title="Odds and ends" hint="Season superlatives from the graded set." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardContent className="space-y-2 py-4 text-sm text-text-secondary">
              <p className="font-semibold text-text-primary">Easiest and hardest to read</p>
              <p>
                <strong>Spartans</strong> were our most predictable corps all summer — 0.78 average
                error over 13 shows. <strong>7th Regiment</strong> were the hardest at 4.10, and we
                consistently ran about 3 points hot on them.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 py-4 text-sm text-text-secondary">
              <p className="font-semibold text-text-primary">Biggest championship misses</p>
              <p>
                On Finals night our largest single miss was <strong>Troopers</strong> at 2.15
                points. At Prelims it was <strong>Raiders</strong> at 3.0.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 py-4 text-sm text-text-secondary">
              <p className="font-semibold text-text-primary">World vs Open Class</p>
              <p>
                World Class graded at 1.58 average error, Open Class at 2.22. Open Class corps
                compete less often, so there&apos;s less recent history to anchor a forecast to.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 py-4 text-sm text-text-secondary">
              <p className="font-semibold text-text-primary">Placement, not just points</p>
              <p>
                We put a corps in exactly the right slot {fmt(s.rankExactPct, 0)}% of the time and
                were off by {fmt(s.meanRankDisp, 2)} places on average — and we called the show
                winner in {fmt(s.winnerPct, 0)}% of {s.nShows} shows.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* What's next */}
      <section className="mt-10">
        <SectionHeading title="What we're taking into next season" />
        <Card>
          <CardContent className="max-w-prose space-y-2 py-4 text-sm leading-relaxed text-text-secondary">
            <p>
              The clearest lesson of 2026 is a structural one. The <em>level</em> of a score lives
              in season dynamics — where a corps has been, how fast the field is climbing, and how
              our own recent errors are trending. That&apos;s not something a network should be
              guessing from scratch. Its job is the shape: who moves relative to whom, and
              what&apos;s left over after the structure has had its say.
            </p>
            <p>
              Every model that beat us this year did it by leaning on that structure, and every one
              that lost did it by ignoring it. The next-generation model, <strong>V13</strong>, is
              being built on exactly that split, and it will be trained on the complete 2026 season
              — including the championship-week inflation the previous generation never saw.
            </p>
            <p>
              We&apos;ll keep grading it in public. The{' '}
              <Link to="/accuracy" className="text-primary hover:underline">
                accuracy dashboard
              </Link>{' '}
              updates as shows are scored, and if a new model ever costs us points, that page will
              show it before we do.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Methodology */}
      <section className="mt-12 border-t border-border pt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-text-primary">
          How these numbers are computed
        </h2>
        <div className="mt-3 max-w-prose space-y-2 text-sm leading-relaxed text-text-muted">
          <p>
            A graded prediction is the last forecast saved <em>strictly before</em> a show&apos;s
            start time, joined to that show&apos;s official posted score for the same corps. The
            model never sees the show it&apos;s being graded on. Error is predicted total minus
            actual total; MAE is the average of its absolute value, and bias is the signed average
            (negative = we were low).
          </p>
          <p>
            Scope is World Class and Open Class only. Shadow models are scored on exactly the same
            shows and corps as the served model, which is what makes the comparison table a fair
            fight. These are AI-generated forecasts — an estimate for fun, not a guarantee.
          </p>
          <p>
            Full per-corps and per-show breakdowns live on the{' '}
            <Link to="/accuracy" className="text-primary hover:underline">
              accuracy dashboard
            </Link>
            .
          </p>
        </div>
      </section>
    </PageShell>
  );
}
