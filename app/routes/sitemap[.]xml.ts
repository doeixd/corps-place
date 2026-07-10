import { createServerFileRoute } from '@tanstack/react-start/server';
import { listJobs } from '@/lib/server-fns/jobs';
import { getBrand } from '@/lib/brand';
import { LANDING_DEFS } from '@/lib/jobs/landing-taxonomy';
import { urlsetResponse, indexResponse, type DatedUrl } from '@/lib/sitemap-shared';

// Brand-aware sitemap entry point.
//
// drumcorps.app: a sitemap INDEX pointing at three child sitemaps — core
// (scores/events/corps/rankings — the content that can rank), staff (~9k
// profiles) and shop (~5k products). Previously one 17.6k-URL file where the
// thin staff/shop pages outnumbered the core 6:1; Google sampled those, judged
// the site thin, and indexed almost nothing (a site: search returned one page).
// Separate files let engines rate and crawl each section on its own merits.
//
// pageantryjobs.com: unchanged single urlset (board + postings + landing pages).

const JOBS_STATIC = [
  '/',
  '/jobs/board',
  '/jobs/talent',
  '/jobs/post',
  '/jobs/guidelines',
  '/jobs/terms',
  '/jobs/privacy',
];

export const ServerRoute = createServerFileRoute('/sitemap.xml').methods({
  GET: async ({ request }) => {
    const origin = new URL(request.url).origin;

    if (getBrand(request) === 'jobs') {
      const jobPaths = new Set<string>(JOBS_STATIC);
      jobPaths.add('/jobs/categories');
      const jobDated: DatedUrl[] = [];
      let rows: Awaited<ReturnType<typeof listJobs>>['rows'] = [];
      try {
        rows = (await listJobs({ data: { limit: 1000, offset: 0 } })).rows;
        for (const j of rows)
          if (j.slug)
            jobDated.push({ loc: `/jobs/${j.slug}`, lastmod: j.published_at ?? undefined });
      } catch {
        /* postings unavailable — still list the static + landing pages */
      }
      for (const def of LANDING_DEFS) {
        const lastmod = rows
          .filter((j) => {
            if (def.filter.discipline && j.discipline !== def.filter.discipline) return false;
            if (def.filter.keyword) {
              const hay =
                `${j.title ?? ''} ${(j as { content_json?: string }).content_json ?? ''}`.toLowerCase();
              if (!hay.includes(def.filter.keyword.toLowerCase())) return false;
            }
            return true;
          })
          .map((x) => x.published_at)
          .filter((x): x is string => Boolean(x))
          .sort()
          .pop();
        jobDated.push({ loc: `/jobs/c/${def.slug}`, lastmod });
      }
      return urlsetResponse(origin, jobPaths, jobDated);
    }

    return indexResponse(origin, ['/sitemap-core.xml', '/sitemap-staff.xml', '/sitemap-shop.xml']);
  },
});
