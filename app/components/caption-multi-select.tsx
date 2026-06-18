import { useMemo } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CaptionChip } from '@/components/caption-chip';
import { Icon } from '@/components/icon';
import {
  captionFamily,
  captionFamilyMeta,
  byCaptionFamily,
  type CaptionFamily,
} from '@/lib/caption-family';
import { cn } from '@/lib/utils';
import { ArrowDown01Icon, Tick02Icon } from '@/components/icons/generated';

// GE → Visual → Music (recap convention; matches caption family `order`).
const FAMILY_ORDER: CaptionFamily[] = ['ge', 'visual', 'music'];

type BoxState = 'on' | 'off' | 'mixed';

// A small visual checkbox (not an input) — the whole row is the click target, so
// this only renders state. `mixed` is the family header's "some selected" dash.
function CheckBox({ state }: { state: BoxState }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
        state === 'off' ? 'border-input' : 'border-primary bg-primary text-primary-foreground'
      )}
    >
      {state === 'on' ? <Icon icon={Tick02Icon} className="size-3" /> : null}
      {state === 'mixed' ? <span className="h-0.5 w-2 rounded-full bg-primary-foreground" /> : null}
    </span>
  );
}

/**
 * A grouped multi-select for caption names: options are grouped under their
 * scoring-family headers (General Effect / Visual / Music), and each family
 * header is a tri-state select-all for the subcaptions present beneath it.
 * Selection is controlled; empty `selected` means "no filter" (caller shows all).
 *
 * Generic over caption data — the caller passes the distinct caption names it has
 * (e.g. a judge's career captions), so no dead options appear.
 */
export function CaptionMultiSelect({
  available,
  selected,
  onChange,
}: {
  available: readonly string[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  const selectedSet = new Set(selected);

  // Group the available captions by family, ordered GE → Visual → Music, with
  // subcaptions sorted within each family. Families with no captions are dropped.
  const groups = useMemo(() => {
    const byFamily = new Map<CaptionFamily, string[]>();
    for (const caption of available) {
      const family = captionFamily(caption);
      const list = byFamily.get(family) ?? [];
      list.push(caption);
      byFamily.set(family, list);
    }
    return FAMILY_ORDER.filter((f) => byFamily.has(f)).map((family) => {
      const captions = byFamily.get(family)!.slice().sort(byCaptionFamily);
      // `captionFamilyMeta` carries the family label + icon (shared across the
      // family's subcaptions), so any caption in the group resolves them.
      const meta = captionFamilyMeta(captions[0]);
      return { family, label: meta.label, icon: meta.icon, captions };
    });
  }, [available]);

  const emit = (set: Set<string>) => onChange([...set].sort(byCaptionFamily));

  const toggleCaption = (caption: string) => {
    const next = new Set(selectedSet);
    if (next.has(caption)) next.delete(caption);
    else next.add(caption);
    emit(next);
  };

  const toggleFamily = (captions: string[]) => {
    const allOn = captions.every((c) => selectedSet.has(c));
    const next = new Set(selectedSet);
    for (const c of captions) {
      if (allOn) next.delete(c);
      else next.add(c);
    }
    emit(next);
  };

  const count = selected.length;
  const summary = count === 0 ? 'All captions' : count === 1 ? selected[0] : `${count} captions`;

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Filter assignments by caption"
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground"
      >
        <span className="max-w-[12rem] truncate">{summary}</span>
        <Icon icon={ArrowDown01Icon} size="sm" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="themed-scrollbar max-h-[60dvh] gap-1 overflow-y-auto p-1.5"
      >
        {groups.map((g) => {
          const allOn = g.captions.every((c) => selectedSet.has(c));
          const someOn = !allOn && g.captions.some((c) => selectedSet.has(c));
          return (
            <div key={g.family} className="mb-1 last:mb-0">
              <button
                type="button"
                role="checkbox"
                aria-checked={allOn ? true : someOn ? 'mixed' : false}
                aria-label={`All ${g.label} captions`}
                onClick={() => toggleFamily(g.captions)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold text-text-secondary transition-colors hover:bg-accent hover:text-foreground"
              >
                <CheckBox state={allOn ? 'on' : someOn ? 'mixed' : 'off'} />
                <Icon icon={g.icon} size="xs" />
                <span>{g.label}</span>
              </button>
              {g.captions.map((caption) => (
                <button
                  key={caption}
                  type="button"
                  role="checkbox"
                  aria-checked={selectedSet.has(caption)}
                  aria-label={caption}
                  onClick={() => toggleCaption(caption)}
                  className="flex w-full items-center gap-2 rounded-md py-1 pl-3 pr-2 text-left transition-colors hover:bg-accent"
                >
                  <CheckBox state={selectedSet.has(caption) ? 'on' : 'off'} />
                  <CaptionChip caption={caption} />
                </button>
              ))}
            </div>
          );
        })}
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
