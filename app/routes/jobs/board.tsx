import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useActionState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { listJobs } from '@/lib/server-fns/jobs';
import { Search01Icon, MapPin01Icon, Briefcase01Icon } from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/board')({
  head: () =>
    buildSeo({
      title: 'Job Board — PageantryJobs',
      description: 'Browse pageantry industry jobs.',
      path: '/jobs/board',
    }),
  loader: async () => listJobs({ offset: 0, limit: 20 }),
  component: BoardPage,
});

function BoardPage() {
  const initial = Route.useLoaderData();
  const [keyword, setKeyword] = useState('');
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);

  const doSearch = async () => {
    setLoading(true);
    const results = await listJobs({ keyword: keyword || undefined, offset: 0, limit: 20 });
    setData(results);
    setLoading(false);
  };

  const loadMore = async () => {
    setLoading(true);
    const next = await listJobs({
      keyword: keyword || undefined,
      offset: data.rows.length,
      limit: 20,
    });
    setData((prev) => ({ rows: [...prev.rows, ...next.rows], total: next.total }));
    setLoading(false);
  };

  const rows = data.rows;
  const total = data.total;
  const hasMore = rows.length < total;

  return (
    <PageShell>
      <PageHeader title="Job Board" subtitle="PageantryJobs" backTo="/" backLabel="Home" />

      <div className="flex gap-2">
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          placeholder="Search jobs by keyword…"
          className="flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/30"
        />
        <Button onClick={doSearch} disabled={loading} variant="outline" size="sm">
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
          </p>
          {rows.map((job) => (
            <Link
              key={job.posting_id}
              to="/jobs/$jobSlug"
              params={{ jobSlug: job.slug }}
              className="block focus-visible:outline-none"
            >
              <Card className="card-hover">
                <CardContent className="flex items-start justify-between gap-4 py-4">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-text-primary">{job.title}</h3>
                    {job.location ? (
                      <p className="mt-0.5 flex items-center gap-1 text-sm text-text-secondary">
                        <Icon icon={MapPin01Icon} size="xs" /> {job.location}
                      </p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      {job.remote_ok ? (
                        <Badge variant="secondary-light" size="sm">
                          Remote
                        </Badge>
                      ) : null}
                      {job.is_boosted ? (
                        <Badge variant="warning-light" size="sm">
                          Boosted
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <Icon icon={Briefcase01Icon} size="sm" className="shrink-0 text-text-muted" />
                </CardContent>
              </Card>
            </Link>
          ))}

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
