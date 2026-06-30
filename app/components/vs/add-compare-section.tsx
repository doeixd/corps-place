// VS "Add to compare" section (replaces the old <AddSeries> popover — see the
// commented-out widget in vs.tsx, kept for reference). Three side-by-side
// builders on desktop (Corps season / 2026 prediction / Reference baseline); a
// single column switched by a segmented tab bar on mobile. Each leaf option adds
// on click and previews on the chart on hover (the parent owns the ghost line).
// Pure client UI — the parent owns the series list / URL.
import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Icon } from '@/components/icon';
import { AddCircleIcon } from '@/components/icons/generated';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { cn } from '@/lib/utils';
import type { VsSeries } from '@/lib/vs/types';

type Kind = 'corps' | 'prediction' | 'baseline';
export interface CorpsOption {
  slug: string;
  name: string;
  // Logo source fields (from the corps directory) for the theme-aware logo.
  corps_logo?: string | null;
  corps_logo_dark?: number | null;
  corps_logo_dark_url?: string | null;
}

// Virtualized result-row height (px) — keep in sync with the row's rendered size.
const RESULT_ROW_H = 40;

const TABS: { value: Kind; label: string }[] = [
  { value: 'corps', label: 'Corps' },
  { value: 'prediction', label: 'Prediction' },
  { value: 'baseline', label: 'Baseline' },
];

// Seasons offered in the Corps-season dropdown (newest first), spanning the
// range the score data covers.
const SEASONS = Array.from({ length: 14 }, (_, i) => String(2026 - i));
// Common reference places offered as quick chips (any 1–24 via the input).
const BASELINE_QUICK = [1, 3, 5, 8, 12];

const fieldCls =
  'w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60';

// A pill option that adds on click and previews on hover. Styled to match the
// site's filter chips (rounded-full, primary hover). When `added`, it shows the
// active/selected look and is inert — so it reads as "already in the chart"
// rather than silently doing nothing on click.
function OptionChip({
  label,
  onAdd,
  onHover,
  disabled,
  added,
}: {
  label: string;
  onAdd: () => void;
  onHover: (on: boolean) => void;
  disabled?: boolean;
  added?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || added}
      title={added ? 'Already in the comparison' : undefined}
      onClick={onAdd}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed',
        added
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-text-secondary hover:border-primary/60 hover:text-foreground disabled:opacity-50'
      )}
    >
      {added ? `${label} ✓` : label}
    </button>
  );
}

function ColumnHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

// All matches (no cap) — the list is virtualized, so the full directory is cheap.
const useCorpsMatches = (corpsOptions: CorpsOption[], query: string) =>
  useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? corpsOptions.filter((c) => c.name.toLowerCase().includes(q)) : corpsOptions;
  }, [query, corpsOptions]);

/** Virtualized corps result list with theme-aware logos. Renders the full
 *  directory cheaply; each row selects on click and (optionally) previews on
 *  hover. */
function CorpsResultList({
  matches,
  onSelect,
  onHover,
  heightClass = 'h-72',
  isUnavailable,
  unavailableTitle,
  isAdded,
}: {
  matches: CorpsOption[];
  onSelect: (c: CorpsOption) => void;
  onHover?: (c: CorpsOption | null) => void;
  /** Tailwind height for the scroll viewport — taller shows more rows. */
  heightClass?: string;
  /** When true for a corps, the row is greyed out + non-interactive. */
  isUnavailable?: (c: CorpsOption) => boolean;
  /** Tooltip (title) explaining why an unavailable row is greyed. */
  unavailableTitle?: (c: CorpsOption) => string;
  /** When true, the row is already in the comparison — mark it, don't re-add. */
  isAdded?: (c: CorpsOption) => boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: matches.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => RESULT_ROW_H,
    overscan: 10,
  });
  if (matches.length === 0)
    return <p className="px-1 py-2 text-xs text-muted-foreground">No matches.</p>;
  return (
    <div ref={listRef} className={cn('themed-scrollbar overflow-y-auto', heightClass)}>
      <div style={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {rowVirtualizer.getVirtualItems().map((vi) => {
          const c = matches[vi.index];
          const unavailable = isUnavailable?.(c) ?? false;
          const added = !unavailable && (isAdded?.(c) ?? false);
          const inert = unavailable || added;
          return (
            <button
              key={c.slug}
              type="button"
              title={
                unavailable ? unavailableTitle?.(c) : added ? 'Already in the comparison' : undefined
              }
              aria-disabled={inert || undefined}
              onClick={() => {
                if (!inert) onSelect(c);
              }}
              onMouseEnter={() => {
                if (!inert) onHover?.(c);
              }}
              onMouseLeave={() => onHover?.(null)}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: vi.size,
                transform: `translateY(${vi.start}px)`,
              }}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 text-left text-sm transition-colors',
                unavailable
                  ? 'cursor-not-allowed opacity-40'
                  : added
                    ? 'cursor-default text-primary'
                    : 'hover:bg-accent hover:text-foreground'
              )}
            >
              <CorpsLogo name={c.name} logo={corpsLogoSource(c)} width={24} className="size-6 shrink-0" />
              <span className="truncate">{c.name}</span>
              {added ? <span className="ml-auto shrink-0 text-xs text-primary">✓ added</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Corps + season: pick a season (default 2026) on the left of the search box,
 *  then click a corps in the results to add it in one click. Hover previews it. */
function CorpsSeasonColumn({
  corpsOptions,
  availabilityBySeason,
  addedTokens,
  disabled,
  onAdd,
  onPreview,
}: {
  corpsOptions: CorpsOption[];
  availabilityBySeason: Record<string, string[]>;
  addedTokens: Set<string>;
  disabled?: boolean;
  onAdd: (s: VsSeries) => void;
  onPreview: (s: VsSeries | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [season, setSeason] = useState('2026');
  const matches = useCorpsMatches(corpsOptions, query);

  // Slugs that actually have plottable scores in the selected season; the rest
  // are greyed out (e.g. early in 2026 only a handful of corps have performed).
  const available = useMemo(
    () => new Set(availabilityBySeason[season] ?? []),
    [availabilityBySeason, season]
  );

  return (
    <div className="space-y-2">
      <ColumnHeader title="Corps season" hint="Pick a season, then click a corps to add it." />
      <p className="text-xs text-muted-foreground">
        Corps that haven’t performed a show in the selected season yet are greyed out.
      </p>
      <div className="flex gap-2">
        <select
          value={season}
          onChange={(e) => setSeason(e.target.value)}
          aria-label="Season"
          className="shrink-0 rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/60"
        >
          {SEASONS.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search corps…"
          className={fieldCls}
        />
      </div>
      <CorpsResultList
        matches={matches}
        heightClass="h-96"
        isUnavailable={(c) => available.size > 0 && !available.has(c.slug)}
        unavailableTitle={(c) => `${c.name} hasn’t performed a show in ${season}`}
        isAdded={(c) => addedTokens.has(`corps~${c.slug}~${season}`)}
        onSelect={(c) => {
          if (!disabled) onAdd({ kind: 'corps', corpsSlug: c.slug, season });
        }}
        onHover={(c) => onPreview(c ? { kind: 'corps', corpsSlug: c.slug, season } : null)}
      />
    </div>
  );
}

/** 2026 prediction: search a corps, click it to add the model's predicted-to-
 *  finals curve (read-model-backed, so it works on prod). One click, like the
 *  Corps-season column; hovering previews. */
function PredictionColumn({
  corpsOptions,
  addedTokens,
  disabled,
  onAdd,
  onPreview,
}: {
  corpsOptions: CorpsOption[];
  addedTokens: Set<string>;
  disabled?: boolean;
  onAdd: (s: VsSeries) => void;
  onPreview: (s: VsSeries | null) => void;
}) {
  const [query, setQuery] = useState('');
  const matches = useCorpsMatches(corpsOptions, query);

  return (
    <div className="space-y-2">
      <ColumnHeader title="2026 prediction" hint="The model’s projected finish for the 2026 season." />
      <p className="text-xs text-muted-foreground">
        Click a corps to add its predicted-to-finals curve (a dashed line with an uncertainty band).
      </p>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search corps…"
        className={fieldCls}
      />
      <CorpsResultList
        matches={matches}
        heightClass="h-96"
        isAdded={(c) => addedTokens.has(`forecast~${c.slug}`)}
        onSelect={(c) => {
          if (!disabled) onAdd({ kind: 'predicted', corpsSlug: c.slug });
        }}
        onHover={(c) => onPreview(c ? { kind: 'predicted', corpsSlug: c.slug } : null)}
      />
    </div>
  );
}

function BaselineColumn({
  addedTokens,
  disabled,
  onAdd,
  onPreview,
}: {
  addedTokens: Set<string>;
  disabled?: boolean;
  onAdd: (s: VsSeries) => void;
  onPreview: (s: VsSeries | null) => void;
}) {
  // String state so the field can be emptied to type a new number (the old
  // number-input clamped to 1 on every keystroke, so you couldn't clear it).
  const [rank, setRank] = useState('13');

  const parsed = (() => {
    const n = Number(rank);
    return Number.isInteger(n) && n >= 1 && n <= 24 ? n : null;
  })();

  const add = (n: number) => onAdd({ kind: 'baseline', rank: n });

  return (
    <div className="space-y-2">
      <ColumnHeader title="Reference baseline" hint="A generic Nth-place corps, averaged across seasons." />
      <div className="flex flex-wrap gap-1.5">
        {BASELINE_QUICK.map((n) => (
          <OptionChip
            key={n}
            label={`${n}${n === 1 ? 'st' : n === 3 ? 'rd' : 'th'}`}
            disabled={disabled}
            added={addedTokens.has(`baseline~${n}`)}
            onAdd={() => add(n)}
            onHover={(on) => onPreview(on ? { kind: 'baseline', rank: n } : null)}
          />
        ))}
      </div>
      <label className="block space-y-1">
        <span className="text-xs text-text-secondary">Custom place (1–24)</span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={24}
            value={rank}
            onChange={(e) => setRank(e.target.value)}
            onBlur={() => {
              // Snap an out-of-range / empty value back to a valid one on blur.
              if (parsed === null) setRank('13');
            }}
            className={fieldCls}
          />
          <button
            type="button"
            disabled={disabled || parsed === null || addedTokens.has(`baseline~${parsed}`)}
            title={
              parsed !== null && addedTokens.has(`baseline~${parsed}`)
                ? 'Already in the comparison'
                : undefined
            }
            onClick={() => parsed !== null && add(parsed)}
            onMouseEnter={() => parsed !== null && onPreview({ kind: 'baseline', rank: parsed })}
            onMouseLeave={() => onPreview(null)}
            onFocus={() => parsed !== null && onPreview({ kind: 'baseline', rank: parsed })}
            onBlur={() => onPreview(null)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon icon={AddCircleIcon} size="sm" className="size-4" />
            Add
          </button>
        </div>
      </label>
    </div>
  );
}

export function AddCompareSection({
  onAdd,
  onPreview,
  corpsOptions = [],
  availabilityBySeason = {},
  addedTokens = new Set(),
  atCap = false,
  capMessage,
}: {
  onAdd: (s: VsSeries) => void;
  /** Hover/focus an option → preview it on the chart; null clears the preview. */
  onPreview: (s: VsSeries | null) => void;
  corpsOptions?: CorpsOption[];
  /** `{ [season]: slug[] }` — which corps have data per season (for grey-out). */
  availabilityBySeason?: Record<string, string[]>;
  /** URL tokens already in the comparison — options for these show as "added". */
  addedTokens?: Set<string>;
  atCap?: boolean;
  capMessage?: string;
}) {
  const [tab, setTab] = useState<Kind>('corps');

  // Clear any lingering preview when an add succeeds (the new real line replaces
  // the ghost) and when switching mobile tabs.
  const add = (s: VsSeries) => {
    onPreview(null);
    onAdd(s);
  };

  return (
    <section className="space-y-3" aria-labelledby="add-compare-heading">
      <div className="space-y-1">
        <h2 id="add-compare-heading" className="text-lg font-semibold text-text-primary">
          Add to compare
        </h2>
        <p className="text-sm text-muted-foreground">
          Layer more lines onto the chart: a corps’ season, a 2026 prediction snapshot, or a
          reference baseline (a generic Nth-place corps). Everything aligns by{' '}
          <span className="font-medium text-text-secondary">% through the season</span>. Hover an
          option to preview it on the chart, click to add.
        </p>
      </div>

      {atCap ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {capMessage}
        </p>
      ) : null}

      {/* Mobile: a segmented tab bar picks one column. */}
      <div className="sm:hidden">
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Add type"
          value={[tab]}
          onValueChange={(v) => {
            const next = v[0] as Kind | undefined;
            if (next) {
              onPreview(null);
              setTab(next);
            }
          }}
        >
          {TABS.map((t) => (
            <ToggleGroupItem key={t.value} value={t.value}>
              {t.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {/* Desktop: three columns; mobile: only the active tab's column. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className={cn('rounded-lg border border-border p-3', tab === 'corps' ? 'block' : 'hidden', 'sm:block')}>
          <CorpsSeasonColumn
            corpsOptions={corpsOptions}
            availabilityBySeason={availabilityBySeason}
            addedTokens={addedTokens}
            disabled={atCap}
            onAdd={add}
            onPreview={onPreview}
          />
        </div>
        <div className={cn('rounded-lg border border-border p-3', tab === 'prediction' ? 'block' : 'hidden', 'sm:block')}>
          <PredictionColumn
            corpsOptions={corpsOptions}
            addedTokens={addedTokens}
            disabled={atCap}
            onAdd={add}
            onPreview={onPreview}
          />
        </div>
        <div className={cn('rounded-lg border border-border p-3', tab === 'baseline' ? 'block' : 'hidden', 'sm:block')}>
          <BaselineColumn addedTokens={addedTokens} disabled={atCap} onAdd={add} onPreview={onPreview} />
        </div>
      </div>
    </section>
  );
}
