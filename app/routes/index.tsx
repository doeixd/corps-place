import { createFileRoute, Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useSession, signOut } from '@/lib/auth-client';
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
import { seoHead, siteBase } from '@/lib/seo';
import { readBrand, BRAND_CONFIG } from '@/lib/brand';
import {
  ArrowRight02Icon,
  Analytics01Icon,
  Calendar01Icon,
  RankingIcon,
  UserMultipleIcon,
  JusticeScale01Icon,
  UserGroupIcon,
  BookOpen01Icon,
  Briefcase01Icon,
} from '@/components/icons/generated';
import { JobsLanding } from '@/components/jobs/landing';
import { useBrand } from '@/lib/brand-context';

export const Route = createFileRoute('/')({
  loader: async () => getHomePageData(),
  // Brand-aware: the home is shared by both hosts, so its title/description +
  // WebSite/Organization JSON-LD must match the brand being served (otherwise
  // pageantryjobs.com's home advertises "DrumCorps.app").
  head: () => {
    const brand = readBrand();
    const cfg = BRAND_CONFIG[brand];
    const { url: siteUrl } = siteBase();
    const searchPath = brand === 'jobs' ? '/jobs/board?q=' : '/corps?q=';
    return seoHead({
      title: cfg.seo.title,
      description: cfg.seo.description,
      path: '/',
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: cfg.name,
          url: siteUrl,
          potentialAction: {
            '@type': 'SearchAction',
            target: {
              '@type': 'EntryPoint',
              urlTemplate: `${siteUrl}${searchPath}{search_term_string}`,
            },
            'query-input': 'required name=search_term_string',
          },
        },
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: cfg.name,
          url: siteUrl,
          logo: `${siteUrl}/logo.svg`,
        },
      ],
    });
  },
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
  const { data: session } = useSession();

  // Single source of truth from the root loader — same value SSR + client, so the
  // jobs landing never flips to the corps home on hydration.
  if (useBrand() === 'jobs') return <JobsLanding />;

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

        {/* Cross-promo for the sibling site (corps brand only — Home() doesn't
            render on pageantryjobs.com). External link to the other host. */}
        <section>
          <a
            href="https://pageantryjobs.com"
            className="group flex flex-col gap-4 rounded-xl border border-border bg-gradient-to-br from-primary/5 via-transparent to-transparent p-6 transition-colors hover:border-primary/40 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon icon={Briefcase01Icon} size="lg" />
              </span>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                  Careers in the marching arts
                </p>
                <h2 className="text-lg font-semibold text-text-primary">
                  Hiring or looking for a gig? Try PageantryJobs.com
                </h2>
                <p className="mt-1 max-w-xl text-sm text-text-secondary">
                  The job board for drum corps, marching band, color guard &amp; winter percussion —
                  post openings or find your next role.
                </p>
              </div>
            </div>
            {/* On stacked layouts the button sits below the text; indent it by the
                icon width (size-12 + gap-4 = 4rem) so its left edge lines up with
                the heading, then reset on sm+ where it's right-aligned. */}
            <span className="ml-16 inline-flex shrink-0 items-center gap-1.5 self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-transform group-hover:translate-x-0.5 sm:ml-0 sm:self-auto">
              Visit PageantryJobs.com →
            </span>
          </a>
        </section>

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
              to="/scores"
              preload="intent"
              icon={RankingIcon}
              title="Scores"
              description="Final scores and complete caption-by-caption recaps from every scored show."
            />
            <ExploreCard
              to="/shows"
              preload="intent"
              icon={BookOpen01Icon}
              title="Shows"
              description="Show programs across the archive — titles, repertoire, designers, and media."
            />
            <ExploreCard
              to="/rankings"
              preload="intent"
              icon={RankingIcon}
              title="Rankings"
              description="Season standings + a rank bump chart — filter by metric, division, and as-of date."
            />
            <ExploreCard
              to="/vs"
              preload="intent"
              icon={Analytics01Icon}
              title="VS — Compare"
              description="Plot any corps, seasons, and reference baselines on one curve to compare."
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
              description="Drum corps judges and their assignments across seasons and captions."
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
          <span className="mx-2 text-border">·</span>
          <Link to="/contact" className="hover:text-text-secondary transition-colors">
            Contact
          </Link>
          {session?.user ? (
            <>
              <span className="mx-2 text-border">·</span>
              <button
                type="button"
                onClick={() =>
                  void signOut().then(() => {
                    window.location.href = '/';
                  })
                }
                className="transition-colors hover:text-text-secondary"
              >
                Log out
              </button>
            </>
          ) : null}
        </p>
      </footer>
    </PageShell>
  );
}
