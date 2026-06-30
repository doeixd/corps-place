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
import { AddCircleIcon, Cancel01Icon } from '@/components/icons/generated';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { FilterChips } from '@/components/filter-chips';
import { cn } from '@/lib/utils';
import { VS_SERIES_CAP, type VsSeries } from '@/lib/vs/types';
import { VS_CAPTIONS, VS_CAPTION_LABELS, type VsCaption } from '@/lib/vs/captions';
import { Slider } from '@/components/ui/slider';
import { getVs2026SnapshotDates } from '@/lib/server-fns/vs';

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

// Snapshot dates are 'YYYY-MM-DD'; render compactly (UTC, so no day-shift).
const fmtSnapDate = (d: string) => {
  if (!d) return '';
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

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
      disabled={disabled && !added}
      title={added ? 'In the comparison — click to remove' : undefined}
      onClick={onAdd}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      className={cn(
        'shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-sm transition-colors disabled:cursor-not-allowed',
        added
          ? 'border-primary/40 text-text-secondary'
          : 'border-border text-text-secondary hover:border-primary/60 hover:text-foreground disabled:opacity-50'
      )}
    >
      {label}
      {added ? <span className="ml-1 text-muted-foreground">✓</span> : null}
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
  atCap = false,
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
  /** When true, the row is already in the comparison (click toggles it off). */
  isAdded?: (c: CorpsOption) => boolean;
  /** At the series cap: non-added rows can't add (blocked), added stay removable. */
  atCap?: boolean;
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
          // At the cap you can still remove an active row, but not add a new one.
          const blocked = !unavailable && !added && atCap;
          const inert = unavailable || blocked;
          return (
            <button
              key={c.slug}
              type="button"
              title={
                unavailable
                  ? unavailableTitle?.(c)
                  : blocked
                    ? `Remove a series to add another (max ${VS_SERIES_CAP})`
                    : added
                      ? 'In the comparison — click to remove'
                      : undefined
              }
              aria-disabled={inert || undefined}
              onClick={() => {
                if (!inert) onSelect(c);
              }}
              onMouseEnter={() => {
                if (!inert && !added) onHover?.(c);
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
                'flex items-center gap-2 rounded-md border border-transparent px-2 text-left text-sm transition-colors',
                unavailable || blocked
                  ? 'cursor-not-allowed opacity-40'
                  : added
                    ? 'border-primary/40 hover:bg-accent'
                    : 'hover:bg-accent hover:text-foreground'
              )}
            >
              <CorpsLogo name={c.name} logo={corpsLogoSource(c)} width={24} className="size-6 shrink-0" />
              <span className="truncate">{c.name}</span>
              {added ? (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">✓ added</span>
              ) : null}
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
  roster2026,
  addedTokens,
  disabled,
  onAdd,
  onPreview,
}: {
  corpsOptions: CorpsOption[];
  availabilityBySeason: Record<string, string[]>;
  roster2026: string[];
  addedTokens: Set<string>;
  disabled?: boolean;
  onAdd: (s: VsSeries) => void;
  onPreview: (s: VsSeries | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [season, setSeason] = useState('2026');
  const matches = useCorpsMatches(corpsOptions, query);

  // Slugs with plottable scores in the selected season (used for the 2026 grey-out).
  const available = useMemo(
    () => new Set(availabilityBySeason[season] ?? []),
    [availabilityBySeason, season]
  );
  // The season's competitors: 2026 → the predicted roster (incl. not-yet-scored);
  // a completed season → exactly who scored. The list is restricted to this set
  // (no historical/defunct corps); empty set → no filter (off-season fallback).
  const roster = useMemo(
    () => (season === '2026' ? new Set(roster2026) : available),
    [season, roster2026, available]
  );
  const visible = useMemo(
    () => (roster.size ? matches.filter((c) => roster.has(c.slug)) : matches),
    [matches, roster]
  );

  return (
    <div className="space-y-2">
      <ColumnHeader title="Corps season" hint="Pick a season, then click a corps to add it." />
      <p className="text-xs text-muted-foreground">
        {season === '2026'
          ? 'Showing the 2026 field; corps that haven’t performed a show yet are greyed out.'
          : `Showing corps that competed in ${season}.`}
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
        matches={visible}
        heightClass="h-96"
        atCap={disabled}
        isUnavailable={(c) => season === '2026' && available.size > 0 && !available.has(c.slug)}
        unavailableTitle={(c) => `${c.name} hasn’t performed a show in ${season} yet`}
        isAdded={(c) => addedTokens.has(`corps~${c.slug}~${season}`)}
        onSelect={(c) => onAdd({ kind: 'corps', corpsSlug: c.slug, season })}
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
  roster2026,
  addedTokens,
  disabled,
  onAdd,
  onPreview,
}: {
  corpsOptions: CorpsOption[];
  roster2026: string[];
  addedTokens: Set<string>;
  disabled?: boolean;
  onAdd: (s: VsSeries) => void;
  onPreview: (s: VsSeries | null) => void;
}) {
  const [query, setQuery] = useState('');
  const matches = useCorpsMatches(corpsOptions, query);
  // Only corps with a 2026 prediction (the roster) — others have no curve to add.
  const roster = useMemo(() => new Set(roster2026), [roster2026]);
  const visible = useMemo(
    () => (roster.size ? matches.filter((c) => roster.has(c.slug)) : matches),
    [matches, roster]
  );

  // "Forecast as of": clicking a corps opens its own snapshot dates (fetched on
  // click — an event handler, not a mount effect) so you can replay the model's
  // projection as it stood on a past date. Each added line keeps its own date.
  const [picked, setPicked] = useState<CorpsOption | null>(null);
  const [dates, setDates] = useState<string[] | null>(null);
  const [asOf, setAsOf] = useState('');

  const pick = (c: CorpsOption) => {
    setPicked(c);
    setDates(null);
    onPreview(null);
    getVs2026SnapshotDates({ data: { slug: c.slug } })
      .then((r) => {
        setDates(r.dates);
        if (r.dates[0]) setAsOf(r.dates[0]); // dates are newest-first → default latest
      })
      .catch(() => setDates([]));
  };
  const back = () => {
    setPicked(null);
    setDates(null);
  };

  const ascDates = dates ? [...dates].sort() : [];
  const asOfIdx = Math.max(0, ascDates.indexOf(asOf));
  const asOfLatest = asOfIdx >= ascDates.length - 1;

  const addPicked = () => {
    if (!picked) return;
    // "Latest" reuses the well-tested predicted-to-finals path; a past date adds
    // the as-of snapshot series (read-model-backed, works in prod).
    onAdd(
      asOfLatest
        ? { kind: 'predicted', corpsSlug: picked.slug }
        : { kind: 'prediction', corpsSlug: picked.slug, asOf }
    );
    back();
  };

  return (
    <div className="space-y-2">
      <ColumnHeader title="2026 prediction" hint="The model’s projected finish for the 2026 season." />
      {!picked ? (
        <>
          <p className="text-xs text-muted-foreground">
            Click a corps to add its predicted-to-finals curve (a dashed line with an uncertainty
            band) — then optionally replay it “as of” an earlier date.
          </p>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search corps…"
            className={fieldCls}
          />
          <CorpsResultList
            matches={visible}
            heightClass="h-96"
            atCap={disabled}
            isAdded={(c) => addedTokens.has(`forecast~${c.slug}`)}
            onSelect={pick}
            onHover={(c) => onPreview(c ? { kind: 'predicted', corpsSlug: c.slug } : null)}
          />
        </>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
            <span className="truncate font-medium text-text-primary">{picked.name}</span>
            <button
              type="button"
              onClick={back}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              change
            </button>
          </div>
          <span className="text-sm text-text-secondary">Forecast as of</span>
          {dates === null ? (
            <p className="text-xs text-muted-foreground">Loading dates…</p>
          ) : dates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No 2026 snapshots available.</p>
          ) : (
            <>
              <p className="text-xs leading-snug text-muted-foreground">
                Replay the model’s projected finish as it stood on a past date. Earlier snapshots
                knew fewer of the season’s real scores, so the line sits further from the eventual
                result; later snapshots fold in more scores and tighten toward it.
              </p>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">as of</span>
                <span className="font-medium text-text-primary">
                  {fmtSnapDate(asOf)}
                  {asOfLatest ? ' · latest' : ''}
                </span>
              </div>
              <Slider
                min={0}
                max={Math.max(0, ascDates.length - 1)}
                value={[asOfIdx]}
                onValueChange={(v) => {
                  const n = Array.isArray(v) ? v[0] : v;
                  if (typeof n === 'number' && ascDates[n]) setAsOf(ascDates[n]);
                }}
              />
              <div className="flex justify-between text-[10px] text-text-muted">
                <span>{fmtSnapDate(ascDates[0])}</span>
                <span>{fmtSnapDate(ascDates[ascDates.length - 1])}</span>
              </div>
              <button
                type="button"
                onClick={addPicked}
                disabled={disabled}
                className="w-full rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Add {asOfLatest ? 'forecast' : `forecast · as of ${fmtSnapDate(asOf)}`}
              </button>
            </>
          )}
        </div>
      )}
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
  const customAdded = parsed !== null && addedTokens.has(`baseline~${parsed}`);

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
            disabled={(disabled && !customAdded) || parsed === null}
            title={customAdded ? 'In the comparison — click to remove' : undefined}
            onClick={() => parsed !== null && add(parsed)}
            onMouseEnter={() => parsed !== null && !customAdded && onPreview({ kind: 'baseline', rank: parsed })}
            onMouseLeave={() => onPreview(null)}
            onFocus={() => parsed !== null && !customAdded && onPreview({ kind: 'baseline', rank: parsed })}
            onBlur={() => onPreview(null)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              customAdded
                ? 'border-primary/40 text-text-secondary'
                : 'border-border text-text-secondary hover:border-primary/60 hover:text-foreground'
            )}
          >
            <Icon icon={customAdded ? Cancel01Icon : AddCircleIcon} size="sm" className="size-4" />
            {customAdded ? 'Remove' : 'Add'}
          </button>
        </div>
      </label>
    </div>
  );
}

export function AddCompareSection({
  caption,
  onCaption,
  onAdd,
  onPreview,
  corpsOptions = [],
  availabilityBySeason = {},
  roster2026 = [],
  addedTokens = new Set(),
  atCap = false,
  capMessage,
}: {
  /** The caption the whole comparison is scoped to. */
  caption: VsCaption;
  /** Switch the active caption. */
  onCaption: (c: VsCaption) => void;
  onAdd: (s: VsSeries) => void;
  /** Hover/focus an option → preview it on the chart; null clears the preview. */
  onPreview: (s: VsSeries | null) => void;
  corpsOptions?: CorpsOption[];
  /** `{ [season]: slug[] }` — which corps have data per season (for grey-out). */
  availabilityBySeason?: Record<string, string[]>;
  /** The 2026 field (slugs with a predicted curve) — corps lists restrict to it. */
  roster2026?: string[];
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
          Layer more lines onto the chart: a corps’ season, a 2026 prediction, or a reference
          baseline (a generic Nth-place corps). Everything aligns by{' '}
          <span className="font-medium text-text-secondary">% through the season</span>. Hover an
          option to preview it; click to add, click an active one to remove. Up to{' '}
          {VS_SERIES_CAP} at once.
        </p>
      </div>

      {/* Caption pills — re-scope the whole chart (Total + categories + captions). */}
      <div className="space-y-1">
        <span className="block pb-px text-xs font-medium text-text-secondary">Caption</span>
        <FilterChips
          ariaLabel="Caption"
          value={caption}
          items={VS_CAPTIONS.map((c) => ({ value: c, label: VS_CAPTION_LABELS[c] }))}
          onSelect={(v) => onCaption(v as VsCaption)}
        />
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
            roster2026={roster2026}
            addedTokens={addedTokens}
            disabled={atCap}
            onAdd={add}
            onPreview={onPreview}
          />
        </div>
        <div className={cn('rounded-lg border border-border p-3', tab === 'prediction' ? 'block' : 'hidden', 'sm:block')}>
          <PredictionColumn
            corpsOptions={corpsOptions}
            roster2026={roster2026}
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
