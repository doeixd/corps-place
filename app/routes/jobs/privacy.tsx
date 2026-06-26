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
        subtitle="PageantryJobs.com — Last updated: June 26, 2026"
        backTo="/"
        backLabel="Home"
      />
      <div className="mx-auto max-w-3xl space-y-6 text-text-secondary">
        <p>
          This Privacy Policy explains how PageantryJobs.com ("PageantryJobs", "we", "us") collects,
          uses, and shares information about you when you use our website, profiles, and job board (the
          "Service"). By using the Service, you agree to this Policy and our{' '}
          <a href="/jobs/terms" className="text-primary underline hover:no-underline">
            Terms of Service
          </a>
          .
        </p>

        <Section heading="1. Information we collect">
          <p>We collect:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong>Account information</strong> — your name and email address, provided when you
              sign in.
            </li>
            <li>
              <strong>Profile &amp; résumé content</strong> — anything you add to your profile,
              including work history, education, skills, availability, links, and files (such as
              résumés) you upload.
            </li>
            <li>
              <strong>Job-board activity</strong> — listings you post, applications you submit, saved
              searches and alerts, bookmarks, and messages.
            </li>
            <li>
              <strong>Payment information</strong> — processed by our payment provider, Stripe. We do
              not store full card numbers; we receive limited transaction details.
            </li>
            <li>
              <strong>Usage &amp; device data</strong> — basic technical information such as IP
              address, browser type, and pages viewed, used to operate and secure the Service.
            </li>
          </ul>
        </Section>

        <Section heading="2. How we use information">
          <p>
            We use information to operate and improve the Service; create and display profiles and
            listings; match job seekers and employers; send transactional emails (such as application
            and saved-search alert notifications); process payments; prevent fraud and abuse; and
            comply with legal obligations.
          </p>
        </Section>

        <Section heading="3. How we share information">
          <p>We share information only as needed to run the Service:</p>
          <ul className="ml-5 list-disc space-y-1">
            <li>
              <strong>With employers</strong> — when you apply to a listing or make your profile
              discoverable, the employer can see the relevant information you provided.
            </li>
            <li>
              <strong>With service providers</strong> — including Stripe (payments), Resend (email
              delivery), and our hosting provider, who process data on our behalf under contract.
            </li>
            <li>
              <strong>For legal &amp; safety reasons</strong> — to comply with law, enforce our Terms,
              or protect the rights and safety of users and the public.
            </li>
          </ul>
          <p>
            We do <strong>not</strong> sell your personal information.
          </p>
        </Section>

        <Section heading="4. Public profiles">
          <p>
            Some profiles are seeded from publicly available information about staff and judges in the
            pageantry and marching-arts community. Profile content you publish, and information you
            make discoverable, may be visible to other users and indexed by search engines. You can
            edit your visibility, and the individual a profile identifies may request its correction or
            removal.
          </p>
        </Section>

        <Section heading="5. Cookies">
          <p>
            We use cookies and similar technologies that are necessary to keep you signed in and to
            operate the Service. You can control cookies through your browser settings, though some
            features may not work without them.
          </p>
        </Section>

        <Section heading="6. Data retention">
          <p>
            We retain your information for as long as your account is active or as needed to provide
            the Service, comply with legal obligations, resolve disputes, and enforce our agreements.
            When you delete your account, we delete or de-identify your personal information except
            where retention is required by law.
          </p>
        </Section>

        <Section heading="7. Your rights & choices">
          <p>
            You can access and update most of your information directly in your profile. You may
            unsubscribe from non-essential emails using the link in those emails or by adjusting your
            notification preferences. Depending on where you live (for example, under GDPR or the
            CCPA), you may have rights to access, correct, delete, or port your personal information,
            or to object to certain processing. To exercise these rights, contact us at the address
            below.
          </p>
        </Section>

        <Section heading="8. Security">
          <p>
            We use reasonable technical and organizational measures to protect your information. No
            method of transmission or storage is completely secure, however, and we cannot guarantee
            absolute security.
          </p>
        </Section>

        <Section heading="9. Children">
          <p>
            The Service is not directed to children under 16, and we do not knowingly collect personal
            information from them. If you believe a child has provided us information, contact us and
            we will delete it.
          </p>
        </Section>

        <Section heading="10. Changes to this Policy">
          <p>
            We may update this Policy from time to time. Material changes will be posted here with an
            updated date. Your continued use of the Service after changes take effect constitutes
            acceptance.
          </p>
        </Section>

        <Section heading="11. Contact">
          <p>
            Questions or privacy requests? Contact us at{' '}
            <a
              href="mailto:privacy@pageantryjobs.com"
              className="text-primary underline hover:no-underline"
            >
              privacy@pageantryjobs.com
            </a>
            .
          </p>
        </Section>
      </div>
    </PageShell>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="mb-3 text-xl font-semibold text-text-primary">{heading}</h2>
      {children}
    </section>
  );
}
