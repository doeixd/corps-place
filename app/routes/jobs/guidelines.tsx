import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/jobs/guidelines')({
  head: () =>
    buildSeo({
      title: 'Content Guidelines — PageantryJobs',
      description: 'Content Guidelines for PageantryJobs.com.',
      path: '/jobs/guidelines',
    }),
  component: JobsGuidelines,
});

function JobsGuidelines() {
  return (
    <PageShell>
      <PageHeader
        title="Content Guidelines"
        subtitle="PageantryJobs.com — Last updated: June 26, 2026"
        backTo="/"
        backLabel="Home"
      />
      <div className="mx-auto max-w-3xl space-y-6 text-text-secondary">
        <p>
          PageantryJobs is a professional community for the pageantry and marching-arts activity.
          These Guidelines keep it useful and trustworthy. They apply to everything you post —
          listings, profiles, messages, and uploads — and are part of our{' '}
          <a href="/jobs/terms" className="text-primary underline hover:no-underline">
            Terms of Service
          </a>
          . Violations may result in content removal or account suspension.
        </p>

        <Section heading="Be accurate and honest">
          <p>
            Post real opportunities and truthful information. Job listings must describe genuine
            positions with accurate details. Profiles must represent your own experience. Don't
            misrepresent compensation, requirements, or your identity.
          </p>
        </Section>

        <Section heading="No discrimination">
          <p>
            Listings and conduct must comply with all applicable anti-discrimination and equal-
            employment laws. Do not post content that excludes or discriminates against people based on
            race, color, religion, sex, gender identity, sexual orientation, national origin, age,
            disability, or any other legally protected characteristic.
          </p>
        </Section>

        <Section heading="No spam, scams, or fraud">
          <p>
            No unsolicited advertising, repetitive posting, fake listings, pay-to-work or "pay us
            first" schemes, multi-level-marketing recruitment, phishing, or requests for money or
            sensitive financial information from applicants.
          </p>
        </Section>

        <Section heading="Respect privacy and consent">
          <p>
            Do not post other people's private or personal information without permission. Only claim a
            staff or judge page if you are that person or are authorized to act for them. If a profile
            describes you and you want it corrected or removed, contact us.
          </p>
        </Section>

        <Section heading="Be professional and respectful">
          <p>
            No harassment, hate speech, threats, sexually explicit content, or attacks on individuals
            or groups. Treat employers, applicants, and community members with respect.
          </p>
        </Section>

        <Section heading="Keep it legal and on-topic">
          <p>
            Don't post content that is illegal, infringes intellectual-property or other rights,
            contains malware, or is unrelated to pageantry / marching-arts employment and the
            community.
          </p>
        </Section>

        <Section heading="Reporting and enforcement">
          <p>
            If you see content that violates these Guidelines, use the report option on the listing or
            profile, or email{' '}
            <a
              href="mailto:trust@pageantryjobs.com"
              className="text-primary underline hover:no-underline"
            >
              trust@pageantryjobs.com
            </a>
            . We review reports and may edit or remove content, and suspend or terminate accounts, at
            our discretion. We may also act on content proactively.
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
