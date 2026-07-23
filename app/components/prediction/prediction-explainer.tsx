import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/**
 * Short prediction disclaimer + a "Learn more" link that opens a dialog explaining
 * the model, what's on the page, and what every control (rolling, scenarios,
 * windows, ranges, filters) does.
 */
export function PredictionExplainer({
  className,
  lead,
}: {
  className?: string;
  /** View-specific sentence rendered before the disclaimer (what the active
   *  Prediction/Diff tab is showing). */
  lead?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <p className="max-w-prose text-xs leading-relaxed text-text-muted">
        {lead ? <>{lead} </> : null}
        AI-generated forecast — an estimate, not a guarantee.{' '}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="underline underline-offset-2 transition-colors hover:text-text-secondary"
        >
          Learn more
        </button>
        {' · '}
        <Link
          to="/accuracy"
          className="underline underline-offset-2 transition-colors hover:text-text-secondary"
        >
          How accurate?
        </Link>
      </p>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogTitle>How these predictions work</DialogTitle>
          <div className="space-y-4 text-sm leading-relaxed text-text-secondary">
            <p>
              This page shows a machine-learning forecast of how each corps is likely to score at
              this competition. It&apos;s built only from results that happened <em>before</em> the
              show, so it never peeks at the real outcome — an estimate for fun, not a guarantee.
            </p>

            <Section title="The model">
              A neural network (an LSTM sequence model) reads each corps&apos; recent competition
              history — their last 15 shows — plus the context of this event. It predicts every
              judged caption (General Effect, Visual, Music…), then adds them into category and
              total scores. Rather than guess a raw number, it predicts how far each corps will move
              from its own recent-form baseline, which keeps forecasts stable as the season builds.
            </Section>

            <Section title="What it learns from">
              Each corps&apos; and judge&apos;s strength ratings (Elo), season-to-date rank, recent
              score trends, division, and who&apos;s on the judging panel — all computed &ldquo;as
              of&rdquo; the show date so there&apos;s no hindsight. It&apos;s trained on years of
              real recap data: every caption score from past seasons.
            </Section>

            <Section title="The views">
              <b>Prediction</b> is the model&apos;s forecast. <b>Scores</b> shows the actual results
              once they&apos;re posted. <b>Diff</b> lines the forecast up against the real scores so
              you can see where the model was right or wrong.
            </Section>

            <Section title="Rolling &amp; scenarios">
              The forecast is the single most-likely outcome — but real competitions have
              randomness. Hit <b>Roll</b> to generate a <b>scenario</b>: one plausible alternate
              result, sampled from each caption&apos;s range of uncertainty. The <b>window</b> sets
              how wild the rolls get — <b>Likely</b> (small swings), <b>Possible</b> (medium),{' '}
              <b>Unlikely</b> (big upsets). Every roll has a <b>seed</b> saved in the page URL, so
              you can share or revisit the exact same scenario; <b>Reset</b> returns to the base
              forecast.
            </Section>

            <Section title="Other controls">
              <b>Ranges</b> shows each prediction&apos;s uncertainty band. <b>Sort</b> reorders by a
              caption or by total. <b>Group by class</b> splits World/Open. <b>Full recap</b>{' '}
              expands the caption-by-caption breakdown, and the <b>class filters</b> narrow to a
              division.
            </Section>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-primary">
        {title}
      </h3>
      <p>{children}</p>
    </div>
  );
}
