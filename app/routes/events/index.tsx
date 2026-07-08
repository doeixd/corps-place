import { createFileRoute, useRouter } from '@tanstack/react-router';
import { seoHead, breadcrumbLd } from '@/lib/seo';
import { useEffect, useMemo } from 'react';
import { useMachine } from '@xstate/react';
import { eventsCollection } from '@/db/collections';
import { HybridCollection } from '@/components/hybrid-collection';
import { warmRoutesOnIdle } from '@/lib/warm-routes';
import { Show } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { getHybridEventsDirectory } from '@/lib/server-fns/hybrid';
import { searchString } from '@/lib/utils';
import type { EventDirectoryRow } from '@/lib/event-directory';
import {
  availableSeasons,
  selectEvents,
  eventCardKey,
  nextUpcomingEventKey,
} from '@/lib/event-filtering';
import { eventFilterMachine, eventFilterSearchCodec } from '@/machines/event-filter-machine';
import { useSearchSync } from '@/lib/use-search-sync';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { StatusCard } from '@/components/status-card';
import { ScrollableEventCardGrid } from '@/components/event-card';
import { SeasonChips } from '@/components/filter-chips';
import { Icon } from '@/components/icon';
import { Input } from '@/components/ui/input';
import { ArrowDown01Icon, Search01Icon } from '@/components/icons/generated';

type EventsSearch = { season?: string; q?: string; dir?: 'desc' };

export const Route = createFileRoute('/events/')({
  // Filters live in the query string so a filtered view is shareable/bookmarkable.
  validateSearch: (search: Record<string, unknown>): EventsSearch => {
    const out: EventsSearch = {};
    // Numeric seasons (e.g. 2026) decode back as numbers — coerce to string.
    const season = searchString(search.season);
    if (season) out.season = season;
    const q = searchString(search.q);
    if (q) out.q = q;
    if (searchString(search.dir) === 'desc') out.dir = 'desc';
    return out;
  },
  // SSR ships only the viewed season (the all-seasons list is ~1MB serialized
  // into the HTML); the events collection shard-loads the full set after
  // hydration for cross-season switching. Deep links (?season=) stay SSR-correct
  // via loaderDeps.
  loaderDeps: ({ search }) => ({ season: search.season }),
  loader: async ({ deps }) => {
    const dir = await getHybridEventsDirectory({ data: { season: deps.season } });
    // Computed ONCE here so SSR and hydration render the same split: computing
    // it on both sides made the first visible card change at hydration when the
    // server's UTC "today" disagreed with the browser's local one.
    const upcomingKey = nextUpcomingEventKey(dir.events, dir.seasons[0] ?? '');
    return { ...dir, upcomingKey };
  },
  head: ({ loaderData }) => {
    const d = loaderData;
    if (!d) return {};
    const n = d.total;
    return seoHead({
      title: 'Drum Corps Competitions, Schedules & Scores',
      description: `Browse ${n} drum corps competitions — schedules, lineups, scores and AI predictions by season on DrumCorps.app.`,
      path: '/events',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Events', path: '/events' },
        ]),
      ],
    });
  },
  // Static read-model data; a moderate window keeps repeat navs fast while still
  // refreshing periodically (scores/merch update on re-emit).
  staleTime: 5 * 60_000,
  component: EventsDirectory,
});

function EventsDirectory() {
  const { events } = Route.useLoaderData();
  return (
    // seed=false: the loader is one season's slice, not the full directory.
    <HybridCollection collection={eventsCollection} loader={events} seed={false}>
      {(rows) => <EventsDirectoryContent events={rows} />}
    </HybridCollection>
  );
}

function EventsDirectoryContent({ events }: { events: EventDirectoryRow[] }) {
  // Background warm-up: once the list has rendered, quietly preload the detail
  // (prediction/recap) route for each event in view, so the first click into any
  // of them is instant instead of blocking on the loader's shard/server-fn fetch.
  // Idle + connection-gated (see warmRoutesOnIdle); re-runs when the season/set
  // changes. Detail shards are small (~30KB, CDN-cached), so a season is ~2-3MB.
  const router = useRouter();
  useEffect(() => {
    // Cap the warm set: each current-season warm runs the detail loader (a few
    // read-model server-fns), so warming the whole season on every visit would be
    // a lot of proactive server work. The first ~40 (list is date-ordered, so the
    // most-likely clicks) covers the pain without hammering the backend.
    const WARM_CAP = 40;
    const targets = events
      .flatMap((e) =>
        e.slug && e.season
          ? [
              {
                to: '/events/$yearSlug/$slug/prediction',
                params: { yearSlug: e.season, slug: e.slug },
              },
            ]
          : []
      )
      .slice(0, WARM_CAP);
    return warmRoutesOnIdle(router as never, targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, events.length, events[0]?.season]);
  return <EventsDirectoryContentInner events={events} />;
}

function EventsDirectoryContentInner({ events }: { events: EventDirectoryRow[] }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  // Seasons newest first; latest is the default (kept out of the URL for a
  // clean default view). The loader's `seasons` covers all seasons even while
  // `events` is still the single-season SSR slice (pre-shard) — without it the
  // season dropdown would briefly collapse to one entry.
  const loaderSeasons = Route.useLoaderData().seasons;
  const seasons = [...new Set([...loaderSeasons, ...availableSeasons(events)])].sort((a, b) =>
    b.localeCompare(a)
  );
  const defaultSeason = seasons[0] ?? 'all';
  const codec = useMemo(() => eventFilterSearchCodec(defaultSeason), [defaultSeason]);

  // Filter state lives in the shared machine, seeded from the URL and kept in
  // two-way sync with it (shareable links + back/forward) via useSearchSync.
  const [state, send] = useMachine(eventFilterMachine, { input: codec.decode(search) });
  const filter = state.context;
  useSearchSync({
    context: filter,
    send,
    search,
    codec,
    navigate: ({ search: s, replace, resetScroll }) =>
      navigate({ search: s, replace, resetScroll }),
  });

  // Shared filter + order (season/search/dir) — same logic as the corps
  // "Appearances" list (see `selectEvents`).
  const ordered = selectEvents(events, filter);

  // Current-season default view starts at the NEXT UPCOMING show; earlier shows
  // collapse behind a button. This replaced the scroll-to-card approach, which
  // could never SSR (scrollTop isn't expressible in HTML) and visibly jumped at
  // hydration. The server renders exactly what the user sees — nothing moves.
  const currentSeason = seasons[0];
  const splitAtUpcoming =
    filter.season === currentSeason && !filter.search.trim() && filter.dir !== 'desc';
  // From the loader (not recomputed client-side): keeps the SSR'd split stable
  // through hydration regardless of the browser's timezone.
  const loaderUpcomingKey = Route.useLoaderData().upcomingKey;
  const upcomingKey = splitAtUpcoming ? loaderUpcomingKey : null;


  return (
    <PageShell>
      <PageHeader
        title="Event Directory"
        subtitle="Browse drum corps events by season"
        backTo="/"
        backLabel="Home"
      />

      {/* Search */}
      <div className="mb-6 flex items-center gap-2">
        <div className="relative w-full sm:w-80">
          <Icon
            icon={Search01Icon}
            size="sm"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          />
          <Input
            type="text"
            placeholder="Search events by name or city…"
            value={filter.search}
            onChange={(e) => send({ type: 'SET_SEARCH', search: e.target.value })}
            className="pl-9"
          />
        </div>
      </div>

      {/* Season filter */}
      <SeasonChips
        seasons={seasons}
        value={filter.season}
        onSelect={(season) => send({ type: 'SET_SEASON', season })}
        wrap={false}
        className="mb-6"
      />

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">Events</h2>

        <Show when={ordered.length > 1}>
          <button
            type="button"
            onClick={() => send({ type: 'TOGGLE_DIR' })}
            aria-label={
              filter.dir === 'desc' ? 'Sort by date, latest first' : 'Sort by date, earliest first'
            }
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
          >
            <motion.span
              className="inline-flex"
              animate={{ rotate: filter.dir === 'desc' ? 180 : 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <Icon icon={ArrowDown01Icon} size="sm" />
            </motion.span>
            {filter.dir === 'desc' ? 'Latest first' : 'Earliest first'}
          </button>
        </Show>
      </div>

      <Show
        when={ordered.length > 0}
        fallback={
          <StatusCard
            tone="empty"
            title="No matching events"
            description="Try a different search term or season."
          />
        }
      >
        {/* `animationKey` = active filter/sort so the grid remounts on change.
            SSR renders the list starting at the next upcoming show; the grid
            fills the earlier cards back in pre-paint during hydration and
            compensates scrollTop, so first paint and hydrated paint match
            pixel-for-pixel (see ScrollableEventCardGrid.ssrStartKey). */}
        <ScrollableEventCardGrid
          events={ordered}
          animationKey={`${filter.season}|${filter.search}|${filter.dir}`}
          scrollToKey={upcomingKey}
          scrollTopKey={filter.dir}
        />
      </Show>
    </PageShell>
  );
}
