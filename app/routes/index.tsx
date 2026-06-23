import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { Logo } from '@/components/logo';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { WeekendShowsCarousel } from '@/components/weekend-shows';
import { CorpsRegistryProvider } from '@/components/corps-registry';
import { LatestResultsPanel } from '@/components/latest-results';
import { StandingsSnapshot } from '@/components/standings-snapshot';
import { FeaturedPredictionPanel } from '@/components/featured-prediction';
import { getHomePageData } from '@/lib/server-fns/home';
import { seoHead, SITE_URL } from '@/lib/seo';
import {
  ArrowRight02Icon,
  Calendar01Icon,
  UserMultipleIcon,
  JusticeScale01Icon,
  UserGroupIcon,
} from '@/components/icons/generated';
import { JobsLanding } from '@/components/jobs/landing';

export const Route = createFileRoute('/')({
  loader: async () => getHomePageData(),
  head: () =>
    seoHead({
      title: 'DrumCorps.app — DCI Drum Corps Scores, Schedules & Predictions',
      description:
        'Live DCI drum corps scores, competition schedules, AI score predictions, judge & staff profiles, show programs, and official corps merch — all in one place.',
      path: '/',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'DrumCorps.app',
          url: SITE_URL,
          potentialAction: {
            '@type': 'SearchAction',
            target: {
              '@type': 'EntryPoint',
              urlTemplate: `${SITE_URL}/corps?q={search_term_string}`,
            },
            'query-input': 'required name=search_term_string',
          },
        },
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: 'DrumCorps.app',
          url: SITE_URL,
          logo: `${SITE_URL}/logo.svg`,
        },
      ],
    }),
  staleTime: 5 * 60_000,
  component: Home,
});

// A compact navigation card for the "Explore" row. `preload` mirrors the old
// home page: the heavy events route is prefetched on render, the rest on intent.
function ExploreCard({
  to,
  params,
  preload,
  icon,
  title,
  description,
}: {
  to: string;
  params?: Record<string, string>;
  preload: 'render' | 'intent';
  icon: typeof Calendar01Icon;
  title: string;
  description: ReactNode;
}) {
  return (
    <Link
      to={to}
      params={params}
      preload={preload}
      className="block h-full focus-visible:outline-none"
    >
      <Card className="group card-hover h-full">
        <CardContent className="flex h-full flex-col gap-2 py-5">
          <div className="flex items-center gap-2">
            <Icon icon={icon} size="sm" className="text-primary" />
            <div className="font-semibold">{title}</div>
          </div>
          <p className="text-sm text-text-secondary">{description}</p>
          <span className="mt-auto inline-flex items-center gap-1 pt-1 text-sm font-medium text-primary">
            Open
            <Icon icon={ArrowRight02Icon} size="sm" className="icon-shift" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

function Home() {
  const { weekend, latestResults, standings, featuredPrediction, lineupCorps } =
    Route.useLoaderData();

  // Detect brand from URL params or host (client-side).
  // The root route sets brand on SSR; we re-check here for client navigations.
  const brand = (() => {
    try {
      return new URL(window.location.href).searchParams.get('brand') === 'jobs'
        ? ('jobs' as const)
        : ('corps' as const);
    } catch {
      return 'corps' as const;
    }
  })();
  if (brand === 'jobs') return <JobsLanding />;

  return (
    <PageShell>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Logo aria-hidden="true" className="size-10 shrink-0" />
            DrumCorps.app
          </span>
        }
        subtitle="Schedules, lineups, scores, and score predictions for the drum corps season."
      />

      <div className="space-y-8">
        <CorpsRegistryProvider corps={lineupCorps}>
          <WeekendShowsCarousel weekend={weekend} />
        </CorpsRegistryProvider>

        {/* Featured prediction · latest results · standings — three ranked
            snapshots, side by side on wide screens, stacked on mobile. */}
        <div className="grid gap-4 lg:grid-cols-3">
          <FeaturedPredictionPanel prediction={featuredPrediction} />
          <LatestResultsPanel results={latestResults} />
          <StandingsSnapshot standings={standings} />
        </div>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Explore</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <ExploreCard
              to="/events/$yearSlug"
              params={{ yearSlug: '2026' }}
              preload="render"
              icon={Calendar01Icon}
              title="2026 Events"
              description="Browse the season — lineups, schedules, scores, and predictions."
            />
            <ExploreCard
              to="/corps"
              preload="intent"
              icon={UserMultipleIcon}
              title="Corps Directory"
              description="Drum corps and ensembles with logos, history, and score timelines."
            />
            <ExploreCard
              to="/staff"
              preload="intent"
              icon={UserGroupIcon}
              title="Staff Directory"
              description="Instructors, designers, and directors across the activity."
            />
            <ExploreCard
              to="/judges"
              preload="intent"
              icon={JusticeScale01Icon}
              title="Judge Directory"
              description="DCI judges and their assignments across seasons and captions."
            />
          </div>
        </section>
      </div>

      <footer className="mt-12 border-t border-border pt-6 text-center">
        <p className="text-xs text-text-muted">
          <Link to="/privacy-policy" className="hover:text-text-secondary transition-colors">
            Privacy Policy
          </Link>
          <span className="mx-2 text-border">·</span>
          <Link to="/terms-of-service" className="hover:text-text-secondary transition-colors">
            Terms of Service
          </Link>
        </p>
      </footer>
    </PageShell>
  );
}
