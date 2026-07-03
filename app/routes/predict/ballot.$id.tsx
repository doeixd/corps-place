// Shared, read-only view of a locked prediction ballot (PREDICTION_BALLOT_PLAN
// M4). Ballots are immutable — this page (and its OG image) can never drift.
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { corpsLogoSource } from '@/components/corps-logo';
import { ShareButton } from '@/components/share-button';
import { seoHead, siteBase } from '@/lib/seo';
import { getBallot } from '@/lib/server-fns/ballot';
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

export const Route = createFileRoute('/predict/ballot/$id')({
  loader: async ({ params }) => {
    const ballot = await getBallot({ data: params.id }).catch(() => null);
    if (!ballot) throw notFound();
    // Live rankings for logo resolution + the "current rank" comparison column.
    // The ballot itself is self-contained (names snapshotted at lock time), so a
    // rankings failure only loses logos/deltas, never the page.
    const [{ seasons }, rankings] = await Promise.all([
      getRankingSeasons().catch(() => ({ seasons: [] as string[] })),
      getRankings({
        data: { season: ballot.season, metric: 'total', agg: 'best', div: ['world', 'open'] },
      }).catch(() => null),
    ]);
    void seasons;
    return { ballot, liveRows: rankings?.rows ?? [] };
  },
  head: ({ loaderData, params }) => {
    const b = loaderData?.ballot;
    const title = b?.title || `${b?.season ?? ''} Finals Prediction`.trim();
    return seoHead({
      title: `${title} — Prediction Ballot`,
      description: b
        ? `${b.displayName ? `${b.displayName}'s` : 'A'} predicted ${b.season} finals order (${
            PRESET_LABELS[b.preset] ?? b.preset
          }), locked ${new Date(b.lockedAt).toLocaleDateString()}.`
        : 'A locked drum corps prediction ballot.',
      path: `/predict/ballot/${params.id}`,
      image: `${siteBase().url}/api/og/ballot/${params.id}`,
    });
  },
  component: SharedBallotPage,
});

function SharedBallotPage() {
  const { ballot, liveRows } = Route.useLoaderData();
  const { id } = Route.useParams();

  const liveBySlug = new Map(liveRows.map((r) => [r.corpsSlug, r]));
  const currentRank = new Map(liveRows.map((r, i) => [r.corpsSlug, i + 1]));
  const lockedDate = new Date(ballot.lockedAt).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const shareUrl = `${siteBase().url}/predict/ballot/${id}`;
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
            a.download = `prediction-ballot-${id}.png`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(href);
          }}
        >
          Download image
        </Button>
        <Button variant="ghost" size="sm" render={<Link to="/predict/ballot" />}>
          Make your own →
        </Button>
      </div>

      <Card>
        <CardContent className="py-4">
          <div className="space-y-0.5">
            {ballot.overall.map((entry, i) => {
              const live = liveBySlug.get(entry.slug);
              const now = currentRank.get(entry.slug);
              const delta = now !== undefined ? now - (i + 1) : 0;
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
                    className="min-w-0 flex-1 font-medium"
                  />
                  {delta !== 0 ? (
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
            Locked {lockedDate} — this ballot is a snapshot and can't be edited. “now #” shows
            where a corps sits in the live rankings today.
          </p>
        </CardContent>
      </Card>
    </PageShell>
  );
}
