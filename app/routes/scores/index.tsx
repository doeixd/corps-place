import { useEffect, useMemo } from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { warmVisibleOnIdle } from '@/lib/warm-routes';
import { useMachine } from '@xstate/react';
import { getHybridEventsDirectory } from '@/lib/server-fns/hybrid';
import { availableSeasons } from '@/lib/event-filtering';
import { eventFilterMachine, eventFilterSearchCodec } from '@/machines/event-filter-machine';
import { useSearchSync } from '@/lib/use-search-sync';
import { searchString } from '@/lib/utils';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { SeasonChips } from '@/components/filter-chips';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon';
import { Search01Icon } from '@/components/icons/generated';
import { ScoreEventSection } from '@/components/scores/score-event-section';
import { seoHead, breadcrumbLd, SITE_URL } from '@/lib/seo';

type ScoresSearch = { season?: string; q?: string };

const CURRENT_SCORES_SEASON = '2026';

const place = (city?: string | null, state?: string | null) =>
  [city, state].filter(Boolean).join(', ') || null;

/**
 * `/scores` — the results archive: the `/events` filter chrome over the events
 * that have been scored, rendered as a newest-first list of headings, each with
 * its full recap (lazy-loaded on scroll). Each heading links to its own indexable
 * `/scores/$slug` page.
 */
export const Route = createFileRoute('/scores/')({
  validateSearch: (search: Record<string, unknown>): ScoresSearch => {
    const out: ScoresSearch = {};
    const season = searchString(search.season);
    if (season) out.season = season;
    const q = searchString(search.q);
    if (q) out.q = q;
    return out;
  },
  // SSR ships only the viewed season (the all-seasons list is ~1MB serialized
  // into the HTML). ?season=all (the archive view) still loads everything.
  loaderDeps: ({ search }) => ({ season: search.season }),
  loader: async ({ deps }) => await getHybridEventsDirectory({ data: { season: deps.season } }),
  head: ({ loaderData }) => {
    const n = loaderData?.scoredTotal ?? 0;
    const season = CURRENT_SCORES_SEASON;
    // Honest dateModified: the archive last changed when the most recent show was
    // scored, so use the latest scored event's date. Advances only when a new show
    // posts (mirrors the rankings page); omitted when nothing is scored yet.
    const lastScored = (loaderData?.events ?? [])
      .filter((e) => e.scores_released && e.start_date)
      .map((e) => e.start_date.slice(0, 10))
      .sort()
      .at(-1);
    return seoHead({
      title: `${season} DCI Drum Corps Scores & Recaps — World Class, Open Class`,
      description:
        `${season} DCI drum corps scores and full caption-by-caption recaps: World Class and ` +
        `Open Class results, placements and GE/Visual/Music breakdowns from ${n} scored shows. ` +
        `Browse every DCI season on DrumCorps.app.`,
      path: '/scores',
      image: `${SITE_URL}/api/og/score/${season}`,
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Scores', path: '/scores' },
        ]),
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: `${season} DCI Drum Corps Scores & Recaps`,
          description: `World Class and Open Class scores and full recaps from the ${season} Drum Corps International season.`,
          url: `${SITE_URL}/scores`,
          ...(lastScored ? { dateModified: lastScored } : {}),
          isPartOf: { '@type': 'WebSite', name: 'DrumCorps.app', url: SITE_URL },
          about: [
            { '@type': 'Thing', name: 'Drum Corps International' },
            { '@type': 'Thing', name: 'World Class' },
            { '@type': 'Thing', name: 'Open Class' },
          ],
        },
        {
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          name: `${season} DCI Drum Corps Scores`,
          itemListElement: (loaderData?.events ?? [])
            .filter((e) => e.scores_released)
            .slice(0, 100)
            .map((e, i) => ({
              '@type': 'ListItem',
              position: i + 1,
              url: `${SITE_URL}/scores/${e.slug}`,
              name: `${e.event_name || e.name || e.slug} — Scores`,
            })),
        },
      ],
    });
  },
  // Static read-model data; a moderate window keeps repeat navs fast while still
  // refreshing periodically (scores/merch update on re-emit).
  staleTime: 5 * 60_000,
  component: ScoresIndex,
});

function ScoresIndex() {
  const { events } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const scored = useMemo(() => events.filter((e) => e.scores_released), [events]);
  const scoredSeasons = availableSeasons(scored);

  // Background warm-up: preload a scored event's recap page only once its section
  // scrolls into view (visible-only; data-grid-key = the event slug).
  const router = useRouter();
  useEffect(() => {
    return warmVisibleOnIdle(router as never, (key) =>
      key ? { to: '/scores/$slug', params: { slug: key } } : null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, scored.length]);
  // Season chips come from the loader's full season list — `events` only holds
  // the viewed season now, so deriving chips from it would show one entry.
  const loaderSeasons = Route.useLoaderData().seasons;
  const seasons = loaderSeasons.includes(CURRENT_SCORES_SEASON)
    ? loaderSeasons
    : [CURRENT_SCORES_SEASON, ...loaderSeasons];
  const defaultSeason = CURRENT_SCORES_SEASON;
  const codec = useMemo(() => eventFilterSearchCodec(defaultSeason), [defaultSeason]);

  const [state, send] = useMachine(eventFilterMachine, { input: codec.decode(search) });
  const filter = state.context;
  useSearchSync({
    context: filter,
    send,
    search,
    codec,
    navigate: ({ search: s, replace, resetScroll }) => navigate({ search: s, replace, resetScroll }),
  });

  // Group scored events by the active season filter. The default view is the
  // current season; the All pill is the archive view.
  const groups = useMemo(() => {
    const needle = filter.search.trim().toLowerCase();
    const visibleSeasons = filter.season === 'all' ? scoredSeasons : [filter.season];
    return visibleSeasons
      .map((season) => ({
        season,
        items: scored
          .filter((e) => e.season === season)
          .filter(
            (e) =>
              !needle ||
              (e.event_name || e.name || e.slug).toLowerCase().includes(needle) ||
              (place(e.location_city, e.location_state) ?? '').toLowerCase().includes(needle)
          )
          .sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '')),
      }))
      .filter((g) => g.items.length > 0);
  }, [scored, scoredSeasons, filter.season, filter.search]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);

  return (
    <PageShell>
      <PageHeader
        title={`${CURRENT_SCORES_SEASON} DCI Drum Corps Scores — World Class & Open Class`}
        subtitle="Final results and full caption-by-caption recaps, by season"
        backTo="/"
        backLabel="Home"
      />

      <div className="mb-6 flex items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="text"
            placeholder="Search scored shows by name or city…"
            value={filter.search}
            onChange={(e) => send({ type: 'SET_SEARCH', search: e.target.value })}
            className="pl-9"
          />
        </div>
      </div>

      <SeasonChips
        seasons={seasons}
        value={filter.season}
        onSelect={(season) => send({ type: 'SET_SEASON', season })}
        wrap={false}
        className="mb-6"
      />

      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-secondary">
          No scored shows match — try another season or clear the search.
        </p>
      ) : (
        <div className="space-y-12">
          {groups.map((g) => (
            <section key={g.season} id={`season-${g.season}`} className="scroll-mt-20">
              <h2 className="mb-6 text-xl font-semibold text-text-primary">
                <Link to="/scores/$slug" params={{ slug: g.season }} className="hover:text-primary">
                  {g.season} Scores
                </Link>{' '}
                <span className="text-sm font-normal text-text-secondary">
                  · {g.items.length} {g.items.length === 1 ? 'show' : 'shows'}
                </span>
              </h2>
              <div className="space-y-12">
                {g.items.map((e) => (
                  <div key={e.slug} data-grid-key={e.slug}>
                    <ScoreEventSection
                      slug={e.slug}
                      name={e.event_name || e.name || e.slug}
                      date={e.start_date}
                      place={place(e.location_city, e.location_state)}
                      corpsCount={e.lineup_entries ?? e.participant_entries ?? 0}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
