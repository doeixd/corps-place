import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { ClassBadge } from '@/components/class-badge';
import { RecapSectionRow } from '@/components/prediction/recap-section-row';
import { RecapHeadCells } from '@/components/prediction/recap-head-cells';
import { Table } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  fmt,
  scoreDecimals,
  type FullSortEntry,
  type SortMode,
  type RecapRow,
} from '@/lib/prediction-scenario';
import {
  buildFullRecapModel,
  computeLeafRanks,
  computeRowRanks,
  fullClassCount,
  groupFullCorps,
  indexCorps,
  judgeLabel,
  leafTooltip,
  leafValue,
  sortFullCorps,
  type CategoryBand,
  type CorpsIndex,
  type FullLeaf,
  type LeafJudge,
} from '@/lib/full-recap';
import type { getHybridEventFullRecap } from '@/lib/server-fns/hybrid';
import { ArrowDown01Icon as HugeiconsArrowDown01 } from '@/components/icons/generated';

// Derive the recap types from the server fn return so the client bundle doesn't
// import SDK internals.
export type FullEventRecap = Awaited<ReturnType<typeof getHybridEventFullRecap>>;
export type FullRecapCorps = FullEventRecap['corps'][number];
export type FullRecapCategory = FullRecapCorps['categories'][number];
export type FullRecapCaption = FullRecapCategory['captions'][number];
export type FullRecapJudge = FullRecapCaption['judges'][number];
export type FullRecapSubcaption = FullRecapJudge['subcaptions'][number];

interface FullRecapTableProps {
  recap: FullEventRecap;
  corpsLookup: (row: RecapRow) => { slug: string | null; division: string | null } | undefined;
  classFilters: string[];
  onSetClassFilters: (filters: string[]) => void;
  groupByClass: boolean;
  sorts: FullSortEntry[];
  sortMode: SortMode;
  onCycleSort: (key: string) => void;
  yearSlug?: string;
  onStickyScroll: (el: HTMLElement) => void;
  /**
   * Animate row reorders (Motion `layout`/`layoutId`). Default on. Turn OFF when
   * many recap tables are mounted together (the `/scores` index): a shared
   * `layoutId` across simultaneous tables makes Motion animate one node between
   * them, which reads as page-wide layout shift.
   */
  animateRows?: boolean;
}

// Match the compact table's frozen columns: Rank (48/64px) + Corps, both keyed
// off `.sticky-col` (app.css) which paints the bg + edge divider and only pins
// once `engageStickyScroll` sets `data-scrolled` on the container.
const RANK_COL =
  'sticky-col sticky left-0 w-[48px] min-w-[48px] max-w-[48px] px-1 sm:w-[64px] sm:min-w-[64px] sm:max-w-[64px] sm:px-2 text-center';
const CORPS_COL =
  'sticky-col sticky-col-edge sticky left-[48px] sm:left-[64px] text-left font-medium';

/**
 * DCI-style full recap: one row per corps; caption columns grouped by category,
 * each split into per-judge sub-columns (Rep·Perf / Cont·Achv + TOT), with
 * category subtotals, overall Sub Total, Penalties and Total. Every leaf is
 * sortable; class grouping inserts section rows; ranks recompute over the
 * visible/grouped scope. Horizontally scrollable.
 */
export function FullRecapTable({
  recap,
  corpsLookup,
  classFilters,
  onSetClassFilters,
  groupByClass,
  sorts,
  sortMode,
  onCycleSort,
  yearSlug,
  onStickyScroll,
  animateRows = true,
}: FullRecapTableProps) {
  const allCorps = recap.corps;

  const model = useMemo(() => buildFullRecapModel(allCorps), [allCorps]);
  const index = useMemo(() => {
    const m = new Map<string, CorpsIndex>();
    for (const c of allCorps) m.set(c.corpsKey, indexCorps(c));
    return m;
  }, [allCorps]);
  const leafById = useMemo(() => {
    const m = new Map<string, FullLeaf>();
    for (const l of model.leaves) m.set(l.id, l);
    return m;
  }, [model]);

  const classCount = useMemo(() => fullClassCount(allCorps), [allCorps]);
  const divisions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allCorps) if (c.division) set.add(c.division);
    return Array.from(set).sort();
  }, [allCorps]);

  const visible = useMemo(
    () =>
      classFilters.length === 0
        ? allCorps
        : allCorps.filter((c) => c.division && classFilters.includes(c.division)),
    [allCorps, classFilters]
  );
  const sorted = useMemo(
    () => sortFullCorps(visible, index, leafById, sorts, sortMode),
    [visible, index, leafById, sorts, sortMode]
  );
  const sections = useMemo(
    () => groupFullCorps(sorted, groupByClass, classCount),
    [sorted, groupByClass, classCount]
  );
  const leafRanks = useMemo(
    () => computeLeafRanks(sections, index, model.leaves),
    [sections, index, model.leaves]
  );
  const rowRanks = useMemo(() => computeRowRanks(sections), [sections]);

  // Fewest decimals that show every score in the grid without losing precision,
  // so columns of uniform trailing zeros collapse (all whole → no decimals).
  const decimals = useMemo(() => {
    const vals: number[] = [];
    for (const idx of index.values())
      for (const leaf of model.leaves) {
        const v = leafValue(leaf, idx);
        if (typeof v === 'number') vals.push(v);
      }
    return scoreDecimals(vals);
  }, [index, model]);

  // Total grid width: rank + corps + class + every leaf.
  const totalCols = 3 + model.leaves.length;
  const sortDir = (id: string) => sorts.find((s) => s.key === id)?.dir;
  const sortPriority = (id: string) => {
    if (sortMode !== 'stack' || sorts.length <= 1) return null;
    const i = sorts.findIndex((s) => s.key === id);
    return i >= 0 ? i + 1 : null;
  };

  return (
    <Table
      className="w-max min-w-full border-collapse text-sm tabular-nums"
      // Round the top corners to match the card's rounded bottom. With
      // `overflow-x-auto` the y-axis computes to `auto`, so the container clips
      // its contents to this radius (top corners) while horizontal scroll still
      // works.
      containerClassName="overflow-x-auto rounded-t-xl"
      containerProps={{
        onWheel: (e) => onStickyScroll(e.currentTarget),
        onTouchStart: (e) => onStickyScroll(e.currentTarget),
        onScroll: (e) => onStickyScroll(e.currentTarget),
      }}
    >
      <thead className="text-text-secondary [&_th]:whitespace-nowrap">
        {/* Tier 1 — category bands. No row border-b: the category→caption line is
            each caption's own top border, so the Sub column (no top border) reads
            as a continuous strip up to the category header. */}
        <tr>
          <RecapHeadCells
            rowSpan={4}
            classFilters={classFilters}
            onSetClassFilters={onSetClassFilters}
            divisions={divisions}
          />
          {model.bands.map((band) => (
            <th
              key={band.category}
              colSpan={band.judges.reduce((n, j) => n + j.leaves.length, 0) + 1}
              className="border-l border-border bg-muted/70 px-2 py-2 text-center text-sm font-semibold text-foreground/85"
            >
              {band.category}
            </th>
          ))}
          {model.tails.map((t) => (
            <SortableLeafHeader
              key={t.leaf.id}
              rowSpan={4}
              leaf={t.leaf}
              dir={sortDir(t.leaf.id)}
              priority={sortPriority(t.leaf.id)}
              onSort={() => onCycleSort(t.leaf.id)}
              className={cn(
                'border-l border-r border-border bg-muted/50 px-2 py-1.5 align-bottom font-semibold text-text-primary',
                // The grand Total column stands out: darker fill + a heavier left
                // border to separate it from the per-judge breakdown.
                t.leaf.kind === 'total' && 'bg-foreground/5 border-l-foreground/30'
              )}
            />
          ))}
        </tr>
        {/* Tier 2 — captions (span their judges) + the category "Sub" column */}
        <tr className="border-b border-border text-xs">
          {model.bands.map((band, i) => (
            <CaptionHeaders
              key={band.category}
              band={band}
              lastBand={i === model.bands.length - 1}
              sortDir={sortDir}
              sortPriority={sortPriority}
              onCycleSort={onCycleSort}
            />
          ))}
        </tr>
        {/* Tier 3 — judges nested under their caption. No row border-b: the
            judge→sub-label line is each sub-label's own top border, so the TOT
            column (no top border) reads as a continuous strip up to its judge. */}
        <tr className="text-xs">
          {model.bands.map((band) => (
            <JudgeHeaders key={band.category} band={band} yearSlug={yearSlug} />
          ))}
        </tr>
        {/* Tier 4 — sortable sub-labels */}
        <tr className="border-b border-border text-xs">
          {model.bands.map((band) => (
            <SubLabelHeaders
              key={band.category}
              band={band}
              sortDir={sortDir}
              sortPriority={sortPriority}
              onCycleSort={onCycleSort}
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {sections.flatMap((section) => [
          ...(section.key !== null
            ? [
                <RecapSectionRow
                  key={`header-${section.key}`}
                  sectionKey={section.key}
                  label={section.label ?? ''}
                  trailingColSpan={totalCols - 2}
                />,
              ]
            : []),
          ...section.corps.map((c) => {
            const idx = index.get(c.corpsKey)!;
            const info = corpsLookup({
              corps_key: c.corpsKey,
              corps: c.corps,
            } as RecapRow);
            return (
              <motion.tr
                key={c.corps}
                {...(animateRows
                  ? {
                      layoutId: `recap-row-${c.corps}`,
                      layout: 'position' as const,
                      transition: { type: 'spring', stiffness: 500, damping: 50, mass: 1 },
                    }
                  : {})}
                data-slot="table-row"
                className="border-b border-border/60 transition-colors hover:bg-muted/60 active:bg-muted/60 last:border-0"
              >
                <td className={cn(RANK_COL, 'z-10 py-2.5 align-middle text-muted-foreground')}>
                  {rowRanks.get(c.corpsKey) ?? c.rank ?? '–'}
                </td>
                <td className={cn(CORPS_COL, 'z-10 px-3 py-2.5 align-middle')}>
                  <CorpsNameCell name={c.corps} slug={info?.slug} corpsKey={c.corpsKey} />
                </td>
                <td className="px-3 py-2.5 align-middle">
                  <ClassBadge division={c.division ?? info?.division ?? undefined} />
                </td>
                {model.bands.map((band, bi) => (
                  <BandCells
                    key={band.category}
                    band={band}
                    lastBand={bi === model.bands.length - 1}
                    idx={idx}
                    corpsKey={c.corpsKey}
                    leafRanks={leafRanks}
                    decimals={decimals}
                  />
                ))}
                {model.tails.map((t) => (
                  <ValueCell
                    key={t.leaf.id}
                    value={leafValue(t.leaf, idx)}
                    rank={leafRanks.get(t.leaf.id)?.get(c.corpsKey)}
                    decimals={decimals}
                    className={cn(
                      'border-l border-r border-border bg-muted/50 px-2',
                      (t.leaf.kind === 'total' || t.leaf.kind === 'subtotal') &&
                        'font-bold text-text-primary',
                      // Match the header: darker fill + heavier left border so the
                      // grand Total column reads as distinct from the breakdown.
                      t.leaf.kind === 'total' && 'bg-foreground/5 border-l-foreground/30'
                    )}
                  />
                ))}
              </motion.tr>
            );
          }),
        ])}
      </tbody>
    </Table>
  );
}

// Tier 2 — caption labels spanning their judges, plus the category "Sub" column
// (which spans tiers 2–4 and is itself sortable).
function CaptionHeaders({
  band,
  lastBand,
  sortDir,
  sortPriority,
  onCycleSort,
}: {
  band: CategoryBand;
  lastBand?: boolean;
  sortDir: (id: string) => 'asc' | 'desc' | undefined;
  sortPriority: (id: string) => number | null;
  onCycleSort: (id: string) => void;
}) {
  return (
    <>
      {band.captions.map((cap, ci) => (
        <th
          key={cap.caption}
          colSpan={cap.judges.reduce((n, j) => n + j.leaves.length, 0)}
          className={cn(
            'border-t border-r border-border px-2 py-1.5 text-center align-bottom font-medium text-foreground',
            ci === 0 && 'border-l border-border'
          )}
        >
          {cap.caption}
        </th>
      ))}
      {/* Category "Sub" spans tiers 2–4 and is sortable; right border closes the
          band. Shares the caption row's darker shade and has no top border, so it
          reads as one continuous strip up to the category header. */}
      <th
        rowSpan={3}
        className={cn(
          'border-r border-border bg-muted/70 px-2 py-1.5 align-bottom text-center font-medium text-foreground',
          // Last band's Sub column abuts the grand Total: color this shared edge
          // to match the Total's dark left border (border-collapse draws the line
          // from both cells, so both must agree to render consistently).
          lastBand && 'border-r-foreground/30'
        )}
      >
        <SortButton
          leaf={band.subLeaf}
          dir={sortDir(band.subLeaf.id)}
          priority={sortPriority(band.subLeaf.id)}
          onSort={() => onCycleSort(band.subLeaf.id)}
        />
      </th>
    </>
  );
}

// Tier 3 — judges nested under their caption.
function JudgeHeaders({ band, yearSlug }: { band: CategoryBand; yearSlug?: string }) {
  let first = true;
  return (
    <>
      {band.captions.flatMap((cap) =>
        cap.judges.map((j) => {
          const isFirst = first;
          first = false;
          return (
            <th
              key={`${j.caption}~${j.judge.id}`}
              colSpan={j.leaves.length}
              className={cn(
                'border-r border-border bg-muted/50 px-2 py-1.5 text-center align-bottom',
                isFirst && 'border-l border-border'
              )}
            >
              <JudgeLink judge={j.judge} yearSlug={yearSlug} />
            </th>
          );
        })
      )}
    </>
  );
}

// Tier 4 — sortable sub-labels (Rep/Perf/Cont/Achv + TOT). TOT closes each judge
// group with a right border.
function SubLabelHeaders({
  band,
  sortDir,
  sortPriority,
  onCycleSort,
}: {
  band: CategoryBand;
  sortDir: (id: string) => 'asc' | 'desc' | undefined;
  sortPriority: (id: string) => number | null;
  onCycleSort: (id: string) => void;
}) {
  let first = true;
  return (
    <>
      {band.judges.flatMap((j) =>
        j.leaves.map((leaf) => {
          const isFirst = first;
          first = false;
          return (
            <SortableLeafHeader
              key={leaf.id}
              leaf={leaf}
              dir={sortDir(leaf.id)}
              priority={sortPriority(leaf.id)}
              onSort={() => onCycleSort(leaf.id)}
              className={cn(
                'px-2 py-1.5',
                isFirst && 'border-l border-border',
                leaf.kind === 'judgeTot'
                  ? 'border-r border-border bg-muted/50'
                  : 'border-t border-border'
              )}
            />
          );
        })
      )}
    </>
  );
}

function JudgeLink({ judge, yearSlug }: { judge: LeafJudge; yearSlug?: string }) {
  const label = judgeLabel(judge);
  if (!judge.id) return <span className="font-medium text-text-primary">{label}</span>;
  return (
    <Link
      to="/judges/$judgeId"
      params={{ judgeId: judge.id }}
      search={yearSlug ? { season: yearSlug } : undefined}
      className="font-medium text-text-primary underline decoration-dotted decoration-muted-foreground/30 underline-offset-2 hover:text-primary"
    >
      {label}
    </Link>
  );
}

function BandCells({
  band,
  lastBand,
  idx,
  corpsKey,
  leafRanks,
  decimals,
}: {
  band: CategoryBand;
  lastBand?: boolean;
  idx: CorpsIndex;
  corpsKey: string;
  leafRanks: Map<string, Map<string, string>>;
  decimals: number;
}) {
  let first = true;
  return (
    <>
      {band.judges.flatMap((j) =>
        j.leaves.map((leaf) => {
          const isFirst = first;
          first = false;
          return (
            <ValueCell
              key={leaf.id}
              value={leafValue(leaf, idx)}
              rank={leafRanks.get(leaf.id)?.get(corpsKey)}
              decimals={decimals}
              className={cn(
                'px-2',
                isFirst && 'border-l border-border',
                // Subcaption (Rep/Perf, Cont/Achv) scores read slightly softer
                // than the judge total / category subtotal columns.
                leaf.kind === 'subcaption' && 'text-foreground/70',
                leaf.kind === 'judgeTot' &&
                  'border-r border-border bg-muted/50 font-medium text-text-primary'
              )}
            />
          );
        })
      )}
      <ValueCell
        value={leafValue(band.subLeaf, idx)}
        rank={leafRanks.get(band.subLeaf.id)?.get(corpsKey)}
        decimals={decimals}
        className={cn(
          'border-r border-border bg-muted/70 px-2 font-bold text-text-primary',
          // Match the grand Total's dark left border on the shared edge (see CaptionHeaders).
          lastBand && 'border-r-foreground/30'
        )}
      />
    </>
  );
}

function ValueCell({
  value,
  rank,
  className,
  decimals = 3,
}: {
  value: number | null;
  rank?: string;
  className?: string;
  decimals?: number;
}) {
  return (
    <td className={cn('relative py-2.5 text-center font-mono align-middle', className)}>
      {value == null || value === 0 ? (
        <span className="text-muted-foreground/40">—</span>
      ) : (
        <span>{fmt(value, decimals)}</span>
      )}
      {rank ? (
        <span className="pointer-events-none absolute inset-x-0 bottom-[3px] text-center text-[10px] font-normal leading-none text-muted-foreground/50">
          {rank}
        </span>
      ) : null}
    </td>
  );
}

/** The inner sort control (label + cycling arrow + priority + tooltip). No `<th>`. */
function SortButton({
  leaf,
  dir,
  priority,
  onSort,
}: {
  leaf: FullLeaf;
  dir: 'asc' | 'desc' | undefined;
  priority: number | null;
  onSort: () => void;
}) {
  const active = dir !== undefined;
  return (
    <span className="inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onSort}
              aria-label={active ? `Sorted ${leaf.label} ${dir}` : `Sort by ${leaf.label}`}
              className={cn(
                "relative inline-flex items-center transition-colors before:absolute before:-inset-2 before:content-['']",
                active ? 'text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground'
              )}
            />
          }
        >
          <span className="text-[11px]">{leaf.label}</span>
          <motion.span
            className={cn(
              'inline-flex transition-[filter] duration-200',
              active && 'drop-shadow-[0_0_6px_var(--primary)]'
            )}
            animate={{ rotate: dir === 'asc' ? 180 : 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <Icon icon={HugeiconsArrowDown01} size="sm" className="size-3" />
          </motion.span>
          {priority !== null ? (
            <span className="ml-0.5 text-[9px] font-semibold leading-none">{priority}</span>
          ) : null}
        </TooltipTrigger>
        <TooltipContent>{leafTooltip(leaf)}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/** A sortable leaf-column header (`<th>` + `SortButton`). */
function SortableLeafHeader({
  leaf,
  dir,
  priority,
  onSort,
  className,
  rowSpan,
}: {
  leaf: FullLeaf;
  dir: 'asc' | 'desc' | undefined;
  priority: number | null;
  onSort: () => void;
  className?: string;
  rowSpan?: number;
}) {
  return (
    <th
      rowSpan={rowSpan}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
      className={cn('text-center font-medium', className)}
    >
      <SortButton leaf={leaf} dir={dir} priority={priority} onSort={onSort} />
    </th>
  );
}
