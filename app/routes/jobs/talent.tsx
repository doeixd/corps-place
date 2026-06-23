import { createFileRoute, Link } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';
import { Search01Icon } from '@/components/icons/generated';

export const Route = createFileRoute('/jobs/talent')({
  head: () =>
    buildSeo({
      title: 'Talent Search — PageantryJobs',
      description: 'Find pageantry industry professionals.',
      path: '/jobs/talent',
      noindex: true,
    }),
  component: TalentPage,
});

function TalentPage() {
  return (
    <PageShell>
      <PageHeader title="Talent Search" subtitle="PageantryJobs" backTo="/" backLabel="Home" />
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
          <Icon icon={Search01Icon} size="xl" className="text-text-muted" />
          <p className="text-lg font-medium text-text-primary">Talent search coming soon</p>
          <p className="max-w-sm text-sm text-text-secondary">
            Search for professionals by location, skills, and experience. Create an employer profile
            to get started.
          </p>
          <Link to="/jobs/me" className="text-sm text-primary underline hover:no-underline">
            Set up your employer profile
          </Link>
        </CardContent>
      </Card>
    </PageShell>
  );
}
