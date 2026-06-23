import { createFileRoute, Link } from '@tanstack/react-router';
import { useActionState } from 'react';
import { useSession } from '@/lib/auth-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { searchTalent } from '@/lib/server-fns/jobs';
import { Search01Icon, UserMultipleIcon, MapPin01Icon } from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/talent')({
  head: () =>
    buildSeo({
      title: 'Talent Search — PageantryJobs',
      description: 'Find pageantry industry professionals.',
      path: '/jobs/talent',
      noindex: true,
    }),
  loader: async () => searchTalent({ offset: 0, limit: 20 }),
  component: TalentPage,
});

function TalentPage() {
  const { data: session } = useSession();
  const initial = Route.useLoaderData();

  const [state, fetchMore, isPending] = useActionState(
    async (prev: typeof initial) => {
      const next = await searchTalent({ offset: prev.rows.length, limit: 20 });
      return { rows: [...prev.rows, ...next.rows], total: next.total };
    },
    initial ?? { rows: [], total: 0 }
  );

  const rows = state?.rows ?? [];
  const total = state?.total ?? 0;
  const hasMore = rows.length < total;

  if (!session) {
    return (
      <PageShell>
        <PageHeader title="Talent Search" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
        <Card>
          <CardContent className="py-12 text-center text-text-secondary">
            Sign in to search talent.
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader title="Talent Search" subtitle="PageantryJobs" backTo="/" backLabel="Home" />

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
                    {p.location ? (
                      <p className="flex items-center gap-1 text-xs text-text-muted">
                        <Icon icon={MapPin01Icon} size="xs" /> {p.location}
                      </p>
                    ) : null}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>

          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button onClick={fetchMore} disabled={isPending} variant="outline" size="sm">
                {isPending ? 'Loading…' : `Load more (${rows.length} of ${total})`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
