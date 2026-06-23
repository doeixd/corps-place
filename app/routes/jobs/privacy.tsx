import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/jobs/privacy')({
  head: () =>
    buildSeo({
      title: 'Privacy Policy — PageantryJobs',
      description: 'Privacy Policy for PageantryJobs.com.',
      path: '/jobs/privacy',
    }),
  component: JobsPrivacy,
});

function JobsPrivacy() {
  return (
    <PageShell>
      <PageHeader
        title="Privacy Policy"
        subtitle="PageantryJobs.com — Last updated: June 23, 2026"
        backTo="/"
        backLabel="Home"
      />
      <div className="mx-auto max-w-3xl space-y-6 text-text-secondary">
        <p>
          This Privacy Policy describes how PageantryJobs ("we", "our", or "us") collects, uses,
          and discloses information about you when you use our website (the "Service").
        </p>
        <p className="rounded-lg border border-warning/30 bg-warning-muted/30 px-4 py-3 text-sm text-warning-foreground">
          These terms are a work in progress and will be finalized before public launch.
          They are provided as a placeholder for legal review.
        </p>

        <Section heading="1. Information We Collect">
          <p>
            We collect information you provide when creating a profile, posting a job, or applying
            for a position. This includes your name, email address, work history, skills, and any
            other information you choose to share.
          </p>
        </Section>

        <Section heading="2. How We Use Your Information">
          <p>
            We use your information to operate the Service, facilitate job applications, and
            communicate with you about the Service. We do not sell your personal information to
            third parties.
          </p>
        </Section>

        <Section heading="3. Data Retention and Deletion">
          <p>
            You may request deletion of your account and associated personal data by contacting us.
            We will process deletion requests within 30 days. Audit logs may be retained with
            personal information removed.
          </p>
        </Section>

        <Section heading="4. Contact">
          <p>
            For questions about this Privacy Policy, contact us at{' '}
            <a href="mailto:privacy@pageantryjobs.com" className="text-primary underline hover:no-underline">
              privacy@pageantryjobs.com
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
