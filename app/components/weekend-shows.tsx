import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Show, For } from 'jotai-solid-api';
import * as Match from 'effect/Match';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/reui/badge';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import { ClassBadge } from '@/components/class-badge';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { useGeolocation } from '@/hooks/use-geolocation';
import { sortByDistance, formatDistance, type LatLng } from '@/lib/geo';
import { formatEventDate } from '@/lib/format';
import type { FeaturedWeekend, WeekendShow, WeekendShowLineupEntry } from '@/lib/home-shows';
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  Location01Icon,
  MapsLocation02Icon,
  PinOffIcon,
} from '@/components/icons/generated';

const MAX_LINEUP = 14;

const showCoords = (s: WeekendShow): LatLng | null =>
  s.lat != null && s.lng != null ? { lat: s.lat, lng: s.lng } : null;

const locationLabel = (s: WeekendShow): string | null => {
  if (s.city && s.state) return `${s.city}, ${s.state}`;
  return s.city ?? s.state ?? null;
};

type LineupKind = 'performance' | 'exhibition' | 'ceremony';
const lineupKind = (e: WeekendShowLineupEntry): LineupKind =>
  e.isExhibition ? 'exhibition' : e.isNonPerformance ? 'ceremony' : 'performance';

// Right-hand class cell, mirroring the event Lineup table's ScheduleClassCell:
// class badge for performances (softened a touch for the compact card), an
// "Exhibition" pill for exhibitions, and a dash for ceremony/encore segments.
function LineupClassCell({ entry }: { entry: WeekendShowLineupEntry }) {
  const dash = <span className="text-muted-foreground/60">—</span>;
  return Match.value(lineupKind(entry)).pipe(
    Match.when('performance', () =>
      entry.divisionName ? (
        <span className="opacity-70">
          <ClassBadge division={entry.divisionName} noLink iconOnly />
        </span>
      ) : (
        dash
      )
    ),
    Match.when('exhibition', () => (
      <Badge variant="outline" radius="full" className="shrink-0 text-[10px] opacity-80">
        Exhibition
      </Badge>
    )),
    Match.when('ceremony', () => dash),
    Match.exhaustive
  );
}

function ShowCard({ show, distanceMiles }: { show: WeekendShow; distanceMiles: number | null }) {
  const place = locationLabel(show);
  const lineup = show.lineup.slice(0, MAX_LINEUP);
  const overflow = show.lineup.length - lineup.length;
  return (
    <Link
      to="/events/$yearSlug/$slug/prediction"
      params={{ yearSlug: '2026', slug: show.slug }}
      className="block h-full w-[300px] shrink-0 snap-start focus-visible:outline-none sm:w-[340px]"
    >
      <Card className="group card-hover h-full">
        <CardContent className="flex h-full flex-col gap-3 py-4">
          {/* Fixed-height header (two-line title + date + venue) so the lineup
              below starts at the same height on every card; any spare space
              falls here, above the Lineup label, not after the title. */}
          <div className="min-h-[87px] space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="line-clamp-2 font-semibold leading-tight text-[17px]">
                {show.name}
              </div>
              <Show when={distanceMiles != null}>
                <Badge
                  variant="info-light"
                  radius="full"
                  className="shrink-0 gap-1 whitespace-nowrap"
                >
                  <Icon icon={MapsLocation02Icon} size="sm" className="size-3" />
                  {formatDistance(distanceMiles as number)}
                </Badge>
              </Show>
            </div>
            <div className="text-sm text-text-secondary">
              {formatEventDate(show.startDate)}
              <Show when={place}>{(p) => ` • ${p}`}</Show>
            </div>
            <Show when={show.venueName}>
              {(venue) => <div className="truncate text-xs text-text-secondary">{venue}</div>}
            </Show>
          </div>

          <Show
            when={lineup.length > 0}
            fallback={<div className="text-xs text-text-secondary italic">Lineup TBA</div>}
          >
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Lineup
              </div>
              {/* Compact mirror of the event Lineup table: order · time (mono) ·
                  corps (logo + name) · class/exhibition cell, with muted
                  non-performance (ceremony/encore) rows. */}
              <div className="text-sm tabular-nums">
                <For each={lineup}>
                  {(entry) => {
                    const kind = lineupKind(entry);
                    return (
                      <div
                        className={
                          'flex items-center gap-2 border-b border-border/50 py-1 last:border-0' +
                          (kind !== 'performance' ? ' text-muted-foreground' : '')
                        }
                      >
                        <span className="w-4 shrink-0 text-right text-xs text-muted-foreground">
                          {entry.performanceOrder ?? '—'}
                        </span>
                        <span className="w-[58px] shrink-0 whitespace-nowrap font-mono text-xs text-text-secondary">
                          {entry.time ?? '—'}
                        </span>
                        <span className="min-w-0 flex-1">
                          <Show
                            when={kind === 'ceremony'}
                            fallback={
                              <CorpsNameCell
                                name={entry.corpsName}
                                slug={null}
                                corpsKey={entry.corpsKey}
                                logoClassName="size-4 sm:size-4"
                                logoWidth={16}
                                className="font-medium"
                              />
                            }
                          >
                            <span className="truncate italic">{entry.corpsName}</span>
                          </Show>
                        </span>
                        <LineupClassCell entry={entry} />
                      </div>
                    );
                  }}
                </For>
                <Show when={overflow > 0}>
                  <div className="pt-1 text-xs text-text-secondary">+{overflow} more</div>
                </Show>
              </div>
            </div>
          </Show>

          <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-primary">
            View Show
            <Icon icon={ArrowRight02Icon} size="sm" className="icon-shift" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * The home "shows this weekend, near you" carousel. SSR'd in date order; if the
 * user shares their location it reorders nearest-first and labels each card with
 * distance. Renders nothing off-season (no featured weekend).
 */
export function WeekendShowsCarousel({ weekend }: { weekend: FeaturedWeekend }) {
  const { state, request } = useGeolocation();

  // Smart scroll arrows: track whether the row can scroll further left/right so
  // each arrow only shows when it has somewhere to go. Same pattern as ShopSection.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setEdges({
      left: scrollLeft > 1,
      right: scrollLeft < scrollWidth - clientWidth - 1,
    });
  }, []);
  const showCount = weekend?.shows.length ?? 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // No synchronous updateEdges() here: observe() always delivers an initial
    // callback after layout, so an eager call only forces a reflow mid-hydration
    // (this was a Lighthouse "forced reflow" hotspot on the home page).
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showCount, updateEdges]);
  const scrollByPage = (dir: number) => {
    scrollerRef.current?.scrollBy({
      left: dir * scrollerRef.current.clientWidth * 0.8,
      behavior: 'smooth',
    });
  };

  if (!weekend || weekend.shows.length === 0) return null;

  const heading = weekend.isCurrentWeekend ? 'Shows this weekend' : 'Shows coming up';
  const dateRange = `${formatEventDate(weekend.weekendStart)} – ${formatEventDate(weekend.weekendEnd)}`;

  // Derived during render (no effect): order + distances follow the geo state.
  const ordered =
    state.status === 'located'
      ? sortByDistance(weekend.shows, state.coords, showCoords)
      : weekend.shows.map((show) => ({ item: show, distanceMiles: null as number | null }));

  return (
    <section className="space-y-3" aria-label={heading}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-medium text-text-primary pl-[1px]">{heading}</h2>
          <p className="pl-[1px] text-sm text-text-secondary">{dateRange}</p>
          <Show when={state.status === 'located'}>
            <p className="text-xs text-text-secondary">Sorted nearest first</p>
          </Show>
        </div>

        <Show when={state.status !== 'located'}>
          <Button
            variant="outline"
            size="sm"
            onClick={request}
            disabled={state.status === 'locating'}
          >
            <Icon
              icon={
                state.status === 'denied' || state.status === 'unsupported'
                  ? PinOffIcon
                  : Location01Icon
              }
              size="sm"
            />
            {state.status === 'locating'
              ? 'Locating…'
              : state.status === 'denied'
                ? 'Location blocked'
                : state.status === 'unsupported'
                  ? 'Location unavailable'
                  : state.status === 'error'
                    ? 'Try again'
                    : 'Sort by nearest'}
          </Button>
        </Show>
      </div>

      <div className="relative -mx-2">
        <div
          ref={scrollerRef}
          onScroll={updateEdges}
          className="carousel-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-pl-2 px-2 pt-3 pb-3"
          tabIndex={0}
          role="group"
          aria-label="Weekend shows, scroll horizontally"
        >
          <For each={ordered}>
            {(row) => <ShowCard show={row.item} distanceMiles={row.distanceMiles} />}
          </For>
        </div>

        {/* Smart prev/next arrows, matching the shop carousels: each fades in only
            when the row can scroll that way, and both stay hidden when everything
            fits. Shown on all viewports (touch users can swipe too, but the
            arrows are the visible affordance that there's more to see); the
            bottom scrollbar shifts the cards' center up ~6px. */}
        <button
          type="button"
          aria-label="Previous shows"
          onClick={() => scrollByPage(-1)}
          className={cn(
            'absolute left-1 top-[calc(50%-6px)] z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 shadow transition-opacity hover:bg-background',
            edges.left ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          <Icon icon={ArrowLeft01Icon} size="md" className="size-[1.125rem]" />
        </button>
        <button
          type="button"
          aria-label="Next shows"
          onClick={() => scrollByPage(1)}
          className={cn(
            'absolute right-1 top-[calc(50%-6px)] z-10 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 shadow transition-opacity hover:bg-background',
            edges.right ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          <Icon icon={ArrowRight01Icon} size="md" className="size-[1.125rem]" />
        </button>
      </div>
    </section>
  );
}
