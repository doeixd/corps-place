import { createFileRoute } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { buildSeo } from '@/lib/seo';

export const Route = createFileRoute('/terms-of-service')({
  head: () =>
    buildSeo({
      title: 'Terms of Service',
      description: 'Terms of Service for DrumCorps.app — rules for using the site.',
      path: '/terms-of-service',
    }),
  component: TermsOfService,
});

function TermsOfService() {
  return (
    <PageShell>
      <PageHeader
        title="Terms of Service"
        subtitle="Last updated: June 29, 2026"
        backTo="/"
        backLabel="Home"
      />

      <div className="mx-auto max-w-3xl space-y-8 text-text-secondary">
        <p>
          These Terms of Service ("Terms") govern your use of DrumCorps.app (the "Service"),
          operated by us ("we", "our", or "us"). By accessing or using the Service, you agree to be
          bound by these Terms. If you do not agree, do not use the Service.
        </p>

        <Section heading="1. Use of the Service">
          <p>
            The Service provides scores, schedules, corps information, predictions, user
            contributions, profile-management features, a job board, and related drum corps activity
            content. You agree not to:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Use the Service in violation of any applicable law or regulation.</li>
            <li>
              Attempt to interfere with, disrupt, or gain unauthorized access to the Service or its
              servers.
            </li>
            <li>
              Scrape, crawl, or otherwise extract data from the Service in a manner that imposes an
              unreasonable load on our infrastructure, except as permitted by robots.txt or with our
              prior written consent.
            </li>
            <li>Use the Service to transmit spam, malware, or other harmful content.</li>
            <li>
              Impersonate any person or organization, misrepresent your identity or affiliation, or
              claim or edit a profile that does not represent you or that you are not authorized to
              manage.
            </li>
            <li>
              Submit, upload, or post content that is unlawful, defamatory, harassing, infringing,
              fraudulent, deceptive, or that violates the rights or privacy of any person.
            </li>
          </ul>
        </Section>

        <Section heading="2. Copyright and Third-Party Content">
          <p>
            DrumCorps.app is an independent archival, informational, and journalistic project. We
            collect, organize, and present publicly available data and materials related to the drum
            corps activity — including scores, schedules, corps information, staff and personnel
            data, logos, images, and other content — for purposes of research, commentary,
            historical preservation, and public interest reporting. The Service is not a substitute
            for the original sources.
          </p>
          <p className="mt-2">
            Any copyrighted materials belonging to third parties that appear on the Service are used
            under the fair use doctrine (17 U.S.C. § 107) and similar principles, for purposes
            including criticism, comment, news reporting, teaching, scholarship, and research. Such
            use is non-commercial, transformative, and serves the public interest in preserving and
            providing access to the historical record of the drum corps activity.
          </p>
          <p className="mt-2">
            All rights in third-party content remain with their respective owners. Drum corps names,
            logos, likenesses, competition results, and related intellectual property are the
            property of their respective organizations, leagues, or rightsholders. Inclusion on the
            Service does not imply endorsement, sponsorship, or affiliation.
          </p>
          <p className="mt-2">
            The Service's own original content, features, and software are owned by us and protected
            by applicable copyright and intellectual property laws. Nothing in these Terms transfers
            any ownership rights in the Service itself.
          </p>
        </Section>

        <Section heading="3. User Content and Contributions">
          <p>
            The Service allows signed-in users to submit, upload, edit, and post content — including
            but not limited to profile information, biographies, photographs, images, text
            contributions to corps and show pages, job postings, applications, and other materials
            (collectively, "User Content"). You are solely responsible for the User Content you
            submit and for ensuring you have all rights necessary to submit it.
          </p>
          <p className="mt-2">
            You retain ownership of your User Content. By submitting User Content, you grant us a
            worldwide, non-exclusive, royalty-free, sublicensable, and transferable license to use,
            host, store, reproduce, modify, adapt, publish, translate, display, and distribute that
            User Content in connection with operating, promoting, and improving the Service. This
            license continues for any User Content you have submitted even after you stop using the
            Service, to the extent we retain copies as part of the historical record or backups.
          </p>
          <p className="mt-2">
            You represent and warrant that your User Content, and our use of it as permitted here,
            does not and will not infringe, misappropriate, or violate any third party's
            intellectual property rights, rights of privacy or publicity, or any applicable law. You
            must not submit User Content that is false, misleading, unlawful, defamatory, obscene,
            harassing, infringing, or that impersonates another person or organization.
          </p>
          <p className="mt-2">
            We do not pre-screen, monitor, or endorse User Content, and we are not responsible or
            liable for any User Content submitted by you or any other user. User Content does not
            reflect our views. We may, but are not obligated to, review, moderate, edit, refuse,
            remove, hide, or restrict any User Content at any time, in our sole discretion, with or
            without notice — including content we believe violates these Terms, is inaccurate, or is
            the subject of a dispute or removal request. We may also maintain a revision history of
            edits for transparency and integrity.
          </p>
        </Section>

        <Section heading="4. Accounts, Profile Claims, and Verified Profiles">
          <p>
            Certain features require you to create an account or sign in. You are responsible for
            maintaining the confidentiality of your account and for all activity that occurs under
            it. You must provide accurate information and promptly update it as needed.
          </p>
          <p className="mt-2">
            The Service may allow you to "claim" and manage a profile that represents you (for
            example, a staff or personnel profile, or an official's profile). When you claim a
            profile, you affirm and represent that you are the individual the profile represents, or
            that you are expressly authorized to manage it on that individual's behalf. This
            affirmation is a binding representation made as a condition of access and forms part of
            your agreement to these Terms.
          </p>
          <p className="mt-2">
            Knowingly claiming a profile that does not represent you, claiming a profile you are not
            authorized to manage, or providing false or misleading information in connection with a
            claim is a serious violation of these Terms. It may result in immediate revocation of the
            claim and termination of your account, and may expose you to civil or criminal liability
            for fraud, misrepresentation, or impersonation under applicable law. We do not represent
            that any specific consequence will or will not apply; legal consequences, if any, are
            determined by the applicable authorities and courts.
          </p>
          <p className="mt-2">
            We may verify, decline, condition, suspend, or revoke any profile claim at our sole
            discretion, including where we receive a credible dispute or believe a claim is
            inaccurate or made in bad faith. Claiming a profile does not transfer to you any
            ownership of the underlying data, the Service, or any third-party intellectual property,
            and does not make you an agent, employee, or representative of us.
          </p>
          <p className="mt-2">
            Content you add to or edit on a claimed profile is User Content and is governed by
            Section 3, including the license you grant and your sole responsibility for it. We are
            not liable for content added to, or edits made on, any profile by you or any other user.
          </p>
        </Section>

        <Section heading="5. Third-Party Links and Content">
          <p>
            The Service may contain links to third-party websites, stores, or services that are not
            owned or controlled by us (such as drum corps organization websites and online
            merchandise stores). We have no control over, and assume no responsibility for, the
            content, privacy policies, or practices of any third-party sites or services. You access
            them at your own risk.
          </p>
          <p className="mt-2">
            Product information, pricing, and availability displayed for third-party merchandise are
            provided by those third parties and may change without notice. We do not process
            payments or fulfill orders — all transactions occur on the third party's platform and
            are subject to their terms.
          </p>
        </Section>

        <Section heading="6. Accuracy of Information">
          <p>
            Much of the information on the Service is collected or scraped from publicly available
            sources on the internet and may contain errors, omissions, or outdated information. This
            includes, but is not limited to, competition scores, schedules, corps rosters, staff and
            personnel profiles, venue details, and historical records. We do not independently
            verify all data and make no representation as to its accuracy, completeness, or
            currency.
          </p>
          <p className="mt-2">
            Staff and personnel information displayed on the Service is compiled from public sources
            and may be incomplete, inaccurate, or out of date. We are not liable for any errors or
            omissions in staff profiles, biographies, or related data.
          </p>
          <p className="mt-2">
            Some information is contributed or edited by users, including on claimed profiles. We do
            not verify and are not responsible for the accuracy, legality, or completeness of any
            user-contributed content, and such content does not reflect our views.
          </p>
          <p className="mt-2">
            Any predictions, rankings, or projections displayed on the Service are generated by
            statistical models and are provided for entertainment and informational purposes only.
            They do not constitute guarantees, endorsements, or betting advice. We make no warranty
            as to the accuracy or reliability of any prediction, score, or other data displayed on
            the Service.
          </p>
        </Section>

        <Section heading="7. Disclaimer of Warranties">
          <p>
            The Service is provided on an "AS IS" and "AS AVAILABLE" basis. To the fullest extent
            permitted by law, we disclaim all warranties, express or implied, including but not
            limited to implied warranties of merchantability, fitness for a particular purpose, and
            non-infringement. We do not warrant that:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>The Service will be uninterrupted, timely, secure, or error-free.</li>
            <li>Any errors or inaccuracies in the Service will be corrected.</li>
            <li>The results obtained from the use of the Service will be accurate or reliable.</li>
          </ul>
        </Section>

        <Section heading="8. Limitation of Liability">
          <p>
            To the fullest extent permitted by law, we shall not be liable for any indirect,
            incidental, special, consequential, or punitive damages, including but not limited to
            loss of profits, data, use, or goodwill, arising out of or in connection with your use
            of or inability to use the Service, whether based on warranty, contract, tort (including
            negligence), or any other legal theory, even if we have been advised of the possibility
            of such damages.
          </p>
          <p className="mt-2">
            To the fullest extent permitted by law, we are not responsible or liable for any User
            Content or other content submitted, uploaded, edited, or posted by you or any other
            user, including on claimed profiles, or for any loss, damage, or harm arising from such
            content, from reliance on it, or from any interaction or dispute between users. Content
            on the Service is provided for informational purposes and does not constitute advice.
          </p>
          <p className="mt-2">
            Some jurisdictions do not allow the exclusion or limitation of certain damages. In those
            jurisdictions, our liability is limited to the maximum extent permitted by law.
          </p>
        </Section>

        <Section heading="9. Indemnification">
          <p>
            You agree to indemnify and hold us harmless from any claims, damages, liabilities,
            costs, or expenses (including reasonable attorneys' fees) arising out of your use of the
            Service, any User Content you submit, your claim to or management of any profile, your
            violation of these Terms, or your violation of any third-party rights.
          </p>
        </Section>

        <Section heading="10. Termination">
          <p>
            We may suspend or terminate your access to the Service at any time, without prior notice
            or liability, for any reason, including if you breach these Terms. Upon termination,
            your right to use the Service will immediately cease. Provisions that by their nature
            should survive termination (including intellectual property, disclaimers, and
            limitations of liability) shall survive.
          </p>
        </Section>

        <Section heading="11. Governing Law">
          <p>
            These Terms are governed by and construed in accordance with the laws of the United
            States, without regard to its conflict of law provisions. Any disputes arising out of or
            relating to these Terms or the Service shall be resolved in the courts of competent
            jurisdiction.
          </p>
        </Section>

        <Section heading="12. Changes to These Terms">
          <p>
            We may update these Terms from time to time. We will post the revised Terms on this page
            and update the "Last updated" date. Your continued use of the Service after any changes
            constitutes acceptance of the updated Terms. We encourage you to review this page
            periodically.
          </p>
        </Section>

        <Section heading="13. Copyright and Content Removal">
          <p>
            We respect the intellectual property rights of others. If you are a rightsholder and
            believe that any content on the Service infringes your copyright, or if you would like
            any information about you or your organization to be changed or removed, please contact
            us. We will review your request promptly and take appropriate action, which may include
            correcting, updating, or removing the relevant content at our discretion.
          </p>
          <p className="mt-2">
            To submit a request, please include a description of the content at issue, its location
            on the Service (URL), and your contact information. We may request additional
            information to verify your identity or authority.
          </p>
        </Section>

        <Section heading="14. Contact">
          <p>
            If you have any questions about these Terms, you can contact us at:{' '}
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
