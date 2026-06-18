import { For } from 'jotai-solid-api';
import { motion } from 'motion/react';
import * as Match from 'effect/Match';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from '@/components/ui/dropdown-menu';
import { MenuTwoLineIcon as HugeiconsMenuTwoLine } from '@/components/icons/generated';
import { classShortName } from '@/lib/prediction-scenario';

// Shared sticky-column classes so the compact and full recap tables freeze the
// Rank + Corps headers identically (and align with their body cells).
const RANK_HEAD =
  'sticky-col sticky left-0 z-20 w-[48px] min-w-[48px] max-w-[48px] px-1 text-center sm:w-[64px] sm:min-w-[64px] sm:px-2';
const CORPS_HEAD =
  'sticky-col sticky-col-edge sticky left-[48px] z-20 px-3 text-left sm:left-[64px]';

/**
 * The Rank, Corps, and Class-filter header cells shared by the compact and full
 * recap tables. Identical markup/styling in both keeps them visually matched and
 * removes the duplicated class-filter dropdown. Each cell carries a stable
 * `layoutId` so, inside the tables' shared `AnimatePresence`, the headers morph
 * in place when the user toggles between the compact and full views — the same
 * treatment the corps rows already get.
 *
 * `rowSpan` is 1 for the single-row compact header and 4 for the full table's
 * four-tier header; the vertical alignment follows from it (bottom-aligned so
 * the labels sit on the same baseline as the full table's sortable sub-labels).
 */
export function RecapHeadCells({
  rowSpan = 1,
  classFilters,
  onSetClassFilters,
  divisions,
}: {
  rowSpan?: number;
  classFilters: string[];
  onSetClassFilters: (filters: string[]) => void;
  divisions: string[];
}) {
  const classFilterActive = classFilters.length > 0;
  const selectedClassFilters = new Set(classFilters);
  const classFilterLabel = Match.value(classFilters.length).pipe(
    Match.when(0, () => 'Class'),
    Match.when(1, () => classShortName(classFilters[0])),
    Match.orElse((count) => `${count} classes`)
  );

  const tall = rowSpan > 1;
  const vAlign = tall ? 'align-bottom py-2' : 'align-middle h-10';
  const base = 'font-medium whitespace-nowrap text-foreground';
  // `layout: "position"` so a view toggle slides the frozen headers to their new
  // spot without animating their size (the full table's header is much taller).
  const morph = {
    layout: 'position',
    transition: { type: 'spring', stiffness: 500, damping: 50, mass: 1 },
  } as const;

  return (
    <>
      <motion.th
        layoutId="recap-head-rank"
        {...morph}
        rowSpan={rowSpan}
        className={cn(RANK_HEAD, base, vAlign)}
      >
        Rank
      </motion.th>
      <motion.th
        layoutId="recap-head-corps"
        {...morph}
        rowSpan={rowSpan}
        className={cn(CORPS_HEAD, base, vAlign)}
      >
        Corps
      </motion.th>
      <motion.th
        layoutId="recap-head-class"
        {...morph}
        rowSpan={rowSpan}
        className={cn('border-r border-border p-0', tall ? 'align-bottom' : 'align-middle')}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="Filter by class"
                className={cn(
                  'flex h-full w-full cursor-pointer px-3 py-2 text-left font-medium text-foreground transition-colors hover:text-foreground focus-visible:outline-none',
                  tall ? 'items-end' : 'items-center'
                )}
              />
            }
          >
            {/* Keep icon + label centered relative to each other (as in the
                compact view); the button itself bottom-anchors the group in the
                full table's taller header. */}
            <span className="inline-flex items-center gap-1.5">
              <Icon
                icon={HugeiconsMenuTwoLine}
                size="sm"
                className={cn(
                  'size-3.5',
                  classFilterActive ? 'text-foreground' : 'text-muted-foreground/60'
                )}
              />
              {classFilterLabel}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem closeOnClick={false} onClick={() => onSetClassFilters([])}>
              All classes
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <For each={divisions}>
              {(d) => (
                <DropdownMenuCheckboxItem
                  checked={selectedClassFilters.has(d)}
                  closeOnClick={false}
                  onCheckedChange={(checked) => {
                    onSetClassFilters(
                      checked ? [...classFilters, d] : classFilters.filter((f) => f !== d)
                    );
                  }}
                >
                  {classShortName(d)}
                </DropdownMenuCheckboxItem>
              )}
            </For>
          </DropdownMenuContent>
        </DropdownMenu>
      </motion.th>
    </>
  );
}
