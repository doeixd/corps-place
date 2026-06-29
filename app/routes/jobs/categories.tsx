import { createFileRoute, Link } from '@tanstack/react-router';
import { LANDING_DISCIPLINES, LANDING_DEFS, LANDING_BY_SLUG } from '@/lib/jobs/landing-taxonomy';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { seoHead } from '@/lib/seo';

/**
 * Hub for the pSEO landing pages — browse jobs by discipline & role. The primary
 * internal-link surface so search engines discover every /jobs/c/<slug> page.
 */
export const Route = createFileRoute('/jobs/categories')({
  head: () =>
    seoHead({
      title: 'Browse Jobs by Discipline & Role | PageantryJobs',
      description:
        'Find jobs across the pageantry & performing-arts world — drum corps, marching band, color guard, dance, pageants, fitness, equestrian, and more. Browse by discipline and role.',
      path: '/jobs/categories',
      image: 'https://pageantryjobs.com/og-jobs.png',
    }),
  component: CategoriesPage,
});

function CategoriesPage() {
  const instruments = LANDING_DEFS.filter((d) => d.kind === 'instrument-role');
  const crossRoles = LANDING_DEFS.filter((d) => d.kind === 'role');

  return (
    <PageShell>
      <PageHeader
        title="Browse jobs by discipline & role"
        subtitle="Every discipline and the roles that hire across the pageantry world."
        backTo="/jobs/board"
        backLabel="All jobs"
      />

      <div className="space-y-6">
        {LANDING_DISCIPLINES.map((d) => (
          <section key={d.discipline}>
            <h2 className="mb-2 text-base font-semibold text-text-primary">
              <Link to="/jobs/c/$slug" params={{ slug: d.pageSlug }} className="hover:text-primary">
                {d.label} jobs
              </Link>
            </h2>
            <div className="flex flex-wrap gap-2">
              {d.roleSlugs.map((slug) => {
                const def = LANDING_BY_SLUG[slug];
                if (!def) return null;
                return (
                  <Link
                    key={slug}
                    to="/jobs/c/$slug"
                    params={{ slug }}
                    className="rounded-full border border-border px-3 py-1 text-sm text-text-secondary transition-colors hover:border-primary/40 hover:text-primary"
                  >
                    {def.h1.replace(/ Jobs$/, '')}
                  </Link>
                );
              })}
            </div>
          </section>
        ))}

        <section>
          <h2 className="mb-2 text-base font-semibold text-text-primary">By role</h2>
          <div className="flex flex-wrap gap-2">
            {crossRoles.map((def) => (
              <Link
                key={def.slug}
                to="/jobs/c/$slug"
                params={{ slug: def.slug }}
                className="rounded-full border border-border px-3 py-1 text-sm text-text-secondary transition-colors hover:border-primary/40 hover:text-primary"
              >
                {def.h1}
              </Link>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold text-text-primary">By instrument</h2>
          <div className="flex flex-wrap gap-2">
            {instruments.map((def) => (
              <Link
                key={def.slug}
                to="/jobs/c/$slug"
                params={{ slug: def.slug }}
                className="rounded-full border border-border px-3 py-1 text-sm text-text-secondary transition-colors hover:border-primary/40 hover:text-primary"
              >
                {def.h1.replace(/ Jobs$/, '')}
              </Link>
            ))}
          </div>
        </section>
      </div>
    </PageShell>
  );
}
