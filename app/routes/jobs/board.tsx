import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { seoHead, breadcrumbLd } from '@/lib/seo';
import { listJobs } from '@/lib/server-fns/jobs';
import { formatDistance } from '@/lib/geo';
import { Search01Icon, Location01Icon, Briefcase01Icon } from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/board')({
  head: () =>
    seoHead({
      title: 'Job Board — PageantryJobs',
      description:
        'Browse pageantry industry jobs — drum corps, marching band, winter guard, and indoor percussion.',
      path: '/jobs/board',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Job Board', path: '/jobs/board' },
        ]),
      ],
    }),
  validateSearch: (search): { q?: string } => ({
    q: typeof search.q === 'string' && search.q.trim() ? search.q.trim() : undefined,
  }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => listJobs({ data: { keyword: deps.q, offset: 0, limit: 20 } }),
  component: BoardPage,
});

function BoardPage() {
  const initial = Route.useLoaderData();
  const { q } = Route.useSearch();
  const [keyword, setKeyword] = useState(q ?? '');
  const [nearZip, setNearZip] = useState('');
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);

  const doSearch = async () => {
    setLoading(true);
    const results = await listJobs({
      data: { keyword: keyword || undefined, nearZip: nearZip || undefined, offset: 0, limit: 20 },
    });
    setData(results);
    setLoading(false);
  };

  const loadMore = async () => {
    setLoading(true);
    const next = await listJobs({
      data: {
        keyword: keyword || undefined,
        nearZip: nearZip || undefined,
        offset: data.rows.length,
        limit: 20,
      },
    });
    setData((prev) => ({ rows: [...prev.rows, ...next.rows], total: next.total }));
    setLoading(false);
  };

  const rows = data.rows;
  const total = data.total;
  const hasMore = rows.length < total;
  const nearest = rows.some((j) => j.distance_miles != null);

  return (
    <PageShell>
      <PageHeader title="Job Board" subtitle="PageantryJobs" backTo="/" backLabel="Home" />

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          placeholder="Search jobs by keyword…"
          className="h-11 flex-1 rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
        />
        <input
          value={nearZip}
          onChange={(e) => setNearZip(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          inputMode="numeric"
          maxLength={5}
          placeholder="Near ZIP"
          className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30 sm:w-32"
        />
        <Button onClick={doSearch} disabled={loading} variant="outline" className="h-11 px-4">
          <Icon icon={Search01Icon} size="sm" /> {loading ? '…' : 'Search'}
        </Button>
      </div>

      {rows.length === 0 && !loading ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
            <Icon icon={Search01Icon} size="xl" className="text-text-muted" />
            <p className="text-lg font-medium text-text-primary">No jobs posted yet</p>
            <p className="max-w-sm text-sm text-text-secondary">
              Be the first to post a job and find great talent in the pageantry community.
            </p>
            <Link
              to="/jobs/post"
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
            >
              Post a job
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {total} job{total !== 1 ? 's' : ''} found
            {nearest ? <span className="ml-1 text-text-secondary">· Nearest first</span> : null}
          </p>
          {rows.map((job) => {
            const salary =
              job.comp_text ||
              (job.salary_min || job.salary_max
                ? `${job.salary_min ? `$${job.salary_min.toLocaleString()}` : ''}${
                    job.salary_min && job.salary_max ? '–' : ''
                  }${job.salary_max ? `$${job.salary_max.toLocaleString()}` : ''}`
                : null);
            return (
              <Link
                key={job.posting_id}
                to="/jobs/$jobSlug"
                params={{ jobSlug: job.slug }}
                className="block focus-visible:outline-none"
              >
                <Card className="card-hover">
                  <CardContent className="flex items-start justify-between gap-4 py-5">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base font-semibold leading-snug text-text-primary">
                        {job.title}
                      </h3>
                      {job.location || job.distance_miles != null ? (
                        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-sm text-text-muted">
                          {job.location ? (
                            <span className="flex items-center gap-1">
                              <Icon icon={Location01Icon} size="xs" /> {job.location}
                            </span>
                          ) : null}
                          {job.location && job.distance_miles != null ? <span>•</span> : null}
                          {job.distance_miles != null ? (
                            <span>{formatDistance(job.distance_miles)}</span>
                          ) : null}
                        </p>
                      ) : null}
                      {job.remote_ok || salary || job.is_boosted ? (
                        <div className="mt-2.5 flex flex-wrap gap-2">
                          {job.remote_ok ? (
                            <Badge variant="secondary-light" size="sm">
                              Remote
                            </Badge>
                          ) : null}
                          {salary ? (
                            <Badge variant="success-light" size="sm">
                              {salary}
                            </Badge>
                          ) : null}
                          {job.is_boosted ? (
                            <Badge variant="warning-light" size="sm">
                              Boosted
                            </Badge>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                    <Icon
                      icon={Briefcase01Icon}
                      size="sm"
                      className="icon-shift mt-0.5 shrink-0 text-text-muted"
                    />
                  </CardContent>
                </Card>
              </Link>
            );
          })}

          {hasMore ? (
            <div className="flex justify-center pt-2">
              <Button onClick={loadMore} disabled={loading} variant="outline" size="sm">
                {loading ? 'Loading…' : `Load more (${rows.length} of ${total})`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
