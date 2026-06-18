import { useMachine } from '@xstate/react';
import { Show, For } from 'jotai-solid-api';
import { motion } from 'motion/react';
import { PageHeader } from '@/components/page-header';
import { PageShell } from '@/components/page-shell';
import { StatusCard } from '@/components/status-card';
import { StatusPill } from '@/components/status-pill';
import { Icon } from '@/components/icon';
import { EventSeasonTitle } from '@/components/prediction/event-season-title';
import { ScoreRecapTable } from '@/components/prediction/score-recap-table';
import type { FullEventRecap } from '@/components/prediction/full-recap-table';
import { LineupSchedule } from '@/components/prediction/lineup-schedule';
import { scoreTableMachine, scoreTableSearchCodec } from '@/machines/score-table-machine';
import { useSearchSync } from '@/lib/use-search-sync';
import { formatEventDate } from '@/lib/format';
import { fadeIn } from '@/lib/motion-variants';
import type { RecapRow } from '@/lib/prediction-scenario';
import type { EventDirectoryRow, EventScheduleRow, EventSeasonOption } from '@/lib/event-directory';
import { dciLinks } from '@/lib/dci-links';
import type { IconComponent } from '@/components/icon';
import type { ShowInfoSummary } from '@sdk/src/readModel/builders/shows.js';
import {
  Clock01Icon as TimesIcon,
  JusticeScale01Icon as JudgesIcon,
  Location01Icon as LocationIcon,
  RankingIcon as ScoresIcon,
  UserMultipleIcon as LineupIcon,
} from '@/components/icons/generated';

const READINESS_CHIPS: {
  label: string;
  icon: IconComponent;
  iconClassName: string;
  ready: (e: EventDirectoryRow) => boolean;
}[] = [
  {
    label: 'Lineup',
    icon: LineupIcon,
    iconClassName: 'group-hover:text-info',
    ready: (e) => (e.lineup_entries ?? 0) > 0,
  },
  {
    label: 'Times',
    icon: TimesIcon,
    iconClassName: 'group-hover:text-focus',
    ready: (e) => Boolean(e.all_times_present),
  },
  {
    label: 'Judges',
    icon: JudgesIcon,
    iconClassName: 'group-hover:text-warning',
    ready: (e) => (e.judge_assignments ?? 0) > 0,
  },
  {
    label: 'Scores',
    icon: ScoresIcon,
    iconClassName: 'group-hover:text-success',
    ready: (e) => Boolean(e.scores_released),
  },
];

const eventLabel = (slug: string) =>
  slug
    .split('-')
    .filter(Boolean)
    .filter((part, index) => index !== 0 || !/^\d{4}$/.test(part))
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

export interface PastSeasonScoresPageProps {
  yearSlug: string;
  slug: string;
  event: EventDirectoryRow | null;
  recap: { scores: RecapRow[] } | null;
  /** SSR-seeded full recap when the page loads with `?recap=full`; else null. */
  seededFullRecap?: FullEventRecap | null;
  schedule: EventScheduleRow[];
  corpsLookup: (row: RecapRow) => { slug: string | null; division: string | null } | undefined;
  seasonOptions: EventSeasonOption[];
  showTitles?: Record<string, string>;
  showInfo?: Record<string, ShowInfoSummary>;
  search: Record<string, unknown>;
  navigate: (opts: {
    search: Record<string, unknown>;
    replace?: boolean;
    resetScroll?: boolean;
  }) => void;
}

export function PastSeasonScoresPage({
  yearSlug,
  slug,
  event,
  recap,
  seededFullRecap = null,
  schedule,
  corpsLookup,
  seasonOptions,
  showTitles,
  showInfo,
  search,
  navigate,
}: PastSeasonScoresPageProps) {
  const [snapshot, send] = useMachine(scoreTableMachine, {
    input: { rows: recap?.scores ?? [], ...scoreTableSearchCodec.decode(search) },
  });

  useSearchSync({
    context: snapshot.context,
    send,
    search,
    codec: scoreTableSearchCodec,
    navigate: ({ search: s, replace, resetScroll }) =>
      navigate({ search: s, replace, resetScroll }),
    ready: true,
  });

  const ctx = snapshot.context;
  // Past-season pages render off real recap/score data, so DCI's recap and
  // final-scores pages exist regardless of the (often stale) released flags.
  const hasScoreData = (recap?.scores?.length ?? 0) > 0;
  const dci = dciLinks(event, slug, {
    hasRecap: seededFullRecap != null || hasScoreData,
    hasScores: hasScoreData,
  });
  const readinessChips = event ? READINESS_CHIPS.filter((chip) => chip.ready(event)) : [];

  // Full DCI-style recap. The expanded/collapsed flag lives in the machine (and
  // the URL via ?recap=full). The payload itself is fetched in the route loader
  // (always preloaded for past seasons — SSR'd / preloaded-on-intent), so it's
  // already in hand here: no client fetch, no loading state, and the "Loading
  // full recap…" view can't occur. `null` means the event has no judge recap.
  const showFull = ctx.showFullRecap;
  const fullRecap = seededFullRecap;
  const fullStatus = 'ready' as const;
  const toggleFullRecap = (next: boolean) =>
    send({ type: 'SET_SHOW_FULL_RECAP', showFullRecap: next });

  return (
    <PageShell>
      <PageHeader
        className="mb-8"
        title={
          <EventSeasonTitle
            year={yearSlug}
            label={event?.event_name ?? event?.name ?? eventLabel(slug) ?? 'Event'}
            dci={dci}
            seasons={seasonOptions}
          />
        }
        titleClassName="text-3xl pb-2"
        subtitle={
          <span className="flex flex-nowrap items-center gap-x-1.5 overflow-x-auto pr-4 text-sm text-text-secondary [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="shrink-0">{event ? formatEventDate(event.start_date) : ''}</span>
            <Show when={event?.location_city}>
              {(city) => (
                <>
                  <span className="shrink-0 text-text-muted">•</span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <Icon icon={LocationIcon} size="sm" className="size-3.5" />
                    {city}
                    <Show when={event && event.location_state}>{(state) => `, ${state}`}</Show>
                  </span>
                </>
              )}
            </Show>
            <Show when={readinessChips.length > 0}>
              <span className="shrink-0 text-text-muted">•</span>
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <For each={readinessChips}>
                  {(chip) => (
                    <StatusPill
                      label={chip.label}
                      active
                      icon={chip.icon}
                      iconClassName={chip.iconClassName}
                    />
                  )}
                </For>
              </span>
            </Show>
          </span>
        }
        backTo="/events/$yearSlug"
        backParams={{ yearSlug }}
        backLabel="Back to Events"
      />
      <motion.div className="space-y-4" variants={fadeIn} initial={false} animate="visible">
        {recap && recap.scores.length > 0 ? (
          <ScoreRecapTable
            rows={ctx.rows}
            corpsLookup={corpsLookup}
            title="Scores"
            classFilters={ctx.classFilters}
            onSetClassFilters={(filters) =>
              send({ type: 'SET_CLASS_FILTERS', classFilters: filters })
            }
            sorts={ctx.sorts}
            onCycleSort={(key) => send({ type: 'CYCLE_SORT', key })}
            onSetSorts={(sorts) => send({ type: 'SET_SORTS', sorts })}
            sortMode={ctx.sortMode}
            onSetSortMode={(mode) => send({ type: 'SET_SORT_MODE', mode })}
            showRanges={ctx.showRanges}
            onSetShowRanges={(show) => send({ type: 'SET_SHOW_RANGES', showRanges: show })}
            groupByClass={ctx.groupByClass}
            onSetGroupByClass={(groupByClass) => send({ type: 'SET_GROUP_BY_CLASS', groupByClass })}
            showFullRecap={showFull}
            onToggleFullRecap={toggleFullRecap}
            fullRecap={fullRecap}
            fullStatus={fullStatus}
            fullSorts={ctx.fullSorts}
            onCycleFullSort={(key) => send({ type: 'CYCLE_FULL_SORT', key })}
            onSetFullSorts={(sorts) => send({ type: 'SET_FULL_SORTS', sorts })}
            yearSlug={yearSlug}
          />
        ) : (
          <StatusCard
            tone="info"
            title="No scores"
            description="No scores are available for this event."
          />
        )}
        <LineupSchedule
          event={event}
          schedule={schedule}
          showTitles={showTitles}
          showInfo={showInfo}
          corpsLookup={(row) =>
            corpsLookup({ corps_key: row.corps_key, corps: row.unit_name } as RecapRow)
          }
        />
      </motion.div>
    </PageShell>
  );
}
