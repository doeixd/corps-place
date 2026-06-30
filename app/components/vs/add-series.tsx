// VS "Add to compare" builder (plan M5/M7). Type chooser → contextual fields:
// Corps (name-search combobox → seasons the corps actually competed), Prediction
// (combobox → real 2026 as-of snapshot dates), or Baseline (rank stepper). The
// builder only offers valid values, so the URL never claims a series that can't
// render. Pure client UI — the parent owns the series list / URL.
import { useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Icon } from '@/components/icon';
import { AddCircleIcon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';
import { getVsCorpsSeasons, getVs2026SnapshotDates } from '@/lib/server-fns/vs';
import type { VsSeries } from '@/lib/vs/types';

type Kind = 'corps' | 'prediction' | 'baseline';
export interface CorpsOption {
  slug: string;
  name: string;
}

// Fallback season chips while a corps's real seasons load (or if none come back).
const FALLBACK_SEASONS = Array.from({ length: 11 }, (_, i) => String(2026 - i));

const fieldCls =
  'w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60';

// Snapshot dates are 'YYYY-MM-DD'; render them compactly (UTC, so no day-shift).
const fmtDate = (d: string) => {
  if (!d) return '';
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export function AddSeries({
  onAdd,
  disabled,
  corpsOptions = [],
}: {
  onAdd: (s: VsSeries) => void;
  disabled?: boolean;
  corpsOptions?: CorpsOption[];
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('corps');
  const [rank, setRank] = useState(13);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<CorpsOption | null>(null);
  const [season, setSeason] = useState('2025');
  const [seasons, setSeasons] = useState<string[] | null>(null);
  const [asOf, setAsOf] = useState('');
  const [dates, setDates] = useState<string[] | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? corpsOptions.filter((c) => c.name.toLowerCase().includes(q)) : corpsOptions;
    return base.slice(0, 8);
  }, [query, corpsOptions]);

  // Snapshot dates come newest-first; the slider runs oldest → newest (left →
  // right), so a fresh pick (newest) lands at the right edge ("latest").
  const ascDates = dates ? [...dates].sort() : [];
  const asOfIdx = Math.max(0, ascDates.indexOf(asOf));
  const asOfLatest = asOfIdx >= ascDates.length - 1;

  const reset = () => {
    setQuery('');
    setPicked(null);
    setSeasons(null);
    setDates(null);
  };

  const pick = (c: CorpsOption) => {
    setPicked(c);
    if (kind === 'prediction') {
      setDates(null);
      getVs2026SnapshotDates({ data: { slug: c.slug } })
        .then((r) => {
          setDates(r.dates);
          if (r.dates[0]) setAsOf(r.dates[0]);
        })
        .catch(() => setDates([]));
    } else {
      setSeasons(null);
      getVsCorpsSeasons({ data: { slug: c.slug } })
        .then((r) => {
          setSeasons(r.seasons);
          if (r.seasons.length && !r.seasons.includes(season)) setSeason(r.seasons[0]);
        })
        .catch(() => setSeasons([]));
    }
  };

  const canAdd =
    kind === 'baseline'
      ? rank >= 1 && rank <= 24
      : kind === 'corps'
        ? !!picked && !!season
        : !!picked && !!asOf;

  const submit = () => {
    if (!canAdd) return;
    if (kind === 'baseline') onAdd({ kind: 'baseline', rank });
    else if (kind === 'corps') onAdd({ kind: 'corps', corpsSlug: picked!.slug, season });
    else onAdd({ kind: 'prediction', corpsSlug: picked!.slug, asOf });
    reset();
    setOpen(false);
  };

  const seasonChips = seasons && seasons.length ? seasons : FALLBACK_SEASONS;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Icon icon={AddCircleIcon} size="sm" className="size-4" />
        Add to compare
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 p-3">
        <div className="inline-flex rounded-lg border border-border p-0.5 text-xs">
          {(['corps', 'prediction', 'baseline'] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setKind(k);
                reset();
              }}
              className={cn(
                'rounded px-2 py-1 capitalize transition-colors',
                kind === k ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {k}
            </button>
          ))}
        </div>

        {kind === 'baseline' ? (
          <label className="block space-y-1">
            <span className="text-sm text-text-secondary">Place (rank 1–24)</span>
            <input
              type="number"
              min={1}
              max={24}
              value={rank}
              onChange={(e) => setRank(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
              className={fieldCls}
            />
            <span className="block text-xs text-muted-foreground">
              A generic Nth-place corps, averaged across seasons.
            </span>
          </label>
        ) : !picked ? (
          <div className="space-y-1">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search corps…"
              autoFocus
              className={fieldCls}
            />
            <div className="themed-scrollbar max-h-48 space-y-0.5 overflow-y-auto">
              {matches.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">No matches.</p>
              ) : (
                matches.map((c) => (
                  <button
                    key={c.slug}
                    type="button"
                    onClick={() => pick(c)}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {c.name}
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm">
              <span className="truncate font-medium text-text-primary">{picked.name}</span>
              <button
                type="button"
                onClick={reset}
                className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
              >
                change
              </button>
            </div>

            {kind === 'corps' ? (
              <div className="space-y-1">
                <span className="text-sm text-text-secondary">
                  Season{seasons === null ? ' …' : ''}
                </span>
                <div className="flex flex-wrap gap-1">
                  {seasonChips.map((y) => (
                    <button
                      key={y}
                      type="button"
                      onClick={() => setSeason(y)}
                      className={cn(
                        'rounded-md border px-2 py-0.5 text-xs transition-colors',
                        season === y
                          ? 'border-primary/60 bg-accent text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {y}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                <span className="text-sm text-text-secondary">Forecast as of</span>
                {dates === null ? (
                  <p className="text-xs text-muted-foreground">Loading dates…</p>
                ) : dates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No 2026 snapshots available.</p>
                ) : (
                  <>
                    {/* Explanation so the control reads clearly. */}
                    <p className="text-xs leading-snug text-muted-foreground">
                      Replay the model’s projected finish as it stood on a past date. Earlier
                      snapshots knew fewer of the season’s real scores, so the line sits further from
                      the eventual result; later snapshots fold in more scores and tighten toward it.
                    </p>
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-muted-foreground">as of</span>
                      <span className="font-medium text-text-primary">
                        {fmtDate(asOf)}
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
                      <span>{fmtDate(ascDates[0])}</span>
                      <span>{fmtDate(ascDates[ascDates.length - 1])}</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <Button onClick={submit} disabled={!canAdd} className="w-full">
          Add
        </Button>
      </PopoverContent>
    </Popover>
  );
}
