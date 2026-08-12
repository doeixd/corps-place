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
// AUDIENCE: a drum corps fan with zero stats background. Every number on this
// page must be translated into plain English at the point it appears — no bare
// "MAE" / "bias" / "rank displacement", and no internal model jargon
// ("shadow", "wrapper", "recal", "regression"). The numbers themselves are
// verbatim from the graded set; only the wording is editorial.
//
// LOADER PAYLOAD IS DESERIALIZED INTO THE SSR HTML, so we deliberately return
// ONLY the handful of summary numbers we render (not the full rm_accuracy
// payload, which carries per-corps/per-event/histogram arrays). The headline
// stats are read live so this page never drifts from /accuracy; the era,
// benchmark and model-comparison figures are editorial and hardcoded below.

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
        'How our 2026 DCI score predictions actually did, in plain English: 436 forecasts across ' +
        '61 shows, off by 1.67 points on average, the right winner in 4 out of 5 shows — plus the ' +
        'week we shipped a worse model, admitted it, and switched back before championships.',
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
            'A plain-English season retrospective on how our DCI score predictions performed in ' +
            '2026, including a worse model that was caught and rolled back mid-season.',
        },
      ],
    }),
  staleTime: 10 * 60_000,
  component: AccuracyReportPage,
});

const fmt = (x: number, d = 2) =>
  x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// "82%" reads as a statistic; "4 out of 5 shows" reads as a fact. Round to the
// friendliest small denominator so the sentence stays true to the percentage.
const outOfFive = (pct: number) => Math.round((pct / 100) * 5);

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
      {hint ? <p className="mt-0.5 max-w-prose text-sm text-text-muted">{hint}</p> : null}
    </div>
  );
}

// Horizontal bar row — a table of numbers is hard to feel, a bar you can see.
function BarRow({
  label,
  value,
  max,
  tone = 'primary',
  note,
}: {
  label: string;
  value: number;
  max: number;
  tone?: 'primary' | 'success' | 'warning';
  note?: string;
}) {
  const pct = Math.max(4, Math.round((value / max) * 100));
  const fill = tone === 'success' ? 'bg-success' : tone === 'warning' ? 'bg-warning' : 'bg-primary';
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-sm tabular-nums text-text-secondary">off by {fmt(value)} pts</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${fill}`} style={{ width: `${pct}%` }} />
      </div>
      {note ? <p className="text-xs text-text-muted">{note}</p> : null}
    </div>
  );
}

function Act({
  n,
  title,
  dates,
  tone,
  takeaway,
  children,
}: {
  n: number;
  title: string;
  dates: string;
  tone: 'primary' | 'warning' | 'success';
  takeaway: string;
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
        <p className="max-w-prose text-sm font-medium leading-relaxed text-text-primary">
          {takeaway}
        </p>
        <div className="max-w-prose space-y-2 text-sm leading-relaxed text-text-secondary">
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

// Side-by-side block for the rollback comparison — one model, one card, plain words.
function ModelBlock({
  name,
  status,
  served,
  mae,
  bias,
}: {
  name: string;
  status: string;
  served: boolean;
  mae: number;
  bias: number;
}) {
  return (
    <Card className={served ? 'ring-success/40' : undefined}>
      <CardContent className="space-y-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{name}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              served ? 'bg-success/15 text-success' : 'bg-muted text-text-secondary'
            }`}
          >
            {status}
          </span>
        </div>
        <p className="text-2xl font-semibold tabular-nums text-text-primary">{fmt(mae)} pts</p>
        <p className="text-sm text-text-secondary">off per prediction, on average</p>
        <p className="text-xs text-text-muted">
          {Math.abs(bias) < 0.1
            ? 'Almost no lean — misses landed evenly above and below the real score.'
            : `Guessed about ${fmt(Math.abs(bias))} pts ${bias < 0 ? 'too low' : 'too high'} on nearly every corps.`}
        </p>
      </CardContent>
    </Card>
  );
}

function GlossaryItem({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm font-medium text-text-secondary">{term}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed text-text-muted">{children}</dd>
    </div>
  );
}

function AccuracyReportPage() {
  const { stats: s } = Route.useLoaderData();
  const maxLead = Math.max(...s.leadTime.map((l) => l.mae), 0.01);

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
          Every night of the summer we published a guess at the score every corps would earn at
          every upcoming show. Then the real scores posted, and we checked our homework. This is the
          full-season report card — the good stretches, and the week we made things worse.
        </p>
      </header>

      {/* How to read this page */}
      <section className="mt-6">
        <Card>
          <CardContent className="max-w-prose space-y-2 py-4 text-sm leading-relaxed text-text-secondary">
            <p className="font-semibold text-text-primary">How to read this page</p>
            <p>
              A &ldquo;prediction&rdquo; here means the very last forecast we published before a
              show started — no peeking, no hindsight. Every number below is that forecast compared
              against the official score the corps actually earned.
            </p>
            <p>
              DCI scores run from 0 to 100, and at the top of the field corps are often separated by
              a tenth or two of a point. So being off by a point or two is decent; being off by
              three is a bad night. For the always-current version of these numbers, see the{' '}
              <Link to="/accuracy" className="text-primary hover:underline">
                live accuracy dashboard
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Headline */}
      <section className="mt-10">
        <SectionHeading
          title="How close were we?"
          hint={`Across ${s.n} predictions at ${s.nShows} shows, all season long.`}
        />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            value={`${fmt(s.mae)} pts`}
            label="Off by this much, on average"
            sub={`Across ${s.n} graded predictions`}
          />
          <StatTile
            value={`${fmt(s.within2Pct, 0)}%`}
            label="Landed within 2 points"
            sub={`${fmt(s.within1Pct, 0)}% landed within 1 point`}
          />
          <StatTile
            value={`${outOfFive(s.winnerPct)} in 5`}
            label="Shows where we picked the winner"
            sub={`${fmt(s.winnerPct, 0)}% of ${s.nShows} shows`}
          />
          <StatTile
            value={`${fmt(s.rankExactPct, 0)}%`}
            label="Corps put in exactly the right place"
            sub={`When wrong, usually just ${fmt(s.meanRankDisp, 1)} spot off`}
          />
        </div>
        <div className="mt-3 max-w-prose space-y-2 text-sm leading-relaxed text-text-muted">
          <p>
            In plain terms: our typical prediction was off by {fmt(s.mae)} points, and a typical
            miss was even smaller than that — half of all our guesses landed within{' '}
            {fmt(s.medianAbs)} points of the real score.
          </p>
          <p>
            We also leaned very slightly{' '}
            {s.bias < 0 ? (
              <>
                <strong className="text-text-secondary">low</strong> — by about{' '}
                {fmt(Math.abs(s.bias))} of a point. Corps generally scored a bit better than we
                guessed they would
              </>
            ) : (
              <>
                <strong className="text-text-secondary">high</strong> — by about{' '}
                {fmt(Math.abs(s.bias))} of a point. Corps generally scored a bit worse than we
                guessed they would
              </>
            )}
            . And when we put a corps in the wrong spot in the lineup, we were usually only about
            one placement off.
          </p>
          <p>
            This covers World Class and Open Class corps only — the ones the model is built for.
          </p>
        </div>
      </section>

      {/* Three acts */}
      <section className="mt-10">
        <SectionHeading
          title="The season in three acts"
          hint="The season-long average hides three very different stretches: a steady start, a bad week, and our best two weeks of the year."
        />
        <div className="space-y-3">
          <Act
            n={1}
            title="Steady, except for opening nights"
            dates="Through Jul 19"
            tone="primary"
            takeaway="For most of the summer we were off by about a point and a half — but a corps' very first show of the year was always a guess."
          >
            <p>
              The model that ran most of the season looks at where a corps has been scoring lately,
              how quickly the field as a whole is climbing, and how similar corps are doing, then
              nudges itself each night based on its own recent misses. Through June and early July
              that graded out at roughly 1.5 points off per prediction.
            </p>
            <p>
              The weak spot was season openers. Before a corps performs even once, there are no 2026
              scores to lean on, so the forecast falls back on last year and on comparable corps —
              and those early-June debuts are where our biggest misses of the entire year live.
            </p>
          </Act>

          <Act
            n={2}
            title="The week we made it worse"
            dates="Jul 20 – Jul 26"
            tone="warning"
            takeaway="We tested a new version, it underestimated how fast scores climb in August, and we switched back within a week."
          >
            <p>
              In late July we swapped in two newer versions of the model. Both looked better when we
              tested them against past seasons. Both were clearly worse on real, live shows.
            </p>
            <p>
              Late July is when scores rise fastest, and the new versions simply didn&apos;t keep up
              with the climb — they guessed about 3 points too low, and were off by roughly{' '}
              <strong>3.2 to 3.4 points</strong> per prediction, about double our season average.
              Because we grade ourselves every night, we spotted it within days and put the older
              model back on <strong>Jul 26</strong>.
            </p>
            <p className="text-text-primary">
              We&apos;d rather say this plainly than bury it: we shipped something worse, we caught
              it, and we undid it. The only reason we can tell you exactly what it cost is that
              every version gets graded against real posted scores, every single night.
            </p>
          </Act>

          <Act
            n={3}
            title="Championship week: our best stretch"
            dates="Jul 26 – Finals"
            tone="success"
            takeaway="With the older model back in charge, Finals night came in under six tenths of a point."
          >
            <p>
              The last two weeks were the sharpest of the year: about <strong>1.03 points</strong>{' '}
              off per prediction, with no real lean high or low. Prelims on Aug 6 came in at{' '}
              <strong>1.04</strong> across 30 corps, and Finals on Aug 8 at <strong>0.59</strong> —
              our best full show of the season.
            </p>
            <p>
              We kept the two newer versions running quietly in the background, scored on exactly
              the same shows. They stayed close to 2.9 points off the whole way. That puts a number
              on switching back: roughly <strong>1.8 points saved on every prediction</strong>{' '}
              through championships.
            </p>
          </Act>
        </div>
      </section>

      {/* Model comparison */}
      <section className="mt-10">
        <SectionHeading
          title="What switching back was worth"
          hint="The same championship-stretch shows, Jul 26 – Aug 8, graded the same way for all three versions — 120 predictions each. Only one of them was actually shown on the site."
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <ModelBlock name="final2" status="the one we used" served mae={1.03} bias={-0.04} />
          <ModelBlock name="v10.5" status="tested quietly" served={false} mae={2.86} bias={-2.68} />
          <ModelBlock name="v11" status="tested quietly" served={false} mae={2.88} bias={-2.72} />
        </div>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-text-muted">
          The giveaway is the last line on each card. The two newer versions weren&apos;t just
          scattered and unlucky — they were wrong in one direction, sitting nearly 2.7 points under
          reality on almost every corps, because they never learned how steeply scores jump during
          championship week.
        </p>
      </section>

      {/* Lead time */}
      <section className="mt-10">
        <SectionHeading
          title="Why the forecast the night before is the one to trust"
          hint="How far off we were, grouped by how many days ahead of the show the forecast was made. Longer bar = worse."
        />
        <Card>
          <CardContent className="space-y-4 py-5">
            {s.leadTime.map((l, i) => (
              <BarRow
                key={l.bucket}
                label={l.bucket === 'Same day' ? 'Day of the show' : `${l.bucket} ahead`}
                value={l.mae}
                max={maxLead}
                tone={i === 0 ? 'success' : i === s.leadTime.length - 1 ? 'warning' : 'primary'}
              />
            ))}
          </CardContent>
        </Card>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-text-muted">
          A forecast made two weeks out is worth about a point and a quarter less than the one we
          publish the night before — every show that happens in between tells us something new.
          That&apos;s the honest shelf life of a prediction on this site.
        </p>
      </section>

      {/* Details */}
      <section className="mt-10">
        <SectionHeading
          title="Which corps were hardest to predict?"
          hint="A few standouts from the graded set."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardContent className="space-y-2 py-4 text-sm leading-relaxed text-text-secondary">
              <p className="font-semibold text-text-primary">Easiest and hardest to read</p>
              <p>
                <strong>Spartans</strong> were our most predictable corps all summer — we were off
                by only 0.78 points across their 13 shows. <strong>7th Regiment</strong> were the
                toughest at 4.10 points off, and we kept guessing them about 3 points higher than
                they actually scored.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 py-4 text-sm leading-relaxed text-text-secondary">
              <p className="font-semibold text-text-primary">Our worst championship misses</p>
              <p>
                Even on our best nights we missed somebody. On Finals night our biggest single miss
                was <strong>Troopers</strong>, off by 2.15 points. At Prelims it was{' '}
                <strong>Raiders</strong>, off by 3.0.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 py-4 text-sm leading-relaxed text-text-secondary">
              <p className="font-semibold text-text-primary">World Class vs Open Class</p>
              <p>
                We were off by 1.58 points on World Class corps and 2.22 on Open Class. Open Class
                corps compete less often, so there&apos;s simply less recent evidence to base a
                forecast on.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 py-4 text-sm leading-relaxed text-text-secondary">
              <p className="font-semibold text-text-primary">Getting the order right</p>
              <p>
                Points are one thing; the lineup is another. We placed a corps in exactly the right
                spot {fmt(s.rankExactPct, 0)}% of the time, and when we got it wrong we were
                normally only one spot off. We picked the eventual winner in{' '}
                {outOfFive(s.winnerPct)} out of every 5 shows.
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
              The clearest lesson of 2026 is about the split between two questions.{' '}
              <em>Roughly what number will show up on the scoresheet?</em> is mostly a matter of
              where a corps has already been and how fast the whole field is climbing — that&apos;s
              bookkeeping, and the computer shouldn&apos;t be guessing it from scratch.{' '}
              <em>Who passes whom?</em> is the interesting part, and that&apos;s what the learned
              part of the system should be spending its effort on.
            </p>
            <p>
              Every version that beat us this year respected that split, and every version that lost
              ignored it. Our next model, <strong>V13</strong>, is built around it — and it will be
              trained on the complete 2026 season, championship-week score jumps included, which is
              exactly what the versions we rolled back had never seen.
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

      {/* Glossary */}
      <section className="mt-10">
        <Card>
          <CardContent className="py-4">
            <details className="group">
              <summary className="cursor-pointer list-none text-sm font-semibold text-text-secondary marker:hidden">
                <span className="group-open:hidden">Show the plain-English glossary</span>
                <span className="hidden group-open:inline">Plain-English glossary</span>
              </summary>
              <dl className="mt-3 max-w-prose space-y-3">
                <GlossaryItem term="Day-of prediction">
                  The last forecast we published before a show began. It&apos;s the one we grade
                  ourselves on, because it&apos;s the one fans actually read.
                </GlossaryItem>
                <GlossaryItem term="Points off (sometimes called MAE)">
                  How far our predicted score was from the real score, ignoring whether we were high
                  or low, averaged over every prediction. Lower is better. DCI scores run 0–100.
                </GlossaryItem>
                <GlossaryItem term="Running high or low (sometimes called bias)">
                  Whether our misses tend to land on one side. Being off by 2 points high and 2
                  points low averages out to zero lean; being 2 points low every time does not, and
                  that&apos;s a fixable problem rather than bad luck.
                </GlossaryItem>
                <GlossaryItem term="World Class and Open Class">
                  The two DCI competitive classes our model covers. World Class corps tour heavily;
                  Open Class corps compete less often, which makes them harder to forecast.
                </GlossaryItem>
                <GlossaryItem term="Why predictions get better closer to the show">
                  Corps change fast in July and August — new drill, cleaner performances, rising
                  judges&apos; numbers. Each show that happens gives us fresher evidence, so a
                  forecast made the night before beats one made two weeks out.
                </GlossaryItem>
              </dl>
            </details>
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
            start time, matched to that show&apos;s official posted score for the same corps. The
            model never sees the show it&apos;s being graded on. &ldquo;Points off&rdquo; is the gap
            between predicted and actual total, averaged with the direction thrown away;
            &ldquo;running high or low&rdquo; keeps the direction (negative means we guessed low).
          </p>
          <p>
            Scope is World Class and Open Class only. The versions we tested quietly in the
            background are scored on exactly the same shows and corps as the version that was
            actually shown on the site, which is what makes that comparison a fair fight. These are
            AI-generated forecasts — an estimate for fun, not a guarantee.
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
