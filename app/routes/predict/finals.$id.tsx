// Shared, read-only view of a locked prediction ballot (PREDICTION_BALLOT_PLAN
// M4). Ballots are immutable — this page (and its OG image) can never drift.
import { useState } from 'react';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { corpsLogoSource } from '@/components/corps-logo';
import { ShareButton } from '@/components/share-button';
import { FilterChips, type FilterChipItem } from '@/components/filter-chips';
import { seoHead, siteBase } from '@/lib/seo';
import { getBallot } from '@/lib/server-fns/ballot';
import { getBallotGrade } from '@/lib/server-fns/ballot-grading';
import { getRankings, getRankingSeasons } from '@/lib/server-fns/rankings';
import { track } from '@/lib/analytics/client';
import { cn } from '@/lib/utils';

const PRESET_LABELS: Record<string, string> = {
  finals: 'Finalists',
  semis: 'Semifinalists',
  world: 'World Class',
  open: 'Open Class',
  all: 'All corps',
  custom: 'Custom field',
};

export const Route = createFileRoute('/predict/finals/$id')({
  loader: async ({ params }) => {
    const ballot = await getBallot({ data: params.id }).catch(() => null);
    if (!ballot) throw notFound();
    // Live rankings for logo resolution + the "current rank" comparison column.
    // The ballot itself is self-contained (names snapshotted at lock time), so a
    // rankings failure only loses logos/deltas, never the page.
    const [{ seasons }, rankings, grade] = await Promise.all([
      getRankingSeasons().catch(() => ({ seasons: [] as string[] })),
      getRankings({
        data: { season: ballot.season, metric: 'total', agg: 'best', div: ['world', 'open'] },
      }).catch(() => null),
      // Post-finals report card; null/unavailable until the season's finals
      // recap lands, and a grading failure never loses the page.
      getBallotGrade({ data: params.id }).catch(() => null),
    ]);
    void seasons;
    return { ballot, liveRows: rankings?.rows ?? [], grade: grade?.available ? grade : null };
  },
  head: ({ loaderData, params }) => {
    const b = loaderData?.ballot;
    const title = b?.title || `${b?.season ?? ''} Finals Prediction`.trim();
    return seoHead({
      title: `${title} — Drum Corps Finals Prediction`,
      description: b
        ? `${b.displayName ? `${b.displayName}'s` : 'A'} predicted ${b.season} finals order (${
            PRESET_LABELS[b.preset] ?? b.preset
          }), locked ${new Date(b.lockedAt).toLocaleDateString()}.`
        : 'A locked drum corps finals prediction.',
      path: `/predict/finals/${params.id}`,
      image: `${siteBase().url}/api/og/ballot/${params.id}`,
    });
  },
  component: SharedBallotPage,
});

const CAPTION_LABELS: Record<string, string> = {
  GE1: 'GE 1', GE2: 'GE 2', VP: 'Visual Prof.', VA: 'Visual Anal.',
  CG: 'Color Guard', MB: 'Brass', MA: 'Music Anal.', MP: 'Percussion',
};

function SharedBallotPage() {
  const { ballot, liveRows, grade } = Route.useLoaderData();
  const { id } = Route.useParams();
  const savedCaptions = Object.keys(ballot.captions ?? {});
  const [view, setView] = useState('overall');
  const shown = view === 'overall' ? ballot.overall : (ballot.captions[view] ?? ballot.overall);
  // Post-finals only: the grade for the dimension being viewed, keyed by pick position.
  const viewGrade = grade
    ? view === 'overall'
      ? grade.overall
      : (grade.captions[view as keyof typeof grade.captions] ?? null)
    : null;

  const liveBySlug = new Map(liveRows.map((r) => [r.corpsSlug, r]));
  const currentRank = new Map(liveRows.map((r, i) => [r.corpsSlug, i + 1]));
  const lockedDate = new Date(ballot.lockedAt).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const shareUrl = `${siteBase().url}/predict/finals/${id}`;
  const title = ballot.title || `${ballot.season} Finals Prediction`;

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title={title}
        subtitle={`${ballot.displayName ? `By ${ballot.displayName} · ` : ''}Locked ${lockedDate} · ${
          PRESET_LABELS[ballot.preset] ?? ballot.preset
        } · ${ballot.season} season`}
      />

      <div className="flex flex-wrap items-center gap-3">
        <ShareButton url={shareUrl} title={`${title} — my ${ballot.season} drum corps prediction`} />
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            track('ballot_image_download');
            const res = await fetch(`/api/og/ballot/${id}`);
            const blob = await res.blob();
            const href = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = href;
            a.download = `finals-prediction-${id}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(href);
          }}
        >
          Download image
        </Button>
        <Button variant="ghost" size="sm" render={<Link to="/predict/finals" />}>
          Make your own →
        </Button>
      </div>

      {grade?.overall ? (
        <Card>
          <CardContent className="py-4">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <div>
                <div className="text-3xl font-bold tabular-nums">{grade.overall.pct}%</div>
                <div className="text-xs text-muted-foreground">prediction score</div>
              </div>
              <div className="text-sm text-text-secondary">
                <span className="font-semibold tabular-nums">{grade.overall.earned}</span>
                {' / '}
                <span className="tabular-nums">{grade.overall.possible}</span> points ·{' '}
                <span className="font-semibold tabular-nums">{grade.overall.exact}</span> exact{' '}
                {grade.overall.exact === 1 ? 'pick' : 'picks'}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                render={<Link to="/predict/results" search={{ season: ballot.season }} />}
              >
                Season results & consensus →
              </Button>
            </div>
            {Object.keys(grade.captions).length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                {Object.entries(grade.captions).map(([cap, g]) => (
                  <span
                    key={cap}
                    className="rounded-full border border-border px-2.5 py-0.5 text-xs tabular-nums text-text-secondary"
                  >
                    {CAPTION_LABELS[cap] ?? cap} {g.pct}%
                  </span>
                ))}
              </div>
            ) : null}
            <p className="mt-3 text-xs text-muted-foreground">
              Graded against the {ballot.season} World Championship results: 10 points for a corps
              placed exactly right, −3 per position off. Championships-week caption bests decide
              placements, so every competing corps counts — not just finalists.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {savedCaptions.length > 0 ? (
        <FilterChips
          ariaLabel="Prediction dimension"
          className="min-w-0"
          value={view}
          items={[
            { value: 'overall', label: 'Overall' },
            ...savedCaptions.map((c): FilterChipItem => ({ value: c, label: CAPTION_LABELS[c] ?? c })),
          ]}
          onSelect={setView}
        />
      ) : null}

      <Card>
        <CardContent className="py-4">
          <div className="space-y-0.5">
            {shown.map((entry, i) => {
              const live = liveBySlug.get(entry.slug);
              const now = currentRank.get(entry.slug);
              const delta = now !== undefined ? now - (i + 1) : 0;
              const pick = viewGrade?.picks[i]?.slug === entry.slug ? viewGrade.picks[i] : null;
              return (
                <div
                  key={entry.slug}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-2 py-1.5',
                    i % 2 === 1 && 'bg-muted/40'
                  )}
                >
                  <span className="w-6 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-text-secondary">
                    {i + 1}
                  </span>
                  <CorpsNameCell
                    name={entry.name}
                    slug={entry.slug}
                    logo={
                      live
                        ? corpsLogoSource({
                            corps_logo: live.corpsLogo ?? null,
                            corps_logo_dark: live.corpsLogoDark ?? null,
                            corps_logo_dark_url: live.corpsLogoDarkUrl ?? null,
                          })
                        : undefined
                    }
                    logoClassName="size-8 sm:size-8"
                    logoWidth={32}
                    className="min-w-0 flex-1 font-medium"
                  />
                  {pick ? (
                    <span
                      className={cn(
                        'shrink-0 text-xs tabular-nums',
                        pick.delta === 0
                          ? 'font-semibold text-success'
                          : pick.actual === null
                            ? 'text-muted-foreground'
                            : 'text-text-secondary'
                      )}
                      title={
                        pick.actual === null
                          ? 'Did not compete at championships'
                          : `Finished #${pick.actual} — ${pick.points} pts`
                      }
                    >
                      {pick.actual === null
                        ? 'DNC'
                        : pick.delta === 0
                          ? `#${pick.actual} ✓`
                          : `#${pick.actual} · ${pick.points}pt`}
                    </span>
                  ) : delta !== 0 ? (
                    <span
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                      title="Current rank vs this prediction"
                    >
                      now #{now}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
          <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
            Locked {lockedDate} — this prediction is a locked snapshot and can't be edited. “now #” shows
            where a corps sits in the live rankings today.
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}
