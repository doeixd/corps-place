import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import { ArrowDown01Icon, Tick02Icon } from '@/components/icons/generated';

export type GroupOption = { value: string; label: string };

// A small visual checkbox (not an input) — the whole row is the click target.
// Mirrors the box in @/components/caption-multi-select.
function CheckBox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
        on ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
      )}
    >
      {on ? <Icon icon={Tick02Icon} className="size-3" /> : null}
    </span>
  );
}

/**
 * A dropdown multi-select for group/store filters — the merch counterpart to
 * @/components/caption-multi-select. Selection is controlled; an empty `selected`
 * means "no filter" (the caller shows everything). Matching is OR across the
 * selected groups.
 */
export function GroupMultiSelect({
  options,
  selected,
  onChange,
  allLabel = 'All groups',
  noun = 'groups',
  ariaLabel = 'Filter by group',
  className,
}: {
  options: readonly GroupOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  allLabel?: string;
  noun?: string;
  ariaLabel?: string;
  className?: string;
}) {
  if (options.length === 0) return null;
  const selectedSet = new Set(selected);

  const toggle = (value: string) => {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange([...next]);
  };

  const count = selected.length;
  const summary =
    count === 0
      ? allLabel
      : count === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? `1 ${noun}`)
        : `${count} ${noun}`;

  return (
    <Popover>
      <PopoverTrigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground',
          count > 0 && 'border-primary/60 text-foreground',
          className
        )}
      >
        <span className="max-w-[12rem] truncate">{summary}</span>
        <Icon icon={ArrowDown01Icon} size="sm" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="themed-scrollbar max-h-[60dvh] w-64 gap-1 overflow-y-auto p-1.5"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="checkbox"
            aria-checked={selectedSet.has(o.value)}
            aria-label={o.label}
            onClick={() => toggle(o.value)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-foreground"
          >
            <CheckBox on={selectedSet.has(o.value)} />
            <span className="truncate">{o.label}</span>
          </button>
        ))}
        {count > 0 ? (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-center text-xs text-text-secondary transition-colors hover:bg-accent hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
