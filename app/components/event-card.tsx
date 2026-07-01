import { useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { Show } from 'jotai-solid-api';
import { Card, CardContent } from '@/components/ui/card';
import { StaggeredGrid } from '@/components/staggered-grid';
import { StatusPill } from '@/components/status-pill';
import { Icon } from '@/components/icon';
import { formatEventDate, formatScore } from '@/lib/format';
import { preferredEventSlug } from '@/lib/dci-links';
import { eventCardKey } from '@/lib/event-filtering';
import { medalClass, ordinal } from '@/lib/rank';
import { useGridColumns } from '@/hooks/use-grid-columns';
import { useIsomorphicLayoutEffect } from '@/hooks/use-isomorphic-layout-effect';
import { cn } from '@/lib/utils';
import type { AppearanceResult, EventDirectoryRow } from '@/lib/event-directory';
import {
  AiMagicIcon as PredictionIcon,
  ArrowRight02Icon,
  Clock01Icon as TimesIcon,
  JusticeScale01Icon as JudgesIcon,
  RankingIcon as ScoresIcon,
  UserMultipleIcon as LineupIcon,
} from '@/components/icons/generated';

// Readiness chips shown on an event card; each renders only when it applies.
const EVENT_CHIPS: {
  label: string;
  icon: typeof LineupIcon;
  ready: (e: EventDirectoryRow) => boolean;
}[] = [
  {
    label: 'Lineup',
    icon: LineupIcon,
    ready: (e) => (e.lineup_entries ?? 0) > 0,
  },
  {
    label: 'Times',
    icon: TimesIcon,
    ready: (e) => Boolean(e.all_times_present),
  },
  {
    label: 'Judges',
    icon: JudgesIcon,
    ready: (e) => (e.judge_assignments ?? 0) > 0,
  },
  {
    label: 'Scores',
    icon: ScoresIcon,
    ready: (e) => Boolean(e.scores_released),
  },
  {
    label: 'Prediction',
    icon: PredictionIcon,
    ready: (e) => (e.prediction_runs ?? 0) > 0,
  },
];

// Headroom reserved above the auto-scrolled target row so the card's hover
// lift + shadow isn't clipped against the scrollport's top edge.
const SCROLLABLE_GRID_INSET = 28;

/**
 * An event card: whole card links to the event's prediction page, with date +
 * location, readiness chips, and a "View Event" affordance. Shared by the events
 * directory and the corps "Appearances" section.
 */
export function EventCard({
  event,
  result,
}: {
  event: EventDirectoryRow;
  /** This corps's finish at the event (corps profile only); omitted elsewhere. */
  result?: AppearanceResult | null;
}) {
  const chips = EVENT_CHIPS.filter((c) => c.ready(event));
  const linkSlug = preferredEventSlug(event, event.slug);
  const hasResult = !!result && (result.place != null || result.total != null);
  return (
    <Link
      to="/events/$yearSlug/$slug/prediction"
      params={{ yearSlug: event.season ?? '2026', slug: linkSlug }}
      className="block h-full cursor-pointer focus-visible:outline-none"
    >
      <Card className="group card-hover h-full">
        <CardContent className="space-y-3 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-semibold text-[19px]">{event.name}</div>
              <div className="text-sm text-text-secondary">
                {formatEventDate(event.start_date)}
                <Show when={event.location_city}>
                  {(city) => ` • ${city}${event.location_state ? `, ${event.location_state}` : ''}`}
                </Show>
              </div>
            </div>
            {/* This corps's finish — subtle, right-aligned: medal-tinted place over
                the total. Renders only on the corps profile (where `result` is set).
                Ternaries (not <Show>) so the result is dereferenced only when present
                — EventCard is also used result-less on the events directory. */}
            {hasResult && result ? (
              <div className="shrink-0 text-right leading-tight">
                {result.place != null ? (
                  <div
                    className={cn('text-sm font-semibold tabular-nums', medalClass(result.place))}
                  >
                    {ordinal(result.place)}
                  </div>
                ) : null}
                {result.total != null ? (
                  <div className="text-xs text-text-secondary tabular-nums">
                    {formatScore(result.total)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <Show when={chips.length > 0}>
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <StatusPill key={c.label} label={c.label} active icon={c.icon} />
              ))}
            </div>
          </Show>

          <span className="inline-flex items-center gap-1 text-sm font-medium text-primary">
            View Event
            <Icon icon={ArrowRight02Icon} size="sm" className="icon-shift" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Responsive grid of {@link EventCard}s with a staggered fade-in. Pass
 * `animationKey` (e.g. the active filter/sort) so the grid remounts and re-runs
 * the entrance animation when the list changes.
 */
export function EventCardGrid({
  events,
  animationKey,
  resultByKey,
}: {
  events: readonly EventDirectoryRow[];
  animationKey?: string;
  /** Optional per-event result (corps profile), keyed by `eventCardKey`. */
  resultByKey?: Map<string, AppearanceResult>;
}) {
  return (
    <StaggeredGrid
      items={events}
      getKey={eventCardKey}
      renderItem={(event) => (
        <EventCard event={event} result={resultByKey?.get(eventCardKey(event))} />
      )}
      variant="md-lg"
      animationKey={animationKey}
    />
  );
}

/**
 * Like {@link EventCardGrid}, but the grid lives in its own fixed-height,
 * independently scrollable section instead of growing the page. When
 * `scrollToKey` is set, the section auto-scrolls (instantly, pre-paint) so that
 * card sits at the top — used on the events page to open on the next upcoming
 * show. `scrollToKey` null/undefined ⇒ bounded box that opens at the top.
 */
export function ScrollableEventCardGrid({
  events,
  animationKey,
  scrollToKey,
  scrollTopKey,
}: {
  events: readonly EventDirectoryRow[];
  animationKey?: string;
  scrollToKey?: string | null;
  // When this value changes (e.g. the sort direction toggles), reset the
  // scrollport to the top instead of re-aligning to `scrollToKey`.
  scrollTopKey?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevScrollTopKey = useRef(scrollTopKey);
  // Mirror the StaggeredGrid `md-lg` breakpoints: the column count settles from 1
  // → 2/3 after mount (useGridColumns reads matchMedia in an effect), which moves
  // card positions, so re-run the align once it changes (see plan: "column settle").
  const columns = useGridColumns('md', 'lg');

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // A `scrollTopKey` change (sort toggle) wins over the next-show alignment:
    // the user reordered the list, so show it from the top.
    if (prevScrollTopKey.current !== scrollTopKey) {
      prevScrollTopKey.current = scrollTopKey;
      container.scrollTop = 0;
      return;
    }
    // No target card (e.g. a past-season filter) ⇒ snap back to the top so a new
    // filter pill always opens the list from the start rather than keeping the
    // previous scroll offset.
    if (!scrollToKey) {
      container.scrollTop = 0;
      return;
    }
    const card = container.querySelector<HTMLElement>(
      `[data-grid-key="${CSS.escape(scrollToKey)}"]`
    );
    if (!card) return;
    // Offset math scoped to the container — align the card's top to the box top
    // with enough inset for hover lift/shadow. Not scrollIntoView, which would also
    // scroll the page/ancestors.
    const delta = card.getBoundingClientRect().top - container.getBoundingClientRect().top;
    container.scrollTop += delta - SCROLLABLE_GRID_INSET;
  }, [scrollToKey, scrollTopKey, animationKey, columns]);

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label="Events"
      className={cn(
        // The inset keeps the auto-scrolled target and hovered cards from clipping
        // against the scrollport edges. Bottom padding also reserves the mobile tab
        // bar's height inside the box: `overscroll-contain` stops inner scroll from
        // chaining to the page, so we can't rely on `<main>`'s normal clearance.
        'max-h-[70dvh] overflow-y-auto overscroll-contain scroll-py-4 px-1 pt-4 pb-[calc(var(--bottom-nav-inset)+1rem)]',
        'themed-scrollbar focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background'
      )}
    >
      <StaggeredGrid
        items={events}
        getKey={eventCardKey}
        renderItem={(event) => <EventCard event={event} />}
        variant="md-lg"
        step={0.06}
        animationKey={animationKey}
        viewportRoot={containerRef}
      />
    </div>
  );
}
