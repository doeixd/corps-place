import { useMemo } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon';
import { CorpsNameCell } from '@/components/corps-name-cell';
import { ClassBadge } from '@/components/class-badge';
import { RecapSectionRow } from '@/components/prediction/recap-section-row';
import { RecapHeadCells } from '@/components/prediction/recap-head-cells';
import { Table } from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { StatusCard } from '@/components/status-card';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useStickyScroll } from '@/lib/table-interactions';
import {
  CAPTIONS,
  fmt,
  scoreDecimals,
  recapGroup,
  RECAP_GROUP_ORDER,
  RECAP_GROUP_LABELS,
  type Caption,
  type RangeKey,
  type SortEntry,
  type SortMode,
  type RecapGroupKey,
  type RecapRow,
} from '@/lib/prediction-scenario';
import type { DiffCaption, DiffRow } from '@/lib/diff';
import { ArrowDown01Icon as HugeiconsArrowDown01 } from '@/components/icons/generated';

interface DiffRecapTableProps {
  rows: DiffRow[];
  corpsLookup: (row: RecapRow) => { slug: string | null; division: string | null } | undefined;
  classFilters: string[];
  onSetClassFilters: (filters: string[]) => void;
  groupByClass: boolean;
  diffSorts: SortEntry[];
  sortMode: SortMode;
  /**
   * Cycle the sort on a subcaption band. `diffSorts` is keyed by the caption
   * (`RangeKey`) and the machine mirrors direction onto the Scores/Prediction
   * sort lists, so the Diff view always sorts a band by its `± Diff` value.
   */
  onCycleSort: (key: RangeKey) => void;
  yearSlug?: string;
}

// Match the compact/full recap frozen columns (see full-recap-table.tsx): Rank +
// Corps pin once `engageStickyScroll` sets `data-scrolled` on the container.
const RANK_COL =
  'sticky-col sticky left-0 w-[48px] min-w-[48px] max-w-[48px] px-1 sm:w-[64px] sm:min-w-[64px] sm:max-w-[64px] sm:px-2 text-center';
const CORPS_COL =
  'sticky-col sticky-col-edge sticky left-[48px] sm:left-[64px] text-left font-medium';

const SUB_LABELS = [
  { kind: 'scored' as const, label: 'Score' },
  { kind: 'predicted' as const, label: 'Pred' },
  { kind: 'diff' as const, label: '±Diff' },
];

// The banded columns: the Total aggregate first (matching the Scores/Prediction
// recap column order, where Total leads), then the 8 subcaptions. Each band is
// split into the Score | Pred | ±Diff sub-columns above.
type BandKey = 'total' | Caption;
const BANDS: { key: BandKey; label: string; emphasis?: boolean }[] = [
  { key: 'total', label: 'Total', emphasis: true },
  ...CAPTIONS.map((c) => ({ key: c as BandKey, label: c })),
];
const bandCaption = (row: DiffRow, key: BandKey): DiffCaption =>
  key === 'total' ? row.total : row.captions[key];

const numOrNull = (v: number | null): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Scored-vs-predicted diff table: one row per corps, a leading Total band plus
 * the 8 subcaptions (GE1…MP), each split into `Score | Pred | ±Diff` sub-columns.
 * Diff cells are signed, colored by direction (`--diff-positive` /
 * `--diff-negative`) with a background tint scaled by that column's absolute-diff
 * magnitude. Sticky Rank+Corps, horizontal
 * scroll, per-band diff sort, class grouping + per-scope diff ranks — mirroring
 * the conventions in full-recap-table.tsx / score-recap-table.tsx.
 */
export function DiffRecapTable({
  rows,
  corpsLookup,
  classFilters,
  onSetClassFilters,
  groupByClass,
  diffSorts,
  sortMode,
  onCycleSort,
  yearSlug,
}: DiffRecapTableProps) {
  const engageStickyScroll = useStickyScroll();

  const divisions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.division) set.add(r.division);
    return Array.from(set).sort();
  }, [rows]);

  const visibleRows = useMemo(
    () =>
      classFilters.length === 0
        ? rows
        : rows.filter((r) => r.division && classFilters.includes(r.division)),
    [rows, classFilters]
  );

  const classCount = useMemo(() => new Set(visibleRows.map((r) => r.division)).size, [visibleRows]);

  // Fewest decimals across every value in the grid so uniform trailing zeros
  // collapse, matching the recap tables.
  const decimals = useMemo(() => {
    const vals: number[] = [];
    for (const row of visibleRows)
      for (const band of BANDS) {
        const c = bandCaption(row, band.key);
        for (const v of [c.scored, c.predicted, c.diff])
          if (typeof v === 'number') vals.push(Math.abs(v));
      }
    return scoreDecimals(vals);
  }, [visibleRows]);

  // Apply the active diff sort (keyed by caption → sorts by that caption's diff).
  // Falls back to the stored rank so order is stable when nothing is sorted.
  const sortedRows = useMemo(() => {
    if (diffSorts.length === 0) return visibleRows;
    return [...visibleRows].sort((a, b) => {
      for (const s of diffSorts) {
        const av = numOrNull(bandCaption(a, s.key as BandKey)?.diff ?? null);
        const bv = numOrNull(bandCaption(b, s.key as BandKey)?.diff ?? null);
        if (av === null && bv === null) continue;
        if (av === null) return 1;
        if (bv === null) return -1;
        if (av !== bv) return s.dir === 'desc' ? bv - av : av - bv;
      }
      return (a.rank ?? Infinity) - (b.rank ?? Infinity);
    });
  }, [visibleRows, diffSorts]);

  const sections = useMemo(() => {
    if (!groupByClass || classCount <= 1)
      return [
        { key: null as RecapGroupKey | null, label: null as string | null, rows: sortedRows },
      ];
    const byGroup = new Map<RecapGroupKey, DiffRow[]>();
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

  // Per-scope (grouped / overall) diff rank per subcaption, like computeLeafRanks
  // in the full recap: higher diff = rank 1, ties share. Keyed `cap` → corps_key.
  const diffRanks = useMemo(() => {
    const scopes = groupByClass && classCount > 1 ? sections.map((s) => s.rows) : [visibleRows];
    const byCap = new Map<BandKey, Map<string, string>>();
    for (const band of BANDS) {
      const map = new Map<string, string>();
      for (const scope of scopes) {
        const ranked = scope
          .map((r) => ({ key: r.corps_key, v: numOrNull(bandCaption(r, band.key).diff) }))
          .filter((x) => x.v !== null)
          .sort((a, b) => (b.v as number) - (a.v as number));
        ranked.forEach((x, i) => {
          if (i > 0 && x.v === ranked[i - 1].v) map.set(x.key, map.get(ranked[i - 1].key)!);
          else map.set(x.key, String(i + 1));
        });
      }
      byCap.set(band.key, map);
    }
    return byCap;
  }, [sections, visibleRows, groupByClass, classCount]);

  // Per-column magnitude scale: the max absolute diff in each subcaption column
  // across the visible rows. A small GE1 diff (range ~0.5) tints as strongly as a
  // larger MB diff — the scale is relative to each column's own spread (Q4).
  const maxAbsDiff = useMemo(() => {
    const m = new Map<BandKey, number>();
    for (const band of BANDS) {
      let max = 0;
      for (const r of visibleRows) {
        const d = numOrNull(bandCaption(r, band.key).diff);
        if (d !== null) max = Math.max(max, Math.abs(d));
      }
      m.set(band.key, max);
    }
    return m;
  }, [visibleRows]);

  const sortDir = (key: RangeKey) => diffSorts.find((s) => s.key === key)?.dir;
  const sortPriority = (key: RangeKey) => {
    if (sortMode !== 'stack' || diffSorts.length <= 1) return null;
    const i = diffSorts.findIndex((s) => s.key === key);
    return i >= 0 ? i + 1 : null;
  };

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="px-4 py-6">
          <StatusCard
            tone="empty"
            title="No diff available"
            description="Scores and predictions are needed to compute a diff."
          />
        </CardContent>
      </Card>
    );
  }

  // Rank + Corps + Class, then Total + 8 subcaption bands × 3 sub-columns.
  const totalCols = 3 + BANDS.length * 3;

  return (
    <Card>
      <CardContent className="px-0 py-0 sm:px-2">
        <Table
          className="w-max min-w-full border-collapse text-sm tabular-nums"
          containerClassName="overflow-x-auto rounded-t-xl"
          containerProps={{
            onWheel: (e) => engageStickyScroll(e.currentTarget),
            onTouchStart: (e) => engageStickyScroll(e.currentTarget),
            onScroll: (e) => engageStickyScroll(e.currentTarget),
          }}
        >
          <thead className="text-text-secondary [&_th]:whitespace-nowrap">
            {/* Tier 1 — subcaption bands, each spanning its 3 sub-columns. */}
            <tr>
              <RecapHeadCells
                rowSpan={2}
                classFilters={classFilters}
                onSetClassFilters={onSetClassFilters}
                divisions={divisions}
              />
              {BANDS.map((band) => (
                <th
                  key={band.key}
                  colSpan={3}
                  className={cn(
                    'border-l border-border bg-muted/70 px-2 py-2 text-center text-sm font-semibold text-foreground/85',
                    // Total leads and is the summary band — divide it from the
                    // subcaptions and give its header the emphasized fill.
                    band.emphasis && 'border-r-2 border-r-border bg-foreground/5'
                  )}
                >
                  {band.label}
                </th>
              ))}
            </tr>
            {/* Tier 2 — Score | Pred | ±Diff sub-labels; the ±Diff label is the
                sortable control (the diff is what the Diff view ranks on). */}
            <tr className="border-b border-border text-xs">
              {BANDS.map((band) =>
                SUB_LABELS.map((sub, si) => (
                  <th
                    key={`${band.key}~${sub.kind}`}
                    aria-sort={
                      sub.kind === 'diff'
                        ? sortDir(band.key) === 'asc'
                          ? 'ascending'
                          : sortDir(band.key) === 'desc'
                            ? 'descending'
                            : 'none'
                        : undefined
                    }
                    className={cn(
                      // Same leaf-header treatment as full-recap's leaves: muted
                      // fill, band borders, bottom-aligned semibold label.
                      'border-l border-r border-border bg-muted/50 px-2 py-1.5 text-center align-bottom font-semibold text-text-primary',
                      // The ±Diff sub-column is the emphasized one (it's what the view
                      // ranks on) — matched to the Full Recap "TOT" column treatment.
                      sub.kind === 'diff' && 'bg-foreground/5 border-l-foreground/30',
                      // Close the Total band with the same divider as its tier-1 header.
                      band.emphasis && si === SUB_LABELS.length - 1 && 'border-r-2 border-r-border'
                    )}
                  >
                    {sub.kind === 'diff' ? (
                      <SortButton
                        label={sub.label}
                        dir={sortDir(band.key)}
                        priority={sortPriority(band.key)}
                        onSort={() => onCycleSort(band.key)}
                      />
                    ) : (
                      // Same h-5 flex box + label sizing as full-recap's SortButton
                      // (these aren't sortable, so they read as its inactive state).
                      <span className="inline-flex h-5 items-center justify-center text-[11px] text-muted-foreground/50">
                        {sub.label}
                      </span>
                    )}
                  </th>
                ))
              )}
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
              ...section.rows.map((row, ri) => {
                const info = corpsLookup({
                  corps_key: row.corps_key,
                  corps: row.name,
                } as RecapRow);
                return (
                  <motion.tr
                    key={row.corps_key}
                    layout="position"
                    transition={{ type: 'spring', stiffness: 500, damping: 50, mass: 1 }}
                    data-slot="table-row"
                    className="border-b border-border/60 transition-colors hover:bg-muted/60 active:bg-muted/60 last:border-0"
                  >
                    <td className={cn(RANK_COL, 'z-10 py-2.5 align-middle text-muted-foreground')}>
                      {row.rank ?? ri + 1}
                    </td>
                    <td className={cn(CORPS_COL, 'z-10 px-3 py-2.5 align-middle')}>
                      <CorpsNameCell name={row.name} slug={info?.slug} corpsKey={row.corps_key} />
                    </td>
                    <td className="px-3 py-2.5 align-middle">
                      <ClassBadge division={row.division ?? info?.division ?? undefined} />
                    </td>
                    {BANDS.map((band) => (
                      <BandCells
                        key={band.key}
                        caption={bandCaption(row, band.key)}
                        decimals={decimals}
                        maxAbs={maxAbsDiff.get(band.key) ?? 0}
                        rank={diffRanks.get(band.key)?.get(row.corps_key)}
                        emphasis={band.emphasis}
                      />
                    ))}
                  </motion.tr>
                );
              }),
            ])}
          </tbody>
        </Table>
      </CardContent>
    </Card>
  );
}

// One subcaption band's three cells for a corps: Score | Pred | ±Diff. The diff
// cell is signed, colored by direction with a magnitude-scaled background tint,
// and carries a tooltip with the three exact values. `—` whenever a side (and so
// the diff) is missing.
function BandCells({
  caption,
  decimals,
  maxAbs,
  rank,
  emphasis,
}: {
  caption: DiffCaption;
  decimals: number;
  maxAbs: number;
  rank?: string;
  /** The Total band: close it with a heavier divider from the subcaptions. */
  emphasis?: boolean;
}) {
  const { scored, predicted, diff } = caption;
  const oneSided = scored == null || predicted == null;

  const sub = (value: number | null, muted: boolean) => (
    <span className={cn('font-mono', muted && 'text-muted-foreground/40')}>
      {value == null ? '—' : fmt(value, decimals)}
    </span>
  );

  // Magnitude → alpha. Clamp so even a tiny non-zero diff reads (0.08 floor) and
  // the column's largest diff caps at a still-subtle 0.5.
  const alpha = maxAbs > 0 && diff != null ? 0.08 + 0.42 * Math.min(1, Math.abs(diff) / maxAbs) : 0;
  const color =
    diff == null || diff === 0
      ? undefined
      : diff > 0
        ? 'var(--diff-positive)'
        : 'var(--diff-negative)';

  const diffCell =
    diff == null ? (
      <span className="text-muted-foreground/40">—</span>
    ) : (
      <span
        className="font-mono font-semibold"
        style={{ color: diff === 0 ? 'var(--muted-foreground)' : color }}
      >
        {diff > 0 ? '+' : diff < 0 ? '' : ''}
        {fmt(diff, decimals)}
      </span>
    );

  return (
    <>
      <td className="border-l border-border px-2 py-2.5 text-center align-middle">
        {sub(scored, oneSided)}
      </td>
      <td className="px-2 py-2.5 text-center align-middle">{sub(predicted, oneSided)}</td>
      <td
        className={cn(
          'relative border-l border-l-foreground/30 bg-foreground/5 px-2 py-2.5 text-center align-middle',
          emphasis && 'border-r-2 border-r-border'
        )}
        style={
          color && alpha > 0
            ? {
                backgroundColor: `color-mix(in oklch, ${color} ${Math.round(alpha * 100)}%, transparent)`,
              }
            : undefined
        }
      >
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex cursor-default" />}>
            {diffCell}
          </TooltipTrigger>
          <TooltipContent>
            <span className="tabular-nums">
              Scored {scored == null ? '—' : fmt(scored, 3)} · Predicted{' '}
              {predicted == null ? '—' : fmt(predicted, 3)} · Diff{' '}
              {diff == null ? '—' : `${diff > 0 ? '+' : ''}${fmt(diff, 3)}`}
            </span>
          </TooltipContent>
        </Tooltip>
        {rank ? (
          <span className="pointer-events-none absolute inset-x-0 bottom-[3px] text-center text-[10px] font-normal leading-none text-muted-foreground/50">
            {rank}
          </span>
        ) : null}
      </td>
    </>
  );
}

// The inner sort control (label + cycling arrow + priority). Mirrors the full
// recap's SortButton but for a diff column keyed by caption.
function SortButton({
  label,
  dir,
  priority,
  onSort,
}: {
  label: string;
  dir: 'asc' | 'desc' | undefined;
  priority: number | null;
  onSort: () => void;
}) {
  const active = dir !== undefined;
  return (
    <span className="inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap">
      <button
        type="button"
        onClick={onSort}
        aria-label={active ? `Sorted diff ${label} ${dir}` : `Sort by diff ${label}`}
        className={cn(
          "relative inline-flex items-center transition-colors before:absolute before:-inset-2 before:content-['']",
          active ? 'text-foreground' : 'text-muted-foreground/50 hover:text-muted-foreground'
        )}
      >
        <span className="text-[11px]">{label}</span>
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
      </button>
    </span>
  );
}
