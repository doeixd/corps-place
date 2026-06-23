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
      title: 'DrumCorps.app — DCI Drum Corps Scores, Schedules & Predictions',
      description:
        'Live DCI drum corps scores, competition schedules, AI score predictions, judge & staff profiles, show programs, and official corps merch.',
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
  const host = (request.headers.get('host') ?? '').toLowerCase();
  const jobsHost = (process.env.JOBS_HOST ?? 'pageantryjobs.com').toLowerCase();
  if (host.includes(jobsHost) || host.includes('pageantryjobs')) return 'jobs';
  return 'corps';
};
