import { createFileRoute } from '@tanstack/react-router';
import { seoHead, breadcrumbLd } from '@/lib/seo';
import { useMemo } from 'react';
import { useMachine } from '@xstate/react';
import { eventsCollection } from '@/db/collections';
import { HybridCollection } from '@/components/hybrid-collection';
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
  loader: async ({ deps }) => await getHybridEventsDirectory({ data: { season: deps.season } }),
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

  // The card the scrollable section opens on. Only for the current (newest)
  // season and only when not actively searching (don't yank the list mid-search).
  // Prefer the next upcoming show; once the season is over, fall back to its most
  // recent show rather than snapping back to the season opener.
  const currentSeason = seasons[0];
  const scrollToKey = useMemo(() => {
    if (filter.season !== currentSeason || filter.search.trim()) return null;
    const next = nextUpcomingEventKey(events, currentSeason);
    if (next) return next;
    const lastInSeason = events
      .filter((e) => e.season === currentSeason)
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .at(-1);
    return lastInSeason ? eventCardKey(lastInSeason) : null;
  }, [events, currentSeason, filter.season, filter.search]);

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
        {/* `animationKey` = active filter/sort so the grid remounts and re-runs
            the staggered fade-in on every change. The cards live in their own
            scrollable section, auto-scrolled to `scrollToKey` (the next show). */}
        <ScrollableEventCardGrid
          events={ordered}
          animationKey={`${filter.season}|${filter.search}|${filter.dir}`}
          scrollToKey={scrollToKey}
          scrollTopKey={filter.dir}
        />
      </Show>
    </PageShell>
  );
}
