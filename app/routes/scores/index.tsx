import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { getHybridAllEvents } from '@/lib/server-fns/hybrid';
import { availableSeasons, selectEvents } from '@/lib/event-filtering';
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
import { seoHead, breadcrumbLd } from '@/lib/seo';

type ScoresSearch = { season?: string; q?: string };

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
  loader: async () => ({ events: await getHybridAllEvents() }),
  head: ({ loaderData }) => {
    const n = loaderData?.events.filter((e) => e.scores_released).length ?? 0;
    return seoHead({
      title: 'DCI Scores & Full Recaps',
      description: `Final scores and complete caption-by-caption recaps from ${n} scored DCI shows — browse results by season on DrumCorps.app.`,
      path: '/scores',
      jsonLd: [
        breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Scores', path: '/scores' },
        ]),
      ],
    });
  },
  staleTime: 60_000,
  component: ScoresIndex,
});

function ScoresIndex() {
  const { events } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const scored = useMemo(() => events.filter((e) => e.scores_released), [events]);
  const seasons = availableSeasons(scored);
  const defaultSeason = seasons[0] ?? 'all';
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

  // Results read newest-first regardless of the events' default chronological order.
  const ordered = useMemo(
    () =>
      [...selectEvents(scored, filter)].sort((a, b) =>
        (b.start_date ?? '').localeCompare(a.start_date ?? '')
      ),
    [scored, filter]
  );

  return (
    <PageShell>
      <PageHeader
        title="Scores"
        subtitle="DCI results & full recaps"
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

      <h2 className="mb-6 text-xl font-semibold">
        {ordered.length} scored {ordered.length === 1 ? 'show' : 'shows'}
      </h2>

      {ordered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-secondary">
          No scored shows match — try another season or clear the search.
        </p>
      ) : (
        <div className="space-y-12">
          {ordered.map((e) => (
            <ScoreEventSection
              key={e.slug}
              slug={e.slug}
              name={e.event_name || e.name || e.slug}
              date={e.start_date}
              place={place(e.location_city, e.location_state)}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
