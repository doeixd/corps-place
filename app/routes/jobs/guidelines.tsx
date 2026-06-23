import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/jobs/guidelines')({
  head: () =>
    buildSeo({
      title: 'Content Guidelines — PageantryJobs',
      description: 'Content guidelines for job postings on PageantryJobs.com.',
      path: '/jobs/guidelines',
    }),
  component: JobsGuidelines,
});

function JobsGuidelines() {
  return (
    <PageShell>
      <PageHeader
        title="Content Guidelines"
        subtitle="PageantryJobs.com — Last updated: June 23, 2026"
        backTo="/"
        backLabel="Home"
      />
      <div className="mx-auto max-w-3xl space-y-6 text-text-secondary">
        <p className="rounded-lg border border-warning/30 bg-warning-muted/30 px-4 py-3 text-sm text-warning-foreground">
          These guidelines are a work in progress and will be finalized before public launch.
        </p>

        <Section heading="Job Posting Guidelines">
          <p>All job postings must:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Accurately describe the position and its requirements.</li>
            <li>Include a valid contact method or application link.</li>
            <li>Be relevant to the pageantry arts (drum corps, marching band, winter guard, indoor percussion, or related fields).</li>
            <li>Not discriminate based on race, gender, age, religion, or other protected characteristics.</li>
          </ul>
        </Section>

        <Section heading="Prohibited Content">
          <p>The following are not permitted:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Fraudulent or misleading listings.</li>
            <li>Jobs that require upfront payment from applicants.</li>
            <li>Content that violates applicable law.</li>
            <li>Spam, chain letters, or pyramid schemes.</li>
          </ul>
        </Section>

        <Section heading="Enforcement">
          <p>
            Listings that violate these guidelines may be removed and the posting account may be
            suspended. Users can report violations via the flag/report function on each listing.
          </p>
        </Section>
      </div>
    </PageShell>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-xl font-semibold text-text-primary">{heading}</h2>
      {children}
    </section>
  );
}
