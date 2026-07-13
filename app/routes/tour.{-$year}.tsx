import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { getSeasonTour, getTourSeasons } from '@/lib/server-fns/hybrid';
import {
  parseCorpsList,
  parseTourAsof,
  parseTourDivs,
  parseTourYear,
  tourCanonicalPath,
  TOUR_DEFAULT_DIVS,
  TOUR_FOCUS_CAP,
  type TourDiv,
} from '@/lib/tour/codec';
import { divisionCategory } from '@/lib/prediction-scenario';
import type { SeasonTourCorps } from '@sdk/src/readModel/builders/tour.js';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { StatusCard } from '@/components/status-card';
import { FilterChips } from '@/components/filter-chips';
import { TourExplorerMap } from '@/components/tour/tour-explorer-map';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon';
import { ArrowDown01Icon, Search01Icon } from '@/components/icons/generated';
import { haversineMiles } from '@/lib/geo';
import { seoHead } from '@/lib/seo';
import { cn } from '@/lib/utils';

type TourSearch = { c?: string; div?: string; asof?: string };

const DIV_LABELS: Record<TourDiv, string> = {
  world: 'World',
  open: 'Open',
  'all-age': 'All-Age',
  soundsport: 'SoundSport',
};

export const Route = createFileRoute('/tour/{-$year}')({
  validateSearch: (s: Record<string, unknown>): TourSearch => ({
    c: parseCorpsList(s.c)?.join(','),
    div: parseTourDivs(s.div)?.join(','),
    asof: parseTourAsof(s.asof),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params }) => {
    const { seasons } = await getTourSeasons();
    const newest = seasons[0] ?? '';
    // No mappable seasons (read-model off / degraded): render the empty state.
    // NEVER redirect here — bare /tour would fail the same check and loop.
    if (!newest) {
      return {
        seasons: [] as string[],
        newest: '',
        data: { season: '', corps: [], events: {}, totalEvents: 0, mappableEvents: 0 },
        canonical: '/tour',
      };
    }
    const wanted = parseTourYear(params.year) ?? newest;
    // Unknown year (only reachable WITH a year param — bare always resolves to
    // newest) → canonical bare page.
    if (!seasons.includes(wanted))
      throw redirect({ to: '/tour/{-$year}', params: { year: undefined }, replace: true });
    // Canonical URL shape: newest season lives at bare /tour.
    if (params.year && wanted === newest)
      throw redirect({ to: '/tour/{-$year}', params: { year: undefined }, replace: true });
    const data = await getSeasonTour({ data: wanted });
    if (!data) {
      if (params.year)
        throw redirect({ to: '/tour/{-$year}', params: { year: undefined }, replace: true });
      return {
        seasons,
        newest,
        data: { season: newest, corps: [], events: {}, totalEvents: 0, mappableEvents: 0 },
        canonical: tourCanonicalPath(newest, newest),
      };
    }
    return { seasons, newest, data, canonical: tourCanonicalPath(wanted, newest) };
  },
  staleTime: 5 * 60_000,
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { data, canonical } = loaderData;
    const competitive = data.corps.filter(
      (c) => divisionCategory(c.division ?? undefined) !== 'soundsport'
    ).length;
    const dates = data.corps.flatMap((c) => c.stops.map((s) => s[1])).sort();
    const span =
      dates.length > 1 ? `${dates[0]!.slice(5)} – ${dates[dates.length - 1]!.slice(5)}` : '';
    return seoHead({
      title: `${data.season} DCI Tour Map — Every Drum Corps' Summer Tour Route`,
      description:
        `Every drum corps tour on one map: ${competitive} corps, ` +
        `${data.mappableEvents} shows across the US${span ? ` (${span})` : ''}. ` +
        'Scrub the season, follow any corps, tap a venue for its shows.',
      path: canonical,
      image: `https://drumcorps.app/api/og/tour/${data.season}`,
    });
  },
  component: TourPage,
});

function TourPage() {
  const { seasons, newest, data } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [hoverSlug, setHoverSlug] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const focused = parseCorpsList(search.c) ?? null;
  const divs = (parseTourDivs(search.div) ?? TOUR_DEFAULT_DIVS) as readonly TourDiv[];

  const set = (patch: Partial<TourSearch>) =>
    void navigate({
      to: '/tour/{-$year}',
      params: { year: data.season === newest ? undefined : data.season },
      search: ((prev: TourSearch) => ({ ...prev, ...patch })) as never,
      replace: true,
      resetScroll: false,
    });

  // Division-filtered corps (SoundSport opt-in by default).
  const divisionFiltered = useMemo(
    () =>
      data.corps.filter((c) =>
        (divs as readonly string[]).includes(divisionCategory(c.division ?? undefined))
      ),
    [data.corps, divs]
  );
  const bySlug = useMemo(() => new Map(data.corps.map((c) => [c.slug, c])), [data.corps]);

  // Visible on the map: focused subset (any division) or the filtered field.
  const focusedCorps = focused
    ? (focused.map((s) => bySlug.get(s)).filter(Boolean) as SeasonTourCorps[])
    : null;
  const visible = focusedCorps?.length ? focusedCorps : divisionFiltered;

  const toggleFocus = (slug: string) => {
    const cur = focused ?? [];
    const next = cur.includes(slug)
      ? cur.filter((s) => s !== slug)
      : [...cur, slug].slice(0, TOUR_FOCUS_CAP);
    set({ c: next.length ? next.join(',') : undefined });
  };

  // Stats strip (focused corps or the visible field).
  const stats = useMemo(() => {
    const list = visible;
    let miles = 0;
    const eventIds = new Set<string>();
    for (const c of list) {
      for (let i = 0; i < c.stops.length; i++) {
        eventIds.add(c.stops[i]![0]);
        if (i > 0)
          miles += haversineMiles(
            { lat: c.stops[i - 1]![2], lng: c.stops[i - 1]![3] },
            { lat: c.stops[i]![2], lng: c.stops[i]![3] }
          );
      }
    }
    return { corps: list.length, shows: eventIds.size, miles: Math.round(miles) };
  }, [visible]);

  const pickerMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = divisionFiltered;
    return q ? pool.filter((c) => c.name.toLowerCase().includes(q)) : pool;
  }, [divisionFiltered, query]);

  if (data.corps.length === 0) {
    return (
      <PageShell>
        <PageHeader title="Tour map" backTo="/" backLabel="Home" />
        <StatusCard
          tone="empty"
          title="No mappable tours yet"
          description="Tour routes appear once this season's venues are geocoded."
        />
      </PageShell>
    );
  }

  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title={`${data.season} DCI Tour Map`}
        subtitle={
          focusedCorps?.length
            ? `Following ${focusedCorps.map((c) => c.name).join(', ')} across the ${data.season} summer tour.`
            : `Every drum corps' summer tour route across the United States — scrub through the ${data.season} season day by day, follow any corps, and tap a venue to see its shows.`
        }
        backTo="/events"
        backLabel="Events"
      />

      {/* Season stats — prominent, tabular, self-updating with focus/filters. */}
      <div className="flex flex-wrap gap-x-10 gap-y-3">
        {[
          { value: stats.corps, label: focusedCorps?.length ? 'corps followed' : 'corps touring' },
          { value: stats.shows, label: 'shows on the map' },
          { value: `~${stats.miles.toLocaleString('en-US')}`, label: 'route miles' },
        ].map((st) => (
          <div key={st.label} className="flex flex-col">
            <span className="text-3xl font-bold tabular-nums leading-none text-text-primary">
              {st.value}
            </span>
            <span className="mt-1 text-xs font-medium uppercase tracking-wide text-text-muted">
              {st.label}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <FilterChips
          ariaLabel="Season"
          value={data.season}
          items={seasons.slice(0, 10).map((y) => ({ value: y, label: y }))}
          onSelect={(y) =>
            void navigate({
              to: '/tour/{-$year}',
              params: { year: y === newest ? undefined : y },
              search: {},
            })
          }
        />
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(DIV_LABELS) as TourDiv[]).map((d) => {
            const on = (divs as readonly string[]).includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? divs.filter((x) => x !== d) : [...divs, d];
                  const isDefault =
                    next.length === TOUR_DEFAULT_DIVS.length &&
                    TOUR_DEFAULT_DIVS.every((x) => next.includes(x));
                  set({ div: isDefault || next.length === 0 ? undefined : next.join(',') });
                }}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1.5 text-sm transition-colors',
                  on
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : 'border-border text-text-secondary hover:border-primary/40'
                )}
              >
                {DIV_LABELS[d]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Focused-corps legend chips. */}
      {focusedCorps?.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {focusedCorps.map((c) => (
            <button
              key={c.slug}
              type="button"
              onMouseEnter={() => setHoverSlug(c.slug)}
              onMouseLeave={() => setHoverSlug(null)}
              onClick={() => toggleFocus(c.slug)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border py-1 pl-2 pr-2.5 text-sm text-text-secondary transition-colors hover:border-primary/50"
              title="Remove"
            >
              <span
                className="size-2 rounded-full"
                style={{ background: c.colorPrimary ?? 'var(--color-primary)' }}
              />
              {c.name}
              <span aria-hidden className="text-text-muted">
                ×
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => set({ c: undefined })}
            className="text-sm text-primary hover:underline"
          >
            Show all
          </button>
        </div>
      ) : null}

      <TourExplorerMap
        corps={visible}
        events={data.events}
        season={data.season}
        focused={focused}
        asof={search.asof}
        hoverSlug={hoverSlug}
        onHoverSlug={setHoverSlug}
        onToggleFocus={toggleFocus}
      />

      {data.mappableEvents < data.totalEvents ? (
        <p className="text-xs text-text-muted">
          {data.mappableEvents} of {data.totalEvents} shows mappable this season — locations are
          approximate (ZIP-level).
        </p>
      ) : (
        <p className="text-xs text-text-muted">Locations are approximate (ZIP-level).</p>
      )}

      {/* Corps picker: follow specific corps. */}
      <details className="group rounded-lg border border-border">
        <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-text-secondary [&::-webkit-details-marker]:hidden">
          <span>
            Follow specific corps
            {focused?.length ? ` (${focused.length}/${TOUR_FOCUS_CAP})` : ''}
          </span>
          <Icon
            icon={ArrowDown01Icon}
            size="sm"
            className="shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="space-y-3 border-t border-border p-3">
          <div className="relative w-full sm:w-80">
            <Icon
              icon={Search01Icon}
              size="sm"
              className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <Input
              type="search"
              placeholder="Search corps…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {pickerMatches.map((c) => {
              const on = focused?.includes(c.slug) ?? false;
              const atCap = !on && (focused?.length ?? 0) >= TOUR_FOCUS_CAP;
              return (
                <button
                  key={c.slug}
                  type="button"
                  disabled={atCap}
                  onClick={() => toggleFocus(c.slug)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition-colors',
                    on
                      ? 'border-primary/50 bg-primary/10'
                      : 'border-transparent hover:bg-muted/60',
                    atCap && 'opacity-40'
                  )}
                >
                  <CorpsLogo
                    name={c.name}
                    logo={corpsLogoSource({ corps_logo: c.logo })}
                    width={24}
                    className="size-6 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {c.stops.length < 2 ? '1 mappable stop' : `${c.stops.length} stops`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </details>

      {/* SSR'd crawlable content: the map is invisible to crawlers/screen
          readers. Collapsed by default (content inside a closed <details> is
          still in the DOM, so crawlers/readers get it either way). */}
      <details className="group rounded-lg border border-border">
        <summary className="flex cursor-pointer select-none list-none items-center justify-between gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <h2 className="text-base font-semibold">
            Corps touring in {data.season}
            <span className="ml-2 text-sm font-normal text-text-secondary">
              {divisionFiltered.length}
            </span>
          </h2>
          <Icon
            icon={ArrowDown01Icon}
            size="sm"
            className="shrink-0 transition-transform group-open:rotate-180"
          />
        </summary>
        <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border p-3 text-sm text-text-secondary">
          {divisionFiltered.map((c) => (
            <Link
              key={c.slug}
              to="/corps/$slug/{-$season}"
              params={{ slug: c.slug, season: data.season }}
              className="hover:text-foreground hover:underline"
            >
              {c.name}
              <span className="ml-1 text-xs text-text-muted">{c.stops.length}</span>
            </Link>
          ))}
        </p>
      </details>
    </PageShell>
  );
}
