import { useMemo } from 'react';
import { useStickyScroll, useSuppressLayoutOnce } from '@/lib/table-interactions';
import { Show } from 'jotai-solid-api';
import { motion, AnimatePresence } from 'motion/react';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Toggle } from '@/components/ui/toggle';
import { ClassBadge } from '@/components/class-badge';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { Icon } from '@/components/icon';
import { StatusCard } from '@/components/status-card';
import { SortableScoreHeader } from '@/components/prediction/score-header';
import { FullRecapTable, type FullEventRecap } from '@/components/prediction/full-recap-table';
import {
  SCORE_COLUMNS,
  scoreValue,
  scoreDecimals,
  fmtRankRange,
  computeRankRanges,
  computedRanges,
  recapGroup,
  RECAP_GROUP_ORDER,
  RECAP_GROUP_LABELS,
  type RecapRow,
  type RangeKey,
  type RecapGroupKey,
  type SortEntry,
  type FullSortEntry,
} from '@/lib/prediction-scenario';
import type { SortMode } from '@/machines/score-table-machine';
import {
  ChartCandlestickIcon as HugeiconsChartCandlestick,
  ChartScatterIcon as HugeiconsChartScatter,
  GroupItemsIcon as HugeiconsGroupItems,
  KeyframeIcon as HugeiconsKeyframe,
  KeyframesDoubleAddIcon as HugeiconsKeyframesDoubleAdd,
  ArrowExpandIcon,
  ArrowShrinkIcon,
  Sorting01Icon as HugeiconsSorting01,
} from '@/components/icons/generated';
import { RecapSectionRow } from '@/components/prediction/recap-section-row';
import { RecapHeadCells } from '@/components/prediction/recap-head-cells';

export interface ScoreRecapTableProps {
  rows: RecapRow[];
  corpsLookup: (row: RecapRow) => { slug: string | null; division: string | null } | undefined;
  title?: string;
  enableRanges?: boolean;
  classFilters: string[];
  onSetClassFilters: (filters: string[]) => void;
  sorts: SortEntry[];
  onCycleSort: (key: RangeKey) => void;
  onSetSorts: (sorts: SortEntry[]) => void;
  sortMode: SortMode;
  onSetSortMode: (mode: SortMode) => void;
  showRanges: boolean;
  onSetShowRanges: (show: boolean) => void;
  groupByClass: boolean;
  onSetGroupByClass: (groupByClass: boolean) => void;
  // Full DCI-style recap (per-judge breakdown). Optional so other consumers of
  // ScoreRecapTable can omit it; when omitted the toggle isn't shown.
  showFullRecap?: boolean;
  onToggleFullRecap?: (next: boolean) => void;
  fullRecap?: FullEventRecap | null;
  fullStatus?: 'idle' | 'loading' | 'error' | 'ready';
  fullSorts?: FullSortEntry[];
  onCycleFullSort?: (key: string) => void;
  onSetFullSorts?: (sorts: FullSortEntry[]) => void;
  yearSlug?: string;
}

export function ScoreRecapTable({
  rows,
  corpsLookup,
  title = 'Recap Scores',
  enableRanges = false,
  classFilters,
  onSetClassFilters,
  sorts,
  onCycleSort,
  onSetSorts,
  sortMode,
  onSetSortMode,
  showRanges,
  onSetShowRanges,
  groupByClass,
  onSetGroupByClass,
  showFullRecap = false,
  onToggleFullRecap,
  fullRecap = null,
  fullStatus = 'idle',
  fullSorts = [],
  onCycleFullSort,
  onSetFullSorts,
  yearSlug,
}: ScoreRecapTableProps) {
  const classFilterActive = classFilters.length > 0;

  // Mirror exactly what the "Clear Filters" button resets (class filters + both
  // sort sets) so it only shows when there's something to clear. Grouping is
  // deliberately excluded — Clear doesn't reset it, and it often defaults on.
  const tableControlsActive = classFilterActive || sorts.length > 0 || fullSorts.length > 0;

  const engageStickyScroll = useStickyScroll();

  const divisions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      if (r.division) set.add(r.division);
    });
    return Array.from(set).sort();
  }, [rows]);

  const visibleRows = useMemo(
    () =>
      classFilters.length === 0
        ? rows
        : rows.filter((r) => r.division && classFilters.includes(r.division)),
    [rows, classFilters]
  );

  const classCount = useMemo(() => {
    const classes = new Set(visibleRows.map((row) => row.division));
    return classes.size;
  }, [visibleRows]);

  // Fewest decimals that show every point score without losing precision, so
  // columns of uniform trailing zeros collapse (all whole → no decimals).
  const scoreDecimalPlaces = useMemo(() => {
    const vals: number[] = [];
    for (const row of visibleRows)
      for (const col of SCORE_COLUMNS) {
        const v = row[col.key];
        if (typeof v === 'number') vals.push(v);
      }
    return scoreDecimals(vals);
  }, [visibleRows]);

  const rankRanges = useMemo(
    () => (showRanges && enableRanges ? computeRankRanges(rows, '0.8') : null),
    [showRanges, enableRanges, rows]
  );

  // Overall (ungrouped) point rank by total score, ties sharing the lower rank.
  // The stored `row.rank` is rank-*within-class*, so it can't be shown directly
  // in the overall ranking. Computed over the full recap so ranks stay overall.
  const overallPointRanks = useMemo(() => {
    const ranks = new Map<string, string>();
    const ranked = rows
      .map((row) => ({
        key: String(row.corps),
        rank: row.rank,
        total: typeof row.total === 'number' && !Number.isNaN(row.total) ? row.total : null,
      }))
      .sort((a, b) => {
        if (a.total !== null && b.total !== null && a.total !== b.total) return b.total - a.total;
        if (a.total === null && b.total !== null) return 1;
        if (a.total !== null && b.total === null) return -1;
        return (a.rank ?? Infinity) - (b.rank ?? Infinity);
      });
    ranked.forEach((entry, index) => {
      const previous = ranked[index - 1];
      if (previous && entry.total !== null && entry.total === previous.total) {
        ranks.set(entry.key, ranks.get(previous.key)!);
      } else {
        ranks.set(entry.key, String(index + 1));
      }
    });
    return ranks;
  }, [rows]);

  const sortedRows = useMemo(() => {
    if (sorts.length === 0) return visibleRows;
    const num = (v: unknown) => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
    return [...visibleRows].sort((a, b) => {
      for (const s of sorts) {
        const av = num(a[s.key]);
        const bv = num(b[s.key]);
        if (av === null && bv === null) continue;
        if (av === null) return 1;
        if (bv === null) return -1;
        if (av !== bv) return s.dir === 'desc' ? bv - av : av - bv;
      }
      return (a.rank ?? Infinity) - (b.rank ?? Infinity);
    });
  }, [visibleRows, sorts]);

  const recapSections = useMemo(() => {
    if (!groupByClass || classCount <= 1)
      return [
        {
          key: null as RecapGroupKey | null,
          label: null as string | null,
          rows: sortedRows,
        },
      ];
    const byGroup = new Map<RecapGroupKey, RecapRow[]>();
    for (const row of sortedRows) {
      const key = recapGroup(row.division);
      const arr = byGroup.get(key);
      if (arr) arr.push(row);
      else byGroup.set(key, [row]);
    }
    return RECAP_GROUP_ORDER.filter((k) => byGroup.has(k)).map((k) => ({
      key: k,
      label: RECAP_GROUP_LABELS[k],
      rows: byGroup.get(k)!,
    }));
  }, [sortedRows, groupByClass, classCount]);

  const rankWithinGroup = useMemo(() => {
    if (!groupByClass || classCount <= 1) return null;

    const ranks = new Map<string, string>();
    for (const section of recapSections) {
      const sectionRanges =
        showRanges && enableRanges ? computeRankRanges(section.rows, '0.8') : null;
      const pointRanks = new Map<string, string>();
      const ranked = section.rows
        .map((row) => ({
          key: String(row.corps),
          rank: row.rank,
          total: typeof row.total === 'number' && !Number.isNaN(row.total) ? row.total : null,
        }))
        .sort((a, b) => {
          if (a.total !== null && b.total !== null && a.total !== b.total) return b.total - a.total;
          if (a.total === null && b.total !== null) return 1;
          if (a.total !== null && b.total === null) return -1;
          return (a.rank ?? Infinity) - (b.rank ?? Infinity);
        });
      ranked.forEach((entry, index) => {
        const previous = ranked[index - 1];
        if (previous && entry.total !== null && entry.total === previous.total) {
          pointRanks.set(entry.key, pointRanks.get(previous.key)!);
        } else {
          pointRanks.set(entry.key, String(index + 1));
        }
      });

      section.rows.forEach((row) => {
        const key = String(row.corps);
        ranks.set(
          key,
          sectionRanges
            ? fmtRankRange(sectionRanges.get(key), pointRanks.get(key))
            : (pointRanks.get(key) ?? '')
        );
      });
    }
    return ranks;
  }, [groupByClass, classCount, recapSections, showRanges, enableRanges]);

  const animateLayout = useSuppressLayoutOnce(showRanges);

  const captionRanks = useMemo(() => {
    const byCol = new Map<RangeKey, Map<string, string>>();
    const scopes =
      groupByClass && classCount > 1 ? recapSections.map((section) => section.rows) : [visibleRows];
    for (const col of SCORE_COLUMNS) {
      const map = new Map<string, string>();
      for (const rows of scopes) {
        if (showRanges) {
          const rowRanges = rows.map((r) => ({
            corps: String(r.corps),
            ranges: computedRanges(r, '0.8'),
          }));
          const cells = rowRanges.map(({ corps, ranges }) => ({
            corps,
            range: ranges[col.key],
          }));
          cells.forEach(({ corps, range }, i) => {
            if (!range) return;
            let above = 0;
            let below = 0;
            cells.forEach(({ range: other }, j) => {
              if (j === i || !other) return;
              if (other.low > range.high) above++;
              if (other.high < range.low) below++;
            });
            map.set(corps, fmtRankRange({ low: 1 + above, high: cells.length - below }, ''));
          });
        } else {
          const ranked = rows
            .map((r) => ({ corps: String(r.corps), v: r[col.key] }))
            .filter((x) => typeof x.v === 'number' && !Number.isNaN(x.v))
            .sort((a, b) => (b.v as number) - (a.v as number));
          ranked.forEach((x, i) => {
            if (i > 0 && x.v === ranked[i - 1].v) map.set(x.corps, map.get(ranked[i - 1].corps)!);
            else map.set(x.corps, String(i + 1));
          });
        }
      }
      byCol.set(col.key, map);
    }
    return byCol;
  }, [visibleRows, groupByClass, classCount, recapSections, showRanges]);

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium text-text-primary pl-[1px]">{title}</h2>

      <Show
        when={rows.length > 0}
        fallback={
          <p className="text-sm text-muted-foreground">No scores available for this event.</p>
        }
      >
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-3 max-sm:[&_button]:text-xs max-sm:[&_svg]:size-3.5">
              <Show when={enableRanges}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toggle
                        variant="outline"
                        pressed={showRanges}
                        onPressedChange={(pressed) => onSetShowRanges(pressed)}
                        aria-label={showRanges ? 'Showing score ranges' : 'Showing point scores'}
                      />
                    }
                  >
                    <Icon
                      icon={showRanges ? HugeiconsChartCandlestick : HugeiconsChartScatter}
                      size="sm"
                    />
                    {showRanges ? 'Ranges' : 'Scores'}
                  </TooltipTrigger>
                  <TooltipContent>
                    {showRanges
                      ? 'Showing likely score ranges — switch to single point scores'
                      : 'Showing single point scores — switch to likely score ranges'}
                  </TooltipContent>
                </Tooltip>
              </Show>

              <Show when={(showFullRecap ? fullSorts : sorts).length > 0}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toggle
                        variant="outline"
                        pressed={sortMode === 'stack'}
                        onPressedChange={(pressed) =>
                          onSetSortMode(pressed ? 'stack' : 'exclusive')
                        }
                        aria-label={
                          sortMode === 'stack' ? 'Stack column sorting' : 'Exclusive column sorting'
                        }
                      />
                    }
                  >
                    <Icon
                      icon={sortMode === 'stack' ? HugeiconsKeyframesDoubleAdd : HugeiconsKeyframe}
                      size="sm"
                    />
                    {sortMode === 'stack' ? 'Stack Sort' : 'Exclusive Sort'}
                  </TooltipTrigger>
                  <TooltipContent>
                    {sortMode === 'stack'
                      ? 'Stacking sorts — new columns become primary, older columns break ties'
                      : 'Sorting one column at a time — switch to stack multiple column sorts'}
                  </TooltipContent>
                </Tooltip>
              </Show>

              <Show when={classCount > 1}>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toggle
                        variant="outline"
                        pressed={groupByClass}
                        onPressedChange={(pressed) => onSetGroupByClass(pressed)}
                        aria-label={groupByClass ? 'Grouped by class' : 'Overall ranking'}
                      />
                    }
                  >
                    <Icon
                      icon={groupByClass ? HugeiconsGroupItems : HugeiconsSorting01}
                      size="sm"
                    />
                    {groupByClass ? 'Group by Class' : 'Overall'}
                  </TooltipTrigger>
                  <TooltipContent>
                    {groupByClass
                      ? 'Grouped by class — switch to overall event ranking'
                      : 'Overall event ranking — switch to class groups'}
                  </TooltipContent>
                </Tooltip>
              </Show>

              <Show when={tableControlsActive}>
                <Separator orientation="vertical" className="h-7" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onSetClassFilters([]);
                    onSetSorts([]);
                    onSetFullSorts?.([]);
                  }}
                >
                  Clear Filters
                </Button>
              </Show>
            </div>

            {/* Compact/Full recap toggle — its own group, pinned to the far right
                of the card on the SAME row as the controls at every breakpoint
                (ml-auto + shrink-0 so it never wraps under the group-by toggle on
                mobile). */}
            <Show when={Boolean(onToggleFullRecap)}>
              <div className="ml-auto flex shrink-0 items-center max-sm:[&_button]:text-xs max-sm:[&_svg]:size-3.5">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toggle
                        variant="outline"
                        pressed={showFullRecap}
                        onPressedChange={(pressed) => onToggleFullRecap?.(pressed)}
                        aria-label={showFullRecap ? 'Showing full recap' : 'Showing compact recap'}
                      />
                    }
                  >
                    <Icon icon={showFullRecap ? ArrowExpandIcon : ArrowShrinkIcon} size="sm" />
                    {showFullRecap ? 'Full Recap' : 'Compact'}
                  </TooltipTrigger>
                  <TooltipContent>
                    {showFullRecap
                      ? 'Showing the full per-judge recap — switch to the compact table'
                      : 'Showing the compact recap — switch to the full per-judge breakdown'}
                  </TooltipContent>
                </Tooltip>
              </div>
            </Show>
          </CardHeader>

          <CardContent className="px-0 py-0 sm:px-2">
            <AnimatePresence mode="popLayout" initial={false}>
              {showFullRecap ? (
                <motion.div
                  key="full"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  {/* Order matters: show the table as soon as we have data, then the
                      error/empty states, and treat every other state (idle *and*
                      loading) as "loading" — so toggling to Full never flashes the
                      "No detailed recap" empty box in the frame before the lazy
                      fetch effect starts. Only a completed fetch ('ready') with no
                      data shows the empty state. */}
                  {fullRecap && fullRecap.corps.length > 0 ? (
                    <FullRecapTable
                      recap={fullRecap}
                      corpsLookup={corpsLookup}
                      classFilters={classFilters}
                      onSetClassFilters={onSetClassFilters}
                      groupByClass={groupByClass}
                      sorts={fullSorts}
                      sortMode={sortMode}
                      onCycleSort={(key) => onCycleFullSort?.(key)}
                      yearSlug={yearSlug}
                      onStickyScroll={engageStickyScroll}
                    />
                  ) : fullStatus === 'error' ? (
                    <div className="px-4 py-6">
                      <StatusCard
                        tone="empty"
                        title="Couldn't load the full recap"
                        description="Please try again."
                      />
                    </div>
                  ) : fullStatus === 'ready' ? (
                    <div className="px-4 py-6">
                      <StatusCard
                        tone="empty"
                        title="No detailed recap"
                        description="A judge-level recap isn't available for this event."
                      />
                    </div>
                  ) : (
                    // Past-season callers preload the recap in the route loader and
                    // always pass fullStatus="ready", so this idle/loading branch is
                    // effectively unreachable there. Kept as a neutral blank frame
                    // (never a "Loading full recap…" message) for any other caller
                    // that wires this prop up to a live fetch.
                    <div className="px-4 py-6" aria-busy="true" />
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="compact"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                >
                  <Table
                    className="min-w-[1040px] text-sm tabular-nums"
                    containerProps={{
                      onWheel: (e) => engageStickyScroll(e.currentTarget),
                      onTouchStart: (e) => engageStickyScroll(e.currentTarget),
                      onScroll: (e) => engageStickyScroll(e.currentTarget),
                    }}
                  >
                    <TableHeader>
                      <TableRow>
                        <RecapHeadCells
                          classFilters={classFilters}
                          onSetClassFilters={onSetClassFilters}
                          divisions={divisions}
                        />
                        {/* Plain .map, NOT <For>: `For` memoizes by item identity and won't
                      re-run for constant SCORE_COLUMNS, freezing sort/range state. */}
                        {SCORE_COLUMNS.map((col) => {
                          const sortIndex = sorts.findIndex((s) => s.key === col.key);
                          const dir = sortIndex >= 0 ? sorts[sortIndex].dir : undefined;
                          return (
                            <SortableScoreHeader
                              key={col.key}
                              col={col}
                              showRanges={showRanges}
                              dir={dir}
                              priority={
                                sortMode === 'stack' && dir !== undefined && sorts.length > 1
                                  ? sortIndex + 1
                                  : null
                              }
                              onSort={() => onCycleSort(col.key)}
                            />
                          );
                        })}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recapSections.flatMap((section) => [
                        ...(section.key !== null
                          ? [
                              <RecapSectionRow
                                key={`header-${section.key}`}
                                sectionKey={section.key}
                                label={section.label ?? ''}
                                trailingColSpan={1 + SCORE_COLUMNS.length}
                              />,
                            ]
                          : []),
                        ...section.rows.map((row) => (
                          <motion.tr
                            key={String(row.corps)}
                            // Shared with the full-recap row of the same corps so a
                            // row morphs between the compact and full tables when the
                            // mode toggles (the two tables alternate in the same
                            // AnimatePresence). Intra-table reorders use `layout`.
                            layoutId={`recap-row-${String(row.corps)}`}
                            layout={animateLayout ? 'position' : false}
                            transition={{
                              type: 'spring',
                              stiffness: 500,
                              damping: 50,
                              mass: 1,
                            }}
                            data-slot="table-row"
                            className="border-b transition-colors hover:bg-muted/60 active:bg-muted/60 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted"
                          >
                            <TableCell className="sticky-col sticky left-0 z-10 w-[48px] min-w-[48px] max-w-[48px] px-1 sm:w-[64px] sm:min-w-[64px] sm:max-w-[64px] sm:px-2 text-center text-muted-foreground">
                              {rankWithinGroup?.get(String(row.corps)) ??
                                (rankRanges
                                  ? fmtRankRange(
                                      rankRanges.get(String(row.corps)),
                                      overallPointRanks.get(String(row.corps))
                                    )
                                  : overallPointRanks.get(String(row.corps)))}
                            </TableCell>
                            <TableCell className="sticky-col sticky-col-edge sticky left-[48px] sm:left-[64px] z-10 font-medium">
                              {(() => {
                                const info = corpsLookup(row);
                                return (
                                  <CorpsNameCell
                                    name={String(row.corps ?? '')}
                                    slug={info?.slug}
                                    corpsKey={
                                      typeof row.corps_key === 'string' ? row.corps_key : null
                                    }
                                  />
                                );
                              })()}
                            </TableCell>
                            <TableCell>
                              <ClassBadge
                                division={row.division ?? corpsLookup(row)?.division ?? undefined}
                              />
                            </TableCell>
                            {SCORE_COLUMNS.map((col) => {
                              const rank = captionRanks.get(col.key)?.get(String(row.corps));
                              // A caption/subtotal that's blank or zero (e.g. totals-only
                              // recaps with no breakdown) renders as a muted em dash
                              // rather than "0.000".
                              const raw = row[col.key];
                              const isBlank = raw == null || (typeof raw === 'number' && raw === 0);
                              return (
                                <TableCell
                                  key={col.key}
                                  className={
                                    'relative py-3.5 text-right font-mono' +
                                    (col.key === 'total' ? ' font-bold' : '') +
                                    (col.separator ? ' border-r border-border pr-4' : '')
                                  }
                                >
                                  {isBlank ? (
                                    <span className="block w-full text-center text-muted-foreground/40">
                                      —
                                    </span>
                                  ) : (
                                    scoreValue(row, col.key, showRanges, '0.8', scoreDecimalPlaces)
                                  )}
                                  {rank ? (
                                    <span className="pointer-events-none absolute inset-x-0 bottom-[4.5px] text-center text-[10px] font-normal leading-none text-muted-foreground/50 tabular-nums">
                                      {rank}
                                    </span>
                                  ) : null}
                                </TableCell>
                              );
                            })}
                          </motion.tr>
                        )),
                      ])}
                    </TableBody>
                  </Table>
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </Show>
    </section>
  );
}
