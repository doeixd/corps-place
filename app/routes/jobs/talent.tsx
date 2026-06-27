import { createFileRoute, Link } from '@tanstack/react-router';
import { useActionState, useState } from 'react';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { searchTalent } from '@/lib/server-fns/jobs';
import { formatDistance } from '@/lib/geo';
import { Search01Icon, UserMultipleIcon, Location01Icon } from '@/components/icons/generated';
import { JobsSignInGate } from '@/components/jobs/sign-in-gate';

export const Route = createFileRoute('/jobs/talent')({
  head: () =>
    buildSeo({
      title: 'Talent Search — PageantryJobs',
      description: 'Find pageantry industry professionals.',
      path: '/jobs/talent',
      noindex: true,
    }),
  loader: async () => searchTalent({ data: { offset: 0, limit: 20 } }),
  component: TalentPage,
});

function TalentPage() {
  const { data: session } = useSession();
  const initial = Route.useLoaderData();
  const [nearZip, setNearZip] = useState('');

  const [state, runSearch, isPending] = useActionState(
    async (prev: typeof initial, action: 'search' | 'more') => {
      const offset = action === 'more' ? prev.rows.length : 0;
      const next = await searchTalent({ data: { nearZip: nearZip || undefined, offset, limit: 20 } });
      return action === 'more'
        ? { rows: [...prev.rows, ...next.rows], total: next.total }
        : next;
    },
    initial ?? { rows: [], total: 0 }
  );

  const rows = state?.rows ?? [];
  const total = state?.total ?? 0;
  const hasMore = rows.length < total;
  const nearest = rows.some((p: any) => p.distance_miles != null);

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="Talent Search" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
        <JobsSignInGate icon={UserMultipleIcon} title="Search talent" path="/jobs/talent" />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader title="Talent Search" subtitle="PageantryJobs" backTo="/" backLabel="Home" />

      <form
        action={() => runSearch('search')}
        className="mb-4 mt-4 flex flex-col gap-2 sm:flex-row"
      >
        <input
          value={nearZip}
          onChange={(e) => setNearZip(e.target.value)}
          inputMode="numeric"
          maxLength={5}
          placeholder="Near ZIP"
          className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 sm:w-40"
        />
        <Button type="submit" disabled={isPending} variant="outline" className="h-11 px-4">
          <Icon icon={Search01Icon} size="sm" /> {isPending ? '…' : 'Search'}
        </Button>
      </form>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={Search01Icon} size="xl" className="text-text-muted" />
            <p className="text-lg font-medium text-text-primary">No talent found</p>
            <p className="max-w-sm text-sm text-text-secondary">
              No published employee profiles match your criteria yet.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {total} professional{total !== 1 ? 's' : ''} found
            {nearest ? <span className="ml-1 text-text-secondary">· Nearest first</span> : null}
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((p) => (
              <Link
                key={p.profile_id}
                to="/jobs/profile/$slug"
                params={{ slug: p.slug }}
                className="block focus-visible:outline-none"
              >
                <Card className="card-hover h-full">
                  <CardContent className="flex flex-col gap-3 py-4">
                    <div className="flex items-center gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                        {p.display_name.charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold text-text-primary">{p.display_name}</p>
                        {p.headline ? (
                          <p className="truncate text-sm text-text-secondary">{p.headline}</p>
                        ) : null}
                      </div>
                    </div>
                    {p.location || p.distance_miles != null ? (
                      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-muted">
                        {p.location ? (
                          <span className="flex items-center gap-1">
                            <Icon icon={Location01Icon} size="xs" /> {p.location}
                          </span>
                        ) : null}
                        {p.location && p.distance_miles != null ? <span>•</span> : null}
                        {p.distance_miles != null ? (
                          <span>{formatDistance(p.distance_miles)}</span>
                        ) : null}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>

          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button onClick={() => runSearch('more')} disabled={isPending} variant="outline" size="sm">
                {isPending ? 'Loading…' : `Load more (${rows.length} of ${total})`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
