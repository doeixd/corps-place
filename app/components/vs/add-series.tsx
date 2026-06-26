// VS "Add to compare" builder (plan M5). A popover with a type chooser and
// contextual fields that pushes a new VsSeries. v1 supports Baseline (rank) and
// Corps (slug + season); a searchable corps combobox with season-chips and the
// 2026 Prediction-as-of picker are noted follow-ups. Pure client UI — the parent
// owns the series list / URL.
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { AddCircleIcon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';
import type { VsSeries } from '@/lib/vs/types';

type Kind = 'baseline' | 'corps';

const SLUG_RE = /^[a-z0-9-]+$/;
const SEASON_RE = /^\d{4}$/;
const fieldCls =
  'w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/60';

export function AddSeries({
  onAdd,
  disabled,
}: {
  onAdd: (s: VsSeries) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('baseline');
  const [slug, setSlug] = useState('');
  const [season, setSeason] = useState('2025');
  const [rank, setRank] = useState(13);

  const slugOk = SLUG_RE.test(slug.trim().toLowerCase());
  const seasonOk = SEASON_RE.test(season.trim());
  const canAdd = kind === 'baseline' ? rank >= 1 && rank <= 25 : slugOk && seasonOk;

  const submit = () => {
    if (!canAdd) return;
    onAdd(
      kind === 'baseline'
        ? { kind: 'baseline', rank }
        : { kind: 'corps', corpsSlug: slug.trim().toLowerCase(), season: season.trim() }
    );
    setSlug('');
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
          {(['baseline', 'corps'] as Kind[]).map((k) => (
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
            <span className="text-sm text-text-secondary">Place (rank 1–25)</span>
            <input
              type="number"
              min={1}
              max={25}
              value={rank}
              onChange={(e) => setRank(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
              className={fieldCls}
            />
            <span className="block text-xs text-muted-foreground">
              A generic Nth-place corps, averaged across seasons.
            </span>
          </label>
        ) : (
          <div className="space-y-2">
            <label className="block space-y-1">
              <span className="text-sm text-text-secondary">Corps slug</span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="blue-devils"
                className={fieldCls}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm text-text-secondary">Season</span>
              <input
                value={season}
                onChange={(e) => setSeason(e.target.value)}
                placeholder="2025"
                inputMode="numeric"
                className={fieldCls}
              />
            </label>
          </div>
        )}

        <Button onClick={submit} disabled={!canAdd} className="w-full">
          Add
        </Button>
      </PopoverContent>
    </Popover>
  );
}
