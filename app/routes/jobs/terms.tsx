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
        subtitle="PageantryJobs.com — Last updated: June 26, 2026"
        backTo="/"
        backLabel="Home"
      />
      <div className="mx-auto max-w-3xl space-y-6 text-text-secondary">
        <p>
          These Terms of Service ("Terms") are a binding agreement between you and the operator of
          PageantryJobs.com ("PageantryJobs", "we", "us"). They govern your access to and use of the
          PageantryJobs website, profiles, job board, and related services (the "Service"). By
          creating an account or otherwise using the Service, you agree to these Terms and to our{' '}
          <a href="/jobs/privacy" className="text-primary underline hover:no-underline">
            Privacy Policy
          </a>{' '}
          and{' '}
          <a href="/jobs/guidelines" className="text-primary underline hover:no-underline">
            Content Guidelines
          </a>
          . If you do not agree, do not use the Service.
        </p>

        <Section heading="1. Eligibility">
          <p>
            You must be at least 16 years old to create an account, and at least 18 to post a job or
            make a payment. By using the Service you represent that you meet these requirements and
            that the information you provide is accurate and kept up to date.
          </p>
        </Section>

        <Section heading="2. Accounts">
          <p>
            You are responsible for safeguarding your account credentials and for all activity under
            your account. Notify us promptly of any unauthorized use. We may suspend or terminate
            accounts that violate these Terms or that we reasonably believe pose a risk to the Service
            or its users.
          </p>
        </Section>

        <Section heading="3. Acceptable use">
          <p>
            You agree not to: post false, misleading, fraudulent, or discriminatory content; harvest
            or scrape data; impersonate any person or organization; send spam or unsolicited
            solicitations; upload malware; attempt to access accounts or systems without
            authorization; or use the Service in violation of any applicable law. See our{' '}
            <a href="/jobs/guidelines" className="text-primary underline hover:no-underline">
              Content Guidelines
            </a>{' '}
            for specifics.
          </p>
        </Section>

        <Section heading="4. Job listings & employers">
          <p>
            Employers are solely responsible for the content, accuracy, and legality of their job
            listings, including compliance with all applicable labor, anti-discrimination, wage, and
            advertising laws. Listings must describe genuine opportunities. We do not screen employers
            or applicants and are not a party to any employment relationship. We may edit, refuse, or
            remove any listing at our discretion.
          </p>
        </Section>

        <Section heading="5. Applications & job seekers">
          <p>
            When you apply to a listing or make your profile discoverable, you authorize us to share
            the relevant information you have provided with the applicable employer. You are
            responsible for the accuracy of your profile and application materials. We do not
            guarantee any response, interview, or hiring outcome.
          </p>
        </Section>

        <Section heading="6. Your content & license">
          <p>
            You retain ownership of the content you submit (profiles, listings, messages, uploads).
            You grant us a worldwide, non-exclusive, royalty-free license to host, store, reproduce,
            and display that content as needed to operate and promote the Service. You represent that
            you have the rights to the content you submit and that it does not infringe others' rights.
          </p>
        </Section>

        <Section heading="7. Page claims">
          <p>
            Some profiles are seeded from publicly available information. If you claim a staff or judge
            page, you represent that you are the person it describes or are authorized to act on their
            behalf. We may verify, reverse, or remove claims, and may remove a profile on request of
            the individual it identifies.
          </p>
        </Section>

        <Section heading="8. Payments & promoted listings">
          <p>
            Paid features (such as promoted or boosted listings) are billed through our third-party
            payment processor, Stripe. Fees are stated at the point of purchase. Except where required
            by law, payments are non-refundable once a paid feature has begun. You authorize us and
            Stripe to charge your selected payment method for the amounts you approve.
          </p>
        </Section>

        <Section heading="9. Intellectual property">
          <p>
            The Service, including its software, design, and branding, is owned by us or our licensors
            and is protected by intellectual-property laws. These Terms grant you no rights in our
            marks or software except the limited right to use the Service as intended.
          </p>
        </Section>

        <Section heading="10. Termination">
          <p>
            You may stop using the Service and delete your account at any time. We may suspend or
            terminate your access if you breach these Terms or to protect the Service or its users.
            Sections intended to survive termination (including content licenses already granted,
            disclaimers, limitations of liability, and indemnification) will continue to apply.
          </p>
        </Section>

        <Section heading="11. Disclaimers">
          <p>
            The Service is provided "as is" and "as available" without warranties of any kind, whether
            express or implied, including merchantability, fitness for a particular purpose, and
            non-infringement. We do not warrant the accuracy of listings or profiles, the conduct of
            any user, or that the Service will be uninterrupted or error-free. We are not responsible
            for hiring decisions or interactions between employers and job seekers.
          </p>
        </Section>

        <Section heading="12. Limitation of liability">
          <p>
            To the fullest extent permitted by law, PageantryJobs and its operators will not be liable
            for any indirect, incidental, special, consequential, or punitive damages, or any loss of
            profits, data, or goodwill, arising from your use of the Service. Our total liability for
            any claim relating to the Service will not exceed the greater of the amounts you paid us in
            the twelve months before the claim or US $100.
          </p>
        </Section>

        <Section heading="13. Indemnification">
          <p>
            You agree to indemnify and hold harmless PageantryJobs and its operators from claims,
            damages, and expenses (including reasonable legal fees) arising from your content, your use
            of the Service, or your violation of these Terms or applicable law.
          </p>
        </Section>

        <Section heading="14. Changes to these Terms">
          <p>
            We may update these Terms from time to time. Material changes will be posted here with an
            updated date and, where appropriate, notified to you. Your continued use of the Service
            after changes take effect constitutes acceptance.
          </p>
        </Section>

        <Section heading="15. Governing law">
          <p>
            These Terms are governed by the laws of the United States and the State of [STATE], without
            regard to conflict-of-laws rules. Disputes will be resolved in the state or federal courts
            located in [JURISDICTION], and you consent to their jurisdiction.
          </p>
        </Section>

        <Section heading="16. Contact">
          <p>
            Questions about these Terms? Contact us at{' '}
            <a
              href="mailto:legal@pageantryjobs.com"
              className="text-primary underline hover:no-underline"
            >
              legal@pageantryjobs.com
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
    <section>
      <h2 className="mb-3 text-xl font-semibold text-text-primary">{heading}</h2>
      {children}
    </section>
  );
}
