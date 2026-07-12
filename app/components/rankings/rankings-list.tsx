// /rankings animated, reorderable standings list (plan M2). Rows reorder with
// motion `layout` + popLayout when filters change; grouped by division when
// asked. Each row: rank badge + logo + name + score + recency indicator, tinted
// with the corps's brand hue. Pure presentational — the parent owns the data.
import { useMemo, type CSSProperties } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Link } from '@tanstack/react-router';
import { useSelector } from '@xstate/react';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { corpsPaletteVars } from '@sdk/src/corpsColors.js';
import { themeStore } from '@/stores/theme-store';
import { recapGroup, RECAP_GROUP_ORDER, RECAP_GROUP_LABELS } from '@/lib/prediction-scenario';
import { cn } from '@/lib/utils';
import { RANK_METRIC_LABELS, type RankGroup, type RankMetric, type RankRow } from '@/lib/rankings/types';

/** Recency tier 0..3 from daysSinceLast vs the thresholds (e.g. [7,14,28]). */
const recencyTier = (days: number, thresholds: number[]) => {
  for (let i = 0; i < thresholds.length; i++) if (days <= thresholds[i]) return i;
  return thresholds.length;
};
const TIER_OPACITY = [1, 0.82, 0.64, 0.48];
const TIER_DOT = [
  'bg-emerald-500',
  'bg-amber-500',
  'bg-orange-500',
  'bg-red-500',
];

function Row({
  row,
  rank,
  season,
  recency,
  mode,
  onHover,
  highlighted,
  striped,
}: {
  row: RankRow;
  rank: number;
  season: string;
  recency: number[];
  mode: 'light' | 'dark';
  onHover?: (slug: string | null) => void;
  highlighted: boolean;
  striped: boolean;
}) {
  const tier = recencyTier(row.daysSinceLast, recency);
  const vars = corpsPaletteVars(
    { primary: row.colorPrimary ?? undefined, secondary: row.colorSecondary ?? null },
    mode
  );
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: TIER_OPACITY[Math.min(tier, 3)] }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      style={vars as CSSProperties}
      onMouseEnter={() => onHover?.(row.corpsSlug)}
      onMouseLeave={() => onHover?.(null)}
      className={cn(
        'flex items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 transition-colors',
        // Zebra striping: a subtle wash on alternate rows so long lists scan
        // easily. `muted` is a semantic token, so it reads right in both themes;
        // hover/highlight take precedence over the stripe.
        highlighted
          ? 'border-[var(--corps-accent-border)] bg-[var(--corps-accent-muted)]'
          : striped
            ? 'bg-muted/40 hover:bg-muted/60'
            : 'hover:bg-muted/50'
      )}
    >
      {/* w-6 fits the widest real rank (2 digits — 58 corps max across all
          seasons) with right-alignment keeping logos flush; w-7 left ~a third
          of the column as dead space beside single-digit ranks. */}
      <span className="w-6 shrink-0 text-right font-mono text-sm tabular-nums text-text-secondary">
        {rank}
      </span>
      <CorpsLogo
        name={row.corpsName}
        logo={corpsLogoSource({
          corps_logo: row.corpsLogo,
          corps_logo_dark: row.corpsLogoDark,
          corps_logo_dark_url: row.corpsLogoDarkUrl,
        })}
        width={32}
        className="size-8 shrink-0"
      />
      <Link
        to="/corps/$slug/{-$season}"
        params={{ slug: row.corpsSlug, season }}
        className="min-w-0 flex-1 truncate font-medium text-text-primary hover:underline"
      >
        {row.corpsName}
      </Link>
      {tier > 0 ? (
        <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
          <span className={cn('size-1.5 rounded-full', TIER_DOT[Math.min(tier, 3)])} />
          {row.daysSinceLast}d ago
        </span>
      ) : null}
      <span className="shrink-0 tabular-nums font-semibold text-text-primary">
        {row.score.toFixed(3)}
        {row.partial ? <span className="ml-0.5 text-[10px] text-muted-foreground">*</span> : null}
      </span>
    </motion.div>
  );
}

export function RankingsList({
  rows,
  season,
  metric,
  group,
  recency,
  hoveredSlug,
  onHover,
}: {
  rows: RankRow[];
  season: string;
  metric: RankMetric;
  group: RankGroup;
  recency: number[];
  hoveredSlug?: string | null;
  onHover?: (slug: string | null) => void;
}) {
  const mode = useSelector(themeStore, (s) => s.context.theme) ?? 'light';

  // Group into division sections (renumbered within group) or one flat list.
  const sections = useMemo(() => {
    if (group !== 'division') return [{ key: 'all', label: '', rows }];
    const byGroup = new Map<string, RankRow[]>();
    for (const r of rows) {
      const g = recapGroup(r.division);
      (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(r);
    }
    return RECAP_GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
      key: g,
      label: RECAP_GROUP_LABELS[g],
      rows: byGroup.get(g)!,
    }));
  }, [rows, group]);

  if (rows.length === 0) {
    return (
      <p className="px-2 py-8 text-center text-sm text-muted-foreground">
        No {RANK_METRIC_LABELS[metric].toLowerCase()} standings for this view yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {sections.map((section) => (
        <div key={section.key} className="space-y-0.5">
          {section.label ? (
            <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">
              {section.label}
            </h3>
          ) : null}
          <AnimatePresence initial={false} mode="popLayout">
            {section.rows.map((row, i) => (
              <Row
                key={row.corpsSlug}
                row={row}
                rank={i + 1}
                season={season}
                recency={recency}
                mode={mode}
                onHover={onHover}
                highlighted={hoveredSlug === row.corpsSlug}
                striped={i % 2 === 1}
              />
            ))}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}
