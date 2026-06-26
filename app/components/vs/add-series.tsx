// VS "Add to compare" builder (plan M5/M7). A popover with a type chooser and
// contextual fields that pushes a new VsSeries. Corps mode is a searchable
// combobox (filter by name) + season chips; Baseline mode is a rank stepper.
// Pure client UI — the parent owns the series list / URL. The 2026 Prediction
// as-of picker remains a follow-up.
import { useMemo, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { AddCircleIcon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';
import type { VsSeries } from '@/lib/vs/types';

type Kind = 'baseline' | 'corps';
export interface CorpsOption {
  slug: string;
  name: string;
}

// Recent seasons offered as chips (newest first). Per-corps constraint to a
// corps's real appearance seasons is a noted refinement.
const SEASONS = Array.from({ length: 11 }, (_, i) => String(2026 - i));

const fieldCls =
  'w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60';

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

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return corpsOptions.slice(0, 8);
    return corpsOptions.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [query, corpsOptions]);

  const canAdd = kind === 'baseline' ? rank >= 1 && rank <= 24 : !!picked;

  const reset = () => {
    setQuery('');
    setPicked(null);
  };

  const submit = () => {
    if (!canAdd) return;
    onAdd(
      kind === 'baseline'
        ? { kind: 'baseline', rank }
        : { kind: 'corps', corpsSlug: picked!.slug, season }
    );
    reset();
    setOpen(false);
  };

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
          {(['corps', 'baseline'] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={cn(
                'rounded px-2.5 py-1 capitalize transition-colors',
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
        ) : picked ? (
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
            <div className="space-y-1">
              <span className="text-sm text-text-secondary">Season</span>
              <div className="flex flex-wrap gap-1">
                {SEASONS.map((y) => (
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
          </div>
        ) : (
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
                    onClick={() => setPicked(c)}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {c.name}
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <Button onClick={submit} disabled={!canAdd} className="w-full">
          Add
        </Button>
      </PopoverContent>
    </Popover>
  );
}
