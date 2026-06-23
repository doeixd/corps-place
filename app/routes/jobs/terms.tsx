import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/jobs/terms')({
  head: () =>
    buildSeo({
      title: 'Terms of Service — PageantryJobs',
      description: 'Terms of Service for PageantryJobs.com.',
      path: '/jobs/terms',
    }),
  component: JobsTerms,
});

function JobsTerms() {
  return (
    <PageShell>
      <PageHeader
        title="Terms of Service"
        subtitle="PageantryJobs.com — Last updated: June 23, 2026"
        backTo="/"
        backLabel="Home"
      />
      <div className="mx-auto max-w-3xl space-y-6 text-text-secondary">
        <p>
          These Terms of Service ("Terms") govern your use of the PageantryJobs website and
          services (the "Service"). By using the Service, you agree to these Terms.
        </p>
        <p className="rounded-lg border border-warning/30 bg-warning-muted/30 px-4 py-3 text-sm text-warning-foreground">
          These terms are a work in progress and will be finalized before public launch.
          They are provided as a placeholder for legal review.
        </p>

        <Section heading="1. Accounts">
          <p>
            You are responsible for maintaining the confidentiality of your account and for all
            activities that occur under your account. You must provide accurate information when
            creating your account.
          </p>
        </Section>

        <Section heading="2. Job Listings">
          <p>
            Employers are responsible for the accuracy of their job listings. Prohibited content
            includes discriminatory postings, fraudulent listings, and any content that violates
            applicable law. PageantryJobs reserves the right to remove listings that violate these
            Terms.
          </p>
        </Section>

        <Section heading="3. User Conduct">
          <p>
            You agree not to misuse the Service, including by impersonating others, submitting
            false information, or engaging in any activity that disrupts the Service.
          </p>
        </Section>

        <Section heading="4. Limitation of Liability">
          <p>
            The Service is provided "as is" without warranties of any kind. PageantryJobs is not
            responsible for the accuracy of job listings, the conduct of employers or applicants,
            or any hiring decisions made through the Service.
          </p>
        </Section>

        <Section heading="5. Contact">
          <p>
            For questions about these Terms, contact us at{' '}
            <a href="mailto:legal@pageantryjobs.com" className="text-primary underline hover:no-underline">
              legal@pageantryjobs.com
            </a>.
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
