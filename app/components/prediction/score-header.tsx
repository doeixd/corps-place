import { motion } from 'motion/react';

import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon';
import { TableHead } from '@/components/ui/table';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import type { RangeKey } from '@/lib/prediction-scenario';
import { ArrowDown01Icon as HugeiconsArrowDown01 } from '@/components/icons/generated';

// Full caption / column names shown in the header tooltips.
const COLUMN_FULL_NAMES: Record<RangeKey, string> = {
  total: 'Total Score',
  GE: 'General Effect',
  Visual: 'Visual',
  Music: 'Music',
  GE1: 'General Effect 1',
  GE2: 'General Effect 2',
  VP: 'Visual Proficiency',
  VA: 'Visual Analysis',
  CG: 'Color Guard',
  MB: 'Music Brass',
  MA: 'Music Analysis',
  MP: 'Music Percussion',
};

/**
 * A caption column header with a built-in sort control. The arrow cycles
 * none → desc → asc → none (darkens when active; rotates 180° for ascending) and
 * shows its priority in stack mode. A second tooltip on the label gives the full
 * column name. Presentational — the parent owns the sort state.
 */
export function SortableScoreHeader({
  col,
  showRanges,
  dir,
  priority,
  onSort,
}: {
  col: { key: RangeKey; label: string; separator?: boolean };
  showRanges: boolean;
  /** Current sort direction, or `undefined` when this column isn't sorted. */
  dir: 'desc' | 'asc' | undefined;
  /** 1-based priority to display (stack mode), or `null` to hide. */
  priority: number | null;
  onSort: () => void;
}) {
  const active = dir !== undefined;
  return (
    <TableHead
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
      // Center headings over the wider range values when Ranges are on;
      // right-align (the default) over point scores when off.
      className={cn(
        showRanges ? 'text-center' : 'text-right',
        col.separator && 'border-r border-border pr-4'
      )}
    >
      {/* h-6 fixes the wrapper's line box so the inline arrow icon doesn't lift the
          label 1px above the icon-less Rank/Corps/Class headers. */}
      <span
        className={cn(
          'inline-flex h-6 items-center gap-1',
          showRanges ? 'justify-center' : 'justify-end'
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onSort}
                aria-label={
                  active
                    ? `Sorted by ${col.label} ${dir === 'asc' ? 'ascending' : 'descending'} — click to ${dir === 'asc' ? 'clear' : 'reverse'}`
                    : `Sort by ${col.label}`
                }
                // light grey (idle) → medium (hover) → darkest (active). `before:`
                // adds an invisible larger hit target with no layout shift.
                className={cn(
                  "relative inline-flex items-center transition-colors before:absolute before:-inset-2 before:content-['']",
                  active
                    ? 'text-foreground'
                    : 'text-muted-foreground/60 hover:text-muted-foreground'
                )}
              />
            }
          >
            {/* Rotation animates smoothly where swapping arrow icons would pop.
                When active, a soft orange (theme primary) glow makes the sorted
                state obvious at a glance. */}
            <motion.span
              className={cn(
                'inline-flex transition-[filter] duration-200',
                active &&
                  'drop-shadow-[0_0_7px_var(--primary)] drop-shadow-[0_0_2px_var(--primary)]'
              )}
              animate={{ rotate: dir === 'asc' ? 180 : 0 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
            >
              <Icon icon={HugeiconsArrowDown01} size="sm" className="size-3.5" />
            </motion.span>
            {priority !== null ? (
              <span className="ml-0.5 text-[10px] font-semibold leading-none tabular-nums">
                {priority}
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipContent>
            {active
              ? dir === 'asc'
                ? `Sorted ${col.label} low → high · click to clear`
                : `Sorted ${col.label} high → low · click to reverse`
              : `Sort by ${col.label}`}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="cursor-help underline decoration-dotted decoration-muted-foreground/25 underline-offset-[7px]" />
            }
          >
            {col.label}
          </TooltipTrigger>
          <TooltipContent>
            <motion.span
              initial={{ opacity: 0, y: 4, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.1, ease: 'easeOut' }}
            >
              {COLUMN_FULL_NAMES[col.key]}
            </motion.span>
          </TooltipContent>
        </Tooltip>
      </span>
    </TableHead>
  );
}
