// Post-finals season results (M5): community consensus vs actual championship
// placements, plus the graded-ballot leaderboard. Empty-but-friendly before the
// finals recap lands — the loader's `available` flag drives the pre-finals copy.
import { createFileRoute, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { seoHead } from '@/lib/seo';
import { getSeasonResults } from '@/lib/server-fns/ballot-grading';
import { getRankingSeasons } from '@/lib/server-fns/rankings';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/predict/results')({
  validateSearch: (s: Record<string, unknown>) => {
    // The router decodes numeric-looking params as numbers (see router.tsx) —
    // coerce before validating so ?season=2025 survives.
    const raw = typeof s.season === 'number' ? String(s.season) : s.season;
    return { season: typeof raw === 'string' && /^\d{4}$/.test(raw) ? raw : undefined };
  },
  loaderDeps: ({ search }) => ({ season: search.season }),
  loader: async ({ deps }) => {
    const { seasons } = await getRankingSeasons().catch(() => ({ seasons: [] as string[] }));
    const season = deps.season ?? seasons[0] ?? String(new Date().getFullYear());
    const results = await getSeasonResults({ data: season }).catch(() => null);
    return {
      season,
      results: results ?? {
        available: false,
        season,
        ballotCount: 0,
        consensus: [],
        leaderboard: [],
      },
    };
  },
  head: ({ loaderData }) =>
    seoHead({
      title: `${loaderData?.season ?? ''} Prediction Results — DrumCorps.app`.trim(),
      description:
        'How the community predicted the DCI World Championship — consensus picks, actual placements, and the most accurate ballots.',
      path: '/predict/results',
    }),
  component: ResultsPage,
});

function ResultsPage() {
  const { season, results } = Route.useLoaderData();

  if (!results.available) {
    return (
      <PageShell className="flex flex-col gap-5">
        <PageHeader
          title={`${season} Prediction Results`}
          subtitle="Grades land when the World Championship Finals recap does."
        />
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            <p>
              The {season} championships haven't been scored yet. Once the Finals recap is in, every
              locked ballot gets graded here — and you'll see how the community called it.
            </p>
            <Button className="mt-4" render={<Link to="/predict/finals" />}>
              Lock in your prediction
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title={`${season} Prediction Results`}
        subtitle={`${results.ballotCount} locked ${
          results.ballotCount === 1 ? 'ballot' : 'ballots'
        } graded against the ${season} World Championship.`}
      />

      {results.leaderboard.length > 0 ? (
        <Card>
          <CardContent className="py-4">
            <h2 className="mb-3 text-sm font-semibold">Most accurate ballots</h2>
            <div className="space-y-0.5">
              {results.leaderboard.map((b, i) => (
                <Link
                  key={b.ballotId}
                  to="/predict/finals/$id"
                  params={{ id: b.ballotId }}
                  className={cn(
                    'flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/60',
                    i % 2 === 1 && 'bg-muted/40'
                  )}
                >
                  <span className="w-6 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-text-secondary">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {b.title || `${season} prediction`}
                    {b.displayName ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        by {b.displayName}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {b.exact} exact
                  </span>
                  <span className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {b.pct}%
                  </span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {results.consensus.length > 0 ? (
        <Card>
          <CardContent className="py-4">
            <h2 className="mb-1 text-sm font-semibold">Community consensus vs reality</h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Median predicted position across all {results.ballotCount} ballots, next to the actual
              championship placement.
            </p>
            <div className="space-y-0.5">
              {results.consensus.slice(0, 30).map((row, i) => {
                const miss =
                  row.actual === null ? null : Math.round((row.actual - (i + 1)) * 10) / 10;
                return (
                  <div
                    key={row.slug}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-2 py-1.5',
                      i % 2 === 1 && 'bg-muted/40'
                    )}
                  >
                    <span className="w-6 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-text-secondary">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                    <span
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                      title={`In ${row.appearances} ${row.appearances === 1 ? 'ballot' : 'ballots'}`}
                    >
                      med {row.medianPredicted}
                    </span>
                    <span
                      className={cn(
                        'w-16 shrink-0 text-right text-sm tabular-nums',
                        miss === 0 ? 'font-semibold text-success' : 'text-text-secondary'
                      )}
                    >
                      {row.actual === null ? 'DNC' : `#${row.actual}${miss === 0 ? ' ✓' : ''}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No ballots were locked for the {season} season.
          </CardContent>
        </Card>
      )}
    </PageShell>
  );
}
