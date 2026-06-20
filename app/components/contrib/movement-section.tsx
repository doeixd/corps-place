import { useState } from 'react';
import { For, Show } from 'jotai-solid-api';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowOverride } from '@/lib/server-fns/contrib';
import type { OverrideRow } from '@/lib/contrib/store';
import type { MovementRowInput } from '@/lib/contrib/schemas';
import { mergeMovements, type MergedMovementRow } from '@/lib/contrib/seedable';
import { SourceBadge, DivergenceBadge } from '@/components/contrib/provenance';
import { useRowMutation } from '@/components/contrib/use-row-mutation';
import {
  CitationMarks,
  CitationPicker,
  type CitationOption,
} from '@/components/contrib/citation-controls';
import type { ShowDetailMovement } from '@sdk/src/readModel/builders/shows.js';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { KeyframeIcon } from '@/components/icons/generated';

const inputCls =
  'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

export function MovementSection({
  corpsKey,
  season,
  scraped,
  overrides,
  citations,
}: {
  corpsKey: string;
  season: string;
  scraped: readonly ShowDetailMovement[];
  overrides: readonly OverrideRow[];
  citations: readonly CitationOption[];
}) {
  const { data: session } = useSession();
  const [rows, setRows] = useState(() => mergeMovements(scraped, overrides));
  const [editing, setEditing] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState<MergedMovementRow | null>(null);
  const signedIn = Boolean(session?.user);

  const replaceRow = (naturalKey: string, next: MergedMovementRow) =>
    setRows((current) => current.map((row) => (row.naturalKey === naturalKey ? next : row)));
  const removeRow = (naturalKey: string) =>
    setRows((current) => current.filter((row) => row.naturalKey !== naturalKey));

  return (
    <Card
      className={rows.length ? undefined : 'border-2 border-dashed border-foreground/15 ring-0'}
    >
      <CardContent className="py-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Icon icon={KeyframeIcon} size="sm" />
            Movements
          </h2>
          {signedIn ? (
            <button
              type="button"
              onClick={() => {
                setNewDraft(newRow(rows.length));
                setEditing('new');
              }}
              className="text-xs text-text-secondary underline underline-offset-2 hover:text-foreground"
            >
              Add movement
            </button>
          ) : null}
        </div>

        <Show
          when={rows.length > 0}
          fallback={
            <div className="flex items-center gap-3 text-text-secondary">
              <p className="text-sm">Movement titles have not been added yet.</p>
              {!signedIn ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    signIn.social({ provider: 'google', callbackURL: window.location.pathname })
                  }
                >
                  Sign in to contribute
                </Button>
              ) : null}
            </div>
          }
        >
          <ol className="space-y-3">
            <For each={rows}>
              {(row) => (
                <li>
                  {editing === row.naturalKey ? (
                    <MovementEditor
                      row={row}
                      corpsKey={corpsKey}
                      season={season}
                      citations={citations}
                      onCancel={() => setEditing(null)}
                      onSaved={(next) => {
                        replaceRow(row.naturalKey, next);
                        setEditing(null);
                      }}
                    />
                  ) : (
                    <MovementRow
                      row={row}
                      signedIn={signedIn}
                      corpsKey={corpsKey}
                      season={season}
                      citations={citations}
                      onEdit={() => setEditing(row.naturalKey)}
                      onHidden={() => removeRow(row.naturalKey)}
                    />
                  )}
                </li>
              )}
            </For>
          </ol>
        </Show>

        {editing === 'new' && newDraft ? (
          <div className="mt-4 border-t border-foreground/10 pt-4">
            <MovementEditor
              row={newDraft}
              corpsKey={corpsKey}
              season={season}
              citations={citations}
              onCancel={() => {
                setEditing(null);
                setNewDraft(null);
              }}
              onSaved={(next) => {
                setRows((current) => [...current, next].sort((a, b) => a.ordinal - b.ordinal));
                setEditing(null);
                setNewDraft(null);
              }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MovementRow({
  row,
  signedIn,
  corpsKey,
  season,
  onEdit,
  onHidden,
  citations,
}: {
  row: MergedMovementRow;
  signedIn: boolean;
  corpsKey: string;
  season: string;
  onEdit: () => void;
  onHidden: () => void;
  citations: readonly CitationOption[];
}) {
  const { busy, error, run } = useRowMutation();
  const hide = () =>
    run(async () => {
      await saveShowOverride({
        data: {
          corpsKey,
          season,
          pinnedKey: 'movements',
          naturalKey: row.naturalKey,
          state: 'hidden',
          content: null,
          expectedUpdatedAt: row.overrideUpdatedAt,
        },
      });
      onHidden();
    });

  return (
    <div>
      <div className="flex gap-3">
        <span className="text-text-secondary tabular-nums">{row.ordinal}.</span>
        <div className="min-w-0 flex-1">
          <Show
            when={row.title}
            fallback={<span className="text-text-secondary">Untitled movement</span>}
          >
            {(title) => (
              <span className="font-medium text-text-primary">
                {title}
                <CitationMarks citationIds={row.citationIds} citations={citations} />
              </span>
            )}
          </Show>
          <Show when={row.description}>
            {(description) => <p className="text-sm text-text-secondary">{description}</p>}
          </Show>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] uppercase tracking-wide text-text-secondary">
            <SourceBadge
              source={row.source}
              sourceAuthority={row.sourceAuthority}
              added={row.added}
            />
            {row.overridden ? (
              <span className="rounded bg-foreground/5 px-1.5 py-0.5">Edited by fan</span>
            ) : null}
            {row.scrapeDiverged ? (
              <DivergenceBadge
                source={row.source}
                sourceAuthority={row.sourceAuthority}
                season={season}
              />
            ) : null}
          </div>
        </div>
        {signedIn ? (
          <div className="flex shrink-0 gap-2 text-xs">
            <button
              type="button"
              onClick={onEdit}
              className="text-text-secondary underline underline-offset-2 hover:text-foreground"
            >
              Edit
            </button>
            {!row.added ? (
              <button
                type="button"
                onClick={() => void hide()}
                disabled={busy}
                className="text-text-secondary underline underline-offset-2 hover:text-foreground disabled:opacity-50"
              >
                Hide
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function MovementEditor({
  row,
  corpsKey,
  season,
  onCancel,
  onSaved,
  citations,
}: {
  row: MergedMovementRow;
  corpsKey: string;
  season: string;
  onCancel: () => void;
  onSaved: (row: MergedMovementRow) => void;
  citations: readonly CitationOption[];
}) {
  const [draft, setDraft] = useState<MovementRowInput>(row);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof MovementRowInput, value: MovementRowInput[keyof MovementRowInput]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const content = {
        ordinal: Number(draft.ordinal),
        title: draft.title?.trim() ?? '',
        description: draft.description?.trim() ?? '',
        sourceUrl: draft.sourceUrl?.trim() ?? '',
        citationIds: draft.citationIds ?? [],
      };
      const state = row.added ? 'added' : 'edited';
      const res = await saveShowOverride({
        data: {
          corpsKey,
          season,
          pinnedKey: 'movements',
          naturalKey: row.naturalKey,
          state,
          content,
          expectedUpdatedAt: row.overrideUpdatedAt,
        },
      });
      onSaved({
        ...row,
        ...content,
        overrideUpdatedAt: res.updatedAt,
        overridden: true,
        added: state === 'added',
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <input
        type="number"
        min={1}
        value={draft.ordinal}
        onChange={(e) => set('ordinal', Number(e.target.value))}
        placeholder="Order"
        className={inputCls}
      />
      <input
        value={draft.title ?? ''}
        onChange={(e) => set('title', e.target.value)}
        placeholder="Movement title"
        className={inputCls}
      />
      <textarea
        value={draft.description ?? ''}
        onChange={(e) => set('description', e.target.value)}
        placeholder="Description"
        className={`min-h-20 ${inputCls}`}
      />
      <input
        value={draft.sourceUrl ?? ''}
        onChange={(e) => set('sourceUrl', e.target.value)}
        placeholder="Source URL"
        className={inputCls}
      />
      <CitationPicker
        selected={draft.citationIds}
        citations={citations}
        onChange={(citationIds) => set('citationIds', citationIds)}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const newRow = (index: number): MergedMovementRow => ({
  ordinal: index + 1,
  title: '',
  description: '',
  sourceUrl: '',
  citationIds: [],
  naturalKey: `fan-added-movement#${index + 1}-${Date.now()}`,
  sourceHash: null,
  source: null,
  sourceAuthority: null,
  scrapeDiverged: false,
  overrideUpdatedAt: null,
  overridden: false,
  added: true,
});
