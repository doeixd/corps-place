import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/privacy-policy')({
  head: () =>
    buildSeo({
      title: 'Privacy Policy',
      description: 'Privacy Policy for DrumCorps.app — how we handle your data.',
      path: '/privacy-policy',
    }),
  component: PrivacyPolicy,
});

function PrivacyPolicy() {
  return (
    <PageShell>
      <PageHeader
        title="Privacy Policy"
        subtitle="Last updated: June 17, 2026"
        backTo="/"
        backLabel="Home"
      />

      <div className="mx-auto max-w-3xl space-y-8 text-text-secondary">
        <p>
          This Privacy Policy describes how DrumCorps.app ("we", "our", or "us") collects, uses, and
          discloses information about you when you visit our website (the "Service"). By using the
          Service, you agree to the collection and use of information in accordance with this
          policy.
        </p>

        <Section heading="1. Information We Collect">
          <SubSection heading="Information You Provide">
            <p>
              We do not require you to create an account or provide personal information to browse
              the Service. If you contact us directly (for example, via email), we may receive your
              name, email address, and the content of your message.
            </p>
          </SubSection>

          <SubSection heading="Information Collected Automatically">
            <p>
              When you visit the Service, we may automatically collect certain information about
              your device and usage, including:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                <strong>Log data</strong> — your IP address, browser type, referring/exit pages,
                date and time stamps, and pages viewed.
              </li>
              <li>
                <strong>Device information</strong> — device type, operating system, and browser
                version.
              </li>
              <li>
                <strong>Usage data</strong> — how you interact with the Service, including pages
                visited, links clicked, and time spent on pages.
              </li>
            </ul>
          </SubSection>
        </Section>

        <Section heading="2. Cookies">
          <p>
            We use cookies and similar tracking technologies to provide and improve the Service.
            Cookies are small files stored on your device. We use the following types:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>
              <strong>Essential cookies</strong> — necessary for the Service to function properly
              (e.g., maintaining your session or remembering your preferences).
            </li>
            <li>
              <strong>Analytics cookies</strong> — help us understand how visitors use the Service
              so we can improve it.
            </li>
            <li>
              <strong>Third-party cookies</strong> — scripts or embedded content from third-party
              providers may set their own cookies on your device. These are governed by the
              respective third party's privacy policy and are not under our control.
            </li>
          </ul>
          <p className="mt-2">
            You can configure your browser to refuse cookies or alert you when cookies are being
            sent. However, some parts of the Service may not function properly without them.
          </p>
        </Section>

        <Section heading="3. How We Use Your Information">
          <p>We use the information we collect to:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Provide, operate, and maintain the Service.</li>
            <li>Monitor and analyze usage and trends to improve the Service.</li>
            <li>Detect, prevent, and address technical issues or abuse.</li>
            <li>Respond to your inquiries and provide customer support.</li>
          </ul>
        </Section>

        <Section heading="4. Third-Party Services and Scripts">
          <SubSection heading="Service Providers">
            <p>
              We may use third-party services to help us operate the Service (for example, hosting
              providers and analytics services). These third parties may have access to your
              information only to perform tasks on our behalf and are obligated not to disclose or
              use it for any other purpose.
            </p>
          </SubSection>

          <SubSection heading="Third-Party Scripts">
            <p>
              The Service may load scripts, pixels, or other resources from third-party providers
              (such as analytics or embedded content). These third parties may collect information
              about you, your device, and your interactions with the Service independently. Their
              collection and use of your information is governed by their own privacy policies, over
              which we have no control. We encourage you to review the privacy policies of these
              third-party providers.
            </p>
          </SubSection>

          <p className="mt-3">
            The Service is hosted on infrastructure operated by our hosting provider. Server logs
            (including IP addresses) are retained as part of normal operations. We do not sell,
            trade, or otherwise transfer your personal information to outside parties except as
            described in this policy.
          </p>
        </Section>

        <Section heading="5. Data Retention">
          <p>
            We retain automatically collected information for as long as necessary to fulfill the
            purposes described in this policy, unless a longer retention period is required or
            permitted by law. Server logs are retained for a limited period and then deleted on a
            rolling basis.
          </p>
        </Section>

        <Section heading="6. Security">
          <p>
            We take reasonable measures to protect your information from loss, theft, misuse, and
            unauthorized access, disclosure, alteration, and destruction. However, no method of
            electronic storage or transmission over the internet is 100% secure, and we cannot
            guarantee absolute security.
          </p>
        </Section>

        <Section heading="7. Children's Privacy">
          <p>
            The Service is not directed to anyone under the age of 13. We do not knowingly collect
            personal information from children under 13. If you are a parent or guardian and believe
            your child has provided us with personal information, please contact us so we can delete
            it.
          </p>
        </Section>

        <Section heading="8. Links to Other Websites">
          <p>
            The Service may contain links to external sites not operated by us (such as drum corps
            organization websites and online stores). We are not responsible for the privacy
            practices of those third-party sites. We encourage you to review the privacy policy of
            every site you visit.
          </p>
        </Section>

        <Section heading="9. Changes to This Policy">
          <p>
            We may update this Privacy Policy from time to time. We will post the revised policy on
            this page and update the "Last updated" date. Your continued use of the Service after
            any changes constitutes acceptance of the updated policy. We encourage you to review
            this page periodically.
          </p>
        </Section>

        <Section heading="10. Contact">
          <p>
            If you have any questions about this Privacy Policy, you can contact us at:{' '}
            <a
              href="mailto:privacy@drumcorps.app"
              className="text-primary underline hover:no-underline"
            >
              privacy@drumcorps.app
            </a>
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

function SubSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h3 className="mb-2 text-lg font-medium text-text-primary">{heading}</h3>
      {children}
    </div>
  );
}
