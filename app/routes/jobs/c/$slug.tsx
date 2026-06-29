import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { listJobs } from '@/lib/server-fns/jobs';
import { getLandingIntro } from '@/lib/server-fns/landing';
import { LANDING_BY_SLUG, type LandingDef } from '@/lib/jobs/landing-taxonomy';
import { JobCard } from '@/components/jobs/job-card';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { seoHead, breadcrumbLd, siteBase } from '@/lib/seo';

/**
 * Programmatic-SEO landing page: `/jobs/c/<slug>` (see the pSEO plan). Each slug maps
 * to a LandingDef (discipline / role / instrument) that presets a job filter. The page
 * renders the matching jobs + unique copy + structured data, and is noindex'd when it
 * has no matching jobs (anti-thin-content).
 */
export const Route = createFileRoute('/jobs/c/$slug')({
  loader: async ({ params }) => {
    const def = LANDING_BY_SLUG[params.slug];
    if (!def) throw notFound();
    const [jobsRes, intro] = await Promise.all([
      listJobs({ data: { ...def.filter, limit: 50, offset: 0 } }).catch(() => ({ rows: [] })),
      getLandingIntro({ data: { slug: def.slug } }).catch(() => null),
    ]);
    // Prefer the AI-written intro (server-only); fall back to the templated one.
    return { def: { ...def, intro: intro ?? def.intro }, jobs: jobsRes.rows };
  },
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d?.def) return {};
    const { def, jobs } = d;
    const hasJobs = jobs.length > 0;
    const { url: siteUrl } = siteBase();

    const crumbs = [
      { name: 'Jobs', path: '/jobs/board' },
      ...(def.parentSlug && LANDING_BY_SLUG[def.parentSlug]
        ? [{ name: LANDING_BY_SLUG[def.parentSlug]!.h1, path: `/jobs/c/${def.parentSlug}` }]
        : []),
      { name: def.h1, path: `/jobs/c/${def.slug}` },
    ];

    return seoHead({
      title: def.title,
      description: def.metaDescription,
      path: `/jobs/c/${def.slug}`,
      // Always indexable: each page carries a unique intro + FAQ + related links,
      // and surfaces matching jobs as they're posted.
      jsonLd: [
        breadcrumbLd(crumbs),
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: def.h1,
          description: def.intro,
          url: `${siteUrl}/jobs/c/${def.slug}`,
        },
        hasJobs
          ? {
              '@context': 'https://schema.org',
              '@type': 'ItemList',
              itemListElement: jobs.slice(0, 25).map((j, i) => ({
                '@type': 'ListItem',
                position: i + 1,
                url: `${siteUrl}/jobs/${j.slug}`,
                name: j.title,
              })),
            }
          : null,
        def.faq.length
          ? {
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: def.faq.map((f) => ({
                '@type': 'Question',
                name: f.q,
                acceptedAnswer: { '@type': 'Answer', text: f.a },
              })),
            }
          : null,
      ],
    });
  },
  component: LandingPage,
});

function salaryRange(jobs: { salary_min: number | null; salary_max: number | null }[]): string | null {
  const mins = jobs.map((j) => j.salary_min).filter((n): n is number => typeof n === 'number');
  const maxs = jobs.map((j) => j.salary_max).filter((n): n is number => typeof n === 'number');
  if (!mins.length && !maxs.length) return null;
  const lo = mins.length ? Math.min(...mins) : null;
  const hi = maxs.length ? Math.max(...maxs) : null;
  const fmt = (n: number) => `$${n.toLocaleString()}`;
  if (lo && hi) return `${fmt(lo)}–${fmt(hi)}`;
  return fmt((lo ?? hi)!);
}

function LandingPage() {
  const { def, jobs } = Route.useLoaderData();
  const pay = salaryRange(jobs);
  const related = def.related.map((s) => LANDING_BY_SLUG[s]).filter((x): x is LandingDef => Boolean(x));

  return (
    <PageShell>
      <PageHeader title={def.h1} subtitle={def.subhead} backTo="/jobs/board" backLabel="All jobs" />

      <p className="max-w-3xl text-sm leading-relaxed text-text-secondary">{def.intro}</p>
      {pay ? (
        <p className="mt-2 text-sm text-text-secondary">
          Posted pay for these roles ranges <span className="font-medium text-text-primary">{pay}</span>.
        </p>
      ) : null}

      {jobs.length > 0 ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {jobs.map((j) => (
            <JobCard key={j.slug} job={j} />
          ))}
        </div>
      ) : (
        <div className="mt-6 rounded-xl border border-border bg-muted/20 p-6">
          <p className="font-medium text-text-primary">No open {def.h1.replace(/ Jobs$/, '')} roles right now.</p>
          <p className="mt-1 text-sm text-text-secondary">
            New roles are posted as employers hire. Browse all current openings or check related searches below.
          </p>
          <div className="mt-3 flex flex-wrap gap-3 text-sm font-medium">
            <Link to="/jobs/board" className="text-primary hover:underline">
              Browse all jobs →
            </Link>
            <Link to="/jobs/post" className="text-primary hover:underline">
              Post a job →
            </Link>
          </div>
        </div>
      )}

      {/* Related searches — internal linking for crawl + discovery */}
      {related.length ? (
        <section className="mt-8">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            Related searches
          </h2>
          <div className="flex flex-wrap gap-2">
            {related.map((r) => (
              <Link
                key={r.slug}
                to="/jobs/c/$slug"
                params={{ slug: r.slug }}
                className="rounded-full border border-border px-3 py-1 text-sm text-text-secondary transition-colors hover:border-primary/40 hover:text-primary"
              >
                {r.h1}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* FAQ — also emitted as FAQPage JSON-LD in head() */}
      {def.faq.length ? (
        <section className="mt-8 max-w-3xl">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary">FAQ</h2>
          <dl className="space-y-4">
            {def.faq.map((f) => (
              <div key={f.q}>
                <dt className="text-sm font-medium text-text-primary">{f.q}</dt>
                <dd className="mt-1 text-sm text-text-secondary">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </PageShell>
  );
}
