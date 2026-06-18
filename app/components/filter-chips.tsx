import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type FilterChipItem = { value: string; label: ReactNode };

/**
 * A horizontal row of pill "filter chips" — a single active value out of a set
 * of options. Purely presentational: it emits `onSelect(value)` and owns no
 * URL/filter state, so callers keep wiring it to their machine / search params.
 *
 * Used directly for arbitrary filters (e.g. the corps division chips) and as
 * the base for `SeasonChips`.
 */
export function FilterChips({
  items,
  value,
  onSelect,
  wrap = true,
  className,
  ariaLabel,
}: {
  items: readonly FilterChipItem[];
  /** Currently active value; chips compare against this for the active style. */
  value: string;
  onSelect: (value: string) => void;
  /**
   * Wrap onto multiple rows from `sm` up (default), or keep one
   * horizontally-scrolling row at every width. Either way, mobile gets a
   * single scrollable row (scrollbar hidden) so pill sets never stack.
   */
  wrap?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'flex gap-2',
        wrap
          ? 'overflow-x-auto scrollbar-none sm:flex-wrap sm:overflow-x-visible'
          : 'overflow-x-auto scrollbar-none',
        className
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(item.value)}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-sm transition-colors',
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-text-secondary hover:border-primary/60 hover:text-foreground'
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Season filter chips: an "All" chip followed by one chip per season. Renders
 * nothing when there are no seasons (a lone "All" chip would be meaningless).
 *
 * The "hide when a record spans only one season" rule is intentionally left to
 * the caller — directory pages show `[All, 2026]` even with one season, while
 * detail pages hide the row entirely — so it stays a per-page UX decision.
 */
export function SeasonChips({
  seasons,
  value,
  onSelect,
  allValue = 'all',
  allLabel = 'All',
  wrap = true,
  className,
  ariaLabel = 'Filter by season',
}: {
  /** Seasons to show, already ordered; the "All" chip is prepended. */
  seasons: readonly string[];
  value: string;
  onSelect: (season: string) => void;
  allValue?: string;
  allLabel?: ReactNode;
  wrap?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  if (seasons.length === 0) return null;
  const items: FilterChipItem[] = [
    { value: allValue, label: allLabel },
    ...seasons.map((s) => ({ value: s, label: s })),
  ];
  return (
    <FilterChips
      items={items}
      value={value}
      onSelect={onSelect}
      wrap={wrap}
      className={className}
      ariaLabel={ariaLabel}
    />
  );
}
