import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { Search01Icon } from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/board')({
  head: () =>
    buildSeo({
      title: 'Job Board — PageantryJobs',
      description: 'Browse pageantry industry jobs.',
      path: '/jobs/board',
    }),
  component: BoardPage,
});

function BoardPage() {
  return (
    <PageShell>
      <PageHeader title="Job Board" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
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
    </PageShell>
  );
}
