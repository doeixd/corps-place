import * as Match from 'effect/Match';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon';
import { MenuTwoLineIcon as HugeiconsMenuTwoLine } from '@/components/icons/generated';
import { classShortName } from '@/lib/prediction-scenario';

// Static (no-motion, no-floating-ui) twin of RecapHeadCells for the read-only
// recap tables (/scores index + show pages). Same Rank/Corps/Class headers, but
// the class filter is a native <details> disclosure instead of the base-ui
// DropdownMenu — keeping the multi-select filter while shedding the floating-ui
// positioning stack (a ~20-chunk load) from the /scores bundle.
const RANK_HEAD =
  'sticky-col sticky left-0 z-20 w-[48px] min-w-[48px] max-w-[48px] px-1 text-center sm:w-[64px] sm:min-w-[64px] sm:px-2';
const CORPS_HEAD =
  'sticky-col sticky-col-edge sticky left-[48px] z-20 px-3 text-left sm:left-[64px]';

export function RecapHeadCellsStatic({
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

  return (
    <>
      <th rowSpan={rowSpan} className={cn(RANK_HEAD, base, vAlign)}>
        Rank
      </th>
      <th rowSpan={rowSpan} className={cn(CORPS_HEAD, base, vAlign)}>
        Corps
      </th>
      {divisions.length === 0 && !classFilterActive ? null : (
        <th
          rowSpan={rowSpan}
          className={cn('border-r border-border p-0', tall ? 'align-bottom' : 'align-middle')}
        >
          {/* Native disclosure — no floating-ui. Closes on outside click via the
              browser's <details> semantics; the menu is absolutely positioned. */}
          <details className="group/classfilter relative">
            <summary
              aria-label="Filter by class"
              className={cn(
                'flex h-full w-full cursor-pointer list-none px-3 py-2 text-left font-medium text-foreground transition-colors hover:text-foreground focus-visible:outline-none [&::-webkit-details-marker]:hidden',
                tall ? 'items-end' : 'items-center'
              )}
            >
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
            </summary>
            <div className="absolute left-0 z-30 mt-1 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
              <button
                type="button"
                onClick={() => onSetClassFilters([])}
                className="flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
              >
                All classes
              </button>
              <div className="my-1 h-px bg-border" />
              {divisions.map((d) => (
                <label
                  key={d}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={selectedClassFilters.has(d)}
                    onChange={(e) =>
                      onSetClassFilters(
                        e.target.checked
                          ? [...classFilters, d]
                          : classFilters.filter((f) => f !== d)
                      )
                    }
                    className="size-3.5 accent-primary"
                  />
                  {classShortName(d)}
                </label>
              ))}
            </div>
          </details>
        </th>
      )}
    </>
  );
}
