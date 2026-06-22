import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { saveShowBlock } from '@/lib/server-fns/contrib';
import { searchStaff, type StaffSearchResult } from '@/lib/server-fns/hybrid';
import type { StaffInput } from '@/lib/contrib/schemas';
import type { ShowDetailDesigner } from '@sdk/src/readModel/builders/shows.js';
import { ContribBlock } from '@/components/contrib/block-sections';
import { ProgressiveImage } from '@/components/progressive-image';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { UserGroupIcon, AddCircleIcon, Cancel01Icon } from '@/components/icons/generated';

type StaffMember = StaffInput['items'][number];

/**
 * Design & staff (seedable authored block). Renders the scraped designers until a
 * contributor edits; the editor pre-fills from the scrape so people refine rather
 * than retype, and each member can be linked to a staff-directory profile.
 */
export function StaffSection({
  corpsKey,
  season,
  initial,
  scraped,
}: {
  corpsKey: string;
  season: string;
  initial: StaffInput | null;
  scraped: ShowDetailDesigner[];
}) {
  const [value, setValue] = useState<StaffInput | null>(initial);
  // What we display: authored list wins; otherwise the scraped designers.
  const members: StaffMember[] =
    value?.items ?? scraped.map((d) => ({ role: d.role, name: d.name, personId: '' }));

  return (
    <ContribBlock
      icon={UserGroupIcon}
      title="Design & staff"
      emptyHint="The design team and staff for this show haven't been added yet."
      hasContent={members.length > 0}
      view={
        <ul className="grid gap-2 sm:grid-cols-2">
          {members.map((m, i) => (
            <li
              key={i}
              className="flex items-baseline justify-between gap-3 border-b border-foreground/10 pb-2"
            >
              <span className="text-text-secondary">{m.role}</span>
              {m.personId ? (
                <Link
                  to="/staff/$personId"
                  params={{ personId: m.personId }}
                  className="text-right font-medium text-text-primary underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                >
                  {m.name}
                </Link>
              ) : (
                <span className="text-right font-medium text-text-primary">{m.name}</span>
              )}
            </li>
          ))}
        </ul>
      }
      edit={(close) => (
        <StaffEditor
          corpsKey={corpsKey}
          season={season}
          seed={members}
          onSaved={(v) => {
            setValue(v);
            close();
          }}
        />
      )}
    />
  );
}

function StaffEditor({
  corpsKey,
  season,
  seed,
  onSaved,
}: {
  corpsKey: string;
  season: string;
  seed: StaffMember[];
  onSaved: (v: StaffInput) => void;
}) {
  const [items, setItems] = useState<StaffMember[]>(
    seed.length ? seed : [{ role: '', name: '', personId: '' }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<StaffMember>) =>
    setItems((xs) => xs.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const content: StaffInput = { items: items.filter((it) => it.name.trim()) };
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'staff', content } });
      onSaved(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2">
          <Input
            placeholder="Role (e.g. Brass arranger)"
            value={it.role ?? ''}
            onChange={(e) => update(i, { role: e.target.value })}
            className="w-2/5 shrink-0"
          />
          <div className="flex-1">
            <StaffPicker
              name={it.name}
              personId={it.personId ?? ''}
              onChange={(name, personId) => update(i, { name, personId })}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}
            aria-label="Remove staff member"
          >
            <Icon icon={Cancel01Icon} size="sm" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setItems((xs) => [...xs, { role: '', name: '', personId: '' }])}
      >
        <Icon icon={AddCircleIcon} size="sm" />
        Add staff member
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div>
        <Button type="button" size="sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save staff'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Name field with staff-directory typeahead. Free text is allowed (people not in
 * the directory); picking a match links the member to their /staff profile.
 */
function StaffPicker({
  name,
  personId,
  onChange,
}: {
  name: string;
  personId: string;
  onChange: (name: string, personId: string) => void;
}) {
  const [results, setResults] = useState<StaffSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = (q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        setResults(await searchStaff({ data: q }));
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 250);
  };

  return (
    <div className="relative">
      <Input
        placeholder="Name"
        value={name}
        aria-invalid={!name.trim() ? true : undefined}
        onChange={(e) => {
          // Typing clears any prior link until a match is picked.
          onChange(e.target.value, '');
          runSearch(e.target.value);
        }}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {personId ? (
        <span className="mt-0.5 block text-xs text-success-foreground">✓ Linked to profile</span>
      ) : null}
      {open && results.length > 0 ? (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          {results.map((r) => (
            <li key={r.personId}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // mousedown beats the input's blur so the pick registers.
                  e.preventDefault();
                  onChange(r.displayName, r.personId);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-muted"
              >
                <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                  {r.photoUrl ? (
                    <ProgressiveImage
                      src={r.photoUrl}
                      alt=""
                      width={28}
                      fit="cover"
                      className="size-7"
                    />
                  ) : (
                    <Icon icon={UserGroupIcon} size="sm" className="text-text-secondary" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-text-primary">
                    {r.displayName}
                  </span>
                  {r.defaultTitle ? (
                    <span className="block truncate text-xs text-text-secondary">
                      {r.defaultTitle}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
