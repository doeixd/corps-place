// Public FAQ (ADMIN_PAGE_PLAN §10.3). Static content for now — deflects support
// volume; can become authored/editable later via admin_settings.
import { createFileRoute, Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { seoHead } from '@/lib/seo';

const FAQS: { q: string; a: string }[] = [
  {
    q: 'Where does the data come from?',
    a: 'Scores and corps data are compiled from Drum Corps International recaps and public sources. Show pages can be enriched by signed-in contributors.',
  },
  {
    q: 'How are predictions generated?',
    a: 'A machine-learning model trained on historical caption scores estimates upcoming results. They are projections, not official scores.',
  },
  {
    q: 'Can I edit a show or corps page?',
    a: 'Yes — sign in and use the edit affordances on show pages. Edits are revisioned and can be reverted by moderators.',
  },
  {
    q: 'Something looks wrong. How do I report it?',
    a: 'Use the contact form and include the page and what’s off — corrections are welcome.',
  },
  {
    q: 'What is Fantasy Drum Corps?',
    a: 'A season-long fantasy game where you draft per-caption scores from real corps and earn standings recomputed after every show.',
  },
];

export const Route = createFileRoute('/faq')({
  head: () => seoHead({ title: 'FAQ', description: 'Frequently asked questions', path: '/faq' }),
  component: Faq,
});

function Faq() {
  return (
    <PageShell>
      <PageHeader title="FAQ" subtitle="Frequently asked questions" />
      <div className="flex flex-col gap-3">
        {FAQS.map((f) => (
          <Card key={f.q}>
            <CardContent className="pt-6">
              <h2 className="mb-1 font-semibold">{f.q}</h2>
              <p className="text-sm text-text-secondary">{f.a}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-6 text-sm text-text-secondary">
        Still stuck?{' '}
        <Link to="/contact" className="text-primary underline-offset-2 hover:underline">
          Contact us
        </Link>
        .
      </p>
    </PageShell>
  );
}
