import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequestHost, getRequestURL } from '@tanstack/react-start/server';

export type Brand = 'corps' | 'jobs';

export interface BrandIdentity {
  name: string;
  tagline: string;
  shortName: string;
  themeClass: string;
  primaryLight: string;
  primaryDark: string;
  seo: { title: string; description: string };
  email: { fromName: string; fromEmail: string; magicLinkSubject: string };
  legal: { contactEmail: string };
}

export const BRAND_CONFIG: Record<Brand, BrandIdentity> = {
  corps: {
    name: 'DrumCorps.app',
    tagline: 'Schedules, lineups, scores, and score predictions for the drum corps season.',
    shortName: 'DrumCorps',
    themeClass: '',
    primaryLight: 'oklch(0.553 0.195 38.402)',
    primaryDark: 'oklch(0.64 0.17 38.402)',
    seo: {
      title: 'DrumCorps.app — Drum Corps Scores, Schedules & Predictions',
      description:
        'Live drum corps scores, competition schedules, AI score predictions, judge & staff profiles, show programs, and official corps merch.',
    },
    email: {
      fromName: 'DrumCorps.app',
      fromEmail: 'noreply@drumcorps.app',
      magicLinkSubject: 'Your DrumCorps.app sign-in link',
    },
    legal: { contactEmail: 'privacy@drumcorps.app' },
  },
  jobs: {
    name: 'PageantryJobs',
    tagline: 'Find your next gig in the pageantry world.',
    shortName: 'PageantryJobs',
    themeClass: 'brand-jobs',
    primaryLight: 'oklch(0.55 0.12 220)',
    primaryDark: 'oklch(0.62 0.13 220)',
    seo: {
      title: 'PageantryJobs — Find pageantry industry jobs and talent',
      description:
        'The job board for drum corps, marching band, winter guard, and indoor percussion — find jobs, post openings, and connect with industry professionals.',
    },
    email: {
      fromName: 'PageantryJobs',
      fromEmail: 'noreply@pageantryjobs.com',
      magicLinkSubject: 'Your PageantryJobs sign-in link',
    },
    legal: { contactEmail: 'privacy@pageantryjobs.com' },
  },
};

export const getBrand = (request: Request): Brand => {
  const url = new URL(request.url);
  if (url.searchParams.get('brand') === 'jobs') return 'jobs';
  // `Host` is a forbidden request header in browsers, so on the CLIENT
  // `headers.get('host')` is null — fall back to the URL's host (which is
  // readable from window.location.href). Without this the client resolved
  // 'corps' on pageantryjobs.com and the SSR'd jobs page flipped on hydration.
  const host = (request.headers.get('host') || url.host || '').toLowerCase();
  const jobsHost = (process.env.JOBS_HOST ?? 'pageantryjobs.com').toLowerCase();
  if (host.includes(jobsHost) || host.includes('pageantryjobs')) return 'jobs';
  return 'corps';
};

// Content routes that belong exclusively to the CORPS brand (drumcorps.app).
// Anything under one of these prefixes served on the jobs host is off-brand and
// should canonicalize/redirect to drumcorps.app. Legal pages count too — the
// jobs brand has its own /jobs/privacy + /jobs/terms.
const CORPS_ROUTE_PREFIXES = [
  '/corps',
  '/events',
  '/fantasy',
  '/judges',
  '/merch',
  '/notify',
  '/predict',
  '/rankings',
  '/scores',
  '/shows',
  '/shop',
  '/staff',
  '/vs',
  '/privacy-policy',
  '/terms-of-service',
];

/**
 * Which brand a given route path *belongs to*, independent of the host serving
 * it. Corps content → 'corps'; the job board (`/jobs…`) → 'jobs'; everything
 * else (the `/` landing, `/admin`, `/dev`, `/contact`, `/faq`, and shared infra)
 * → null, meaning it legitimately renders under whichever brand's host it's on.
 *
 * Used to (a) redirect off-brand page loads to the owning domain and (b) emit a
 * content-correct <link rel="canonical"> so the two hosts never index each
 * other's pages. Server routes (/api, /sitemap.xml, /robots.txt, assets) never
 * reach this — they aren't page routes.
 */
export const routeBrand = (pathname: string): Brand | null => {
  const p = (pathname || '/').toLowerCase();
  if (p === '/jobs' || p.startsWith('/jobs/')) return 'jobs';
  for (const prefix of CORPS_ROUTE_PREFIXES) {
    if (p === prefix || p.startsWith(`${prefix}/`)) return 'corps';
  }
  return null;
};

export const readBrand = createIsomorphicFn()
  .server(() =>
    getBrand(
      new Request(getRequestURL(), {
        headers: { host: getRequestHost() },
      })
    )
  )
  .client(() =>
    getBrand(
      new Request(window.location.href, {
        headers: { host: window.location.host },
      })
    )
  );
