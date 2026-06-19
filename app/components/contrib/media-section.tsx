import { useState } from 'react';
import { For, Show } from 'jotai-solid-api';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowOverride } from '@/lib/server-fns/contrib';
import type { OverrideRow } from '@/lib/contrib/store';
import type { MediaRowInput } from '@/lib/contrib/schemas';
import {
  mediaNaturalKey,
  mergeMedia,
  sourceHash,
  type MergedMediaRow,
} from '@/lib/contrib/seedable';
import {
  CitationMarks,
  CitationPicker,
  type CitationOption,
} from '@/components/contrib/citation-controls';
import type { ShowDetailMedia } from '@sdk/src/readModel/builders/shows.js';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { ProgressiveImage } from '@/components/progressive-image';
import { ViewIcon } from '@/components/icons/generated';

const inputCls = 'w-full rounded border border-border bg-transparent px-2 py-1 text-sm';

export function MediaSection({
  corpsKey,
  season,
  scraped,
  overrides,
  citations,
}: {
  corpsKey: string;
  season: string;
  scraped: readonly ShowDetailMedia[];
  overrides: readonly OverrideRow[];
  citations: readonly CitationOption[];
}) {
  const { data: session } = useSession();
  const [rows, setRows] = useState(() => mergeMedia(scraped, overrides));
  const [editing, setEditing] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState<MergedMediaRow | null>(null);
  const signedIn = Boolean(session?.user);

  const replaceRow = (naturalKey: string, next: MergedMediaRow) =>
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
            <Icon icon={ViewIcon} size="sm" />
            Media
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
              Add media
            </button>
          ) : null}
        </div>

        <Show
          when={rows.length > 0}
          fallback={
            <div className="flex items-center gap-3 text-text-secondary">
              <p className="text-sm">Videos, photos and announcement links have not been added.</p>
              {!signedIn ? (
                <button
                  type="button"
                  onClick={() =>
                    signIn.social({ provider: 'google', callbackURL: window.location.pathname })
                  }
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm hover:border-primary/60 hover:text-foreground"
                >
                  Sign in to contribute
                </button>
              ) : null}
            </div>
          }
        >
          <ul className="grid gap-3 sm:grid-cols-2">
            <For each={rows}>
              {(row) => (
                <li>
                  {editing === row.naturalKey ? (
                    <MediaEditor
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
                    <MediaRow
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
          </ul>
        </Show>

        {editing === 'new' && newDraft ? (
          <div className="mt-4 border-t border-foreground/10 pt-4">
            <MediaEditor
              row={newDraft}
              corpsKey={corpsKey}
              season={season}
              citations={citations}
              onCancel={() => {
                setEditing(null);
                setNewDraft(null);
              }}
              onSaved={(next) => {
                setRows((current) => [...current, next]);
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

function MediaRow({
  row,
  signedIn,
  corpsKey,
  season,
  onEdit,
  onHidden,
  citations,
}: {
  row: MergedMediaRow;
  signedIn: boolean;
  corpsKey: string;
  season: string;
  onEdit: () => void;
  onHidden: () => void;
  citations: readonly CitationOption[];
}) {
  const [busy, setBusy] = useState(false);
  const hide = async () => {
    setBusy(true);
    try {
      await saveShowOverride({
        data: {
          corpsKey,
          season,
          pinnedKey: 'media',
          naturalKey: row.naturalKey,
          state: 'hidden',
          content: null,
          sourceHash: row.sourceHash,
          expectedUpdatedAt: row.overrideUpdatedAt,
        },
      });
      onHidden();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg p-2 ring-1 ring-foreground/10">
      <a
        href={row.url}
        target="_blank"
        rel="noreferrer"
        className="flex gap-3 hover:bg-foreground/5"
      >
        <Show when={row.thumbnailUrl}>
          {(thumb) => (
            <ProgressiveImage
              src={thumb}
              alt=""
              width={112}
              fit="cover"
              lazy
              className="size-14 shrink-0 rounded"
            />
          )}
        </Show>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-text-primary">
            {row.title || row.mediaType || 'Media'}
            <CitationMarks citationIds={row.citationIds} citations={citations} />
          </span>
          <Show when={row.attribution}>
            {(attribution) => (
              <span className="block truncate text-xs text-text-secondary">{attribution}</span>
            )}
          </Show>
          <Show when={row.description}>
            {(description) => (
              <span className="mt-1 line-clamp-2 block text-xs text-text-secondary">
                {description}
              </span>
            )}
          </Show>
        </span>
      </a>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5 text-[11px] uppercase tracking-wide text-text-secondary">
          <SourceBadge row={row} />
          {row.overridden ? (
            <span className="rounded bg-foreground/5 px-1.5 py-0.5">Edited by fan</span>
          ) : null}
          {row.scrapeDiverged ? (
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700">
              Source changed
            </span>
          ) : null}
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
    </div>
  );
}

function MediaEditor({
  row,
  corpsKey,
  season,
  onCancel,
  onSaved,
  citations,
}: {
  row: MergedMediaRow;
  corpsKey: string;
  season: string;
  onCancel: () => void;
  onSaved: (row: MergedMediaRow) => void;
  citations: readonly CitationOption[];
}) {
  const [draft, setDraft] = useState<MediaRowInput>(row);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof MediaRowInput, value: MediaRowInput[keyof MediaRowInput]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const content = blankToEmpty(draft);
      const state = row.added ? 'added' : 'edited';
      const naturalKey = row.added ? mediaNaturalKey({ url: content.url }) : row.naturalKey;
      const res = await saveShowOverride({
        data: {
          corpsKey,
          season,
          pinnedKey: 'media',
          naturalKey,
          state,
          content,
          sourceHash: row.sourceHash,
          expectedUpdatedAt: row.overrideUpdatedAt,
        },
      });
      onSaved({
        ...row,
        ...content,
        naturalKey,
        sourceHash: row.sourceHash ?? sourceHash(content),
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
        value={draft.url}
        onChange={(e) => set('url', e.target.value)}
        placeholder="Media URL"
        className={inputCls}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={draft.title ?? ''}
          onChange={(e) => set('title', e.target.value)}
          placeholder="Title"
          className={inputCls}
        />
        <input
          value={draft.mediaType ?? ''}
          onChange={(e) => set('mediaType', e.target.value)}
          placeholder="Type"
          className={inputCls}
        />
      </div>
      <input
        value={draft.attribution ?? ''}
        onChange={(e) => set('attribution', e.target.value)}
        placeholder="Attribution"
        className={inputCls}
      />
      <input
        value={draft.thumbnailUrl ?? ''}
        onChange={(e) => set('thumbnailUrl', e.target.value)}
        placeholder="Thumbnail URL"
        className={inputCls}
      />
      <textarea
        value={draft.description ?? ''}
        onChange={(e) => set('description', e.target.value)}
        placeholder="Description"
        className={`min-h-20 ${inputCls}`}
      />
      <input
        type="number"
        min={0}
        value={draft.durationSeconds ?? ''}
        onChange={(e) =>
          set('durationSeconds', e.target.value === '' ? undefined : Number(e.target.value))
        }
        placeholder="Duration seconds"
        className={inputCls}
      />
      <CitationPicker
        selected={draft.citationIds}
        citations={citations}
        onChange={(citationIds) => set('citationIds', citationIds)}
      />
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border px-4 py-1.5 text-sm text-text-secondary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const newRow = (index: number): MergedMediaRow => ({
  mediaType: '',
  title: '',
  description: '',
  url: '',
  thumbnailUrl: '',
  attribution: '',
  publishedAt: '',
  durationSeconds: undefined,
  citationIds: [],
  naturalKey: `fan-added-media#${index + 1}-${Date.now()}`,
  sourceHash: null,
  source: null,
  sourceAuthority: null,
  scrapeDiverged: false,
  overrideUpdatedAt: null,
  overridden: false,
  added: true,
});

const blankToEmpty = (row: MediaRowInput): MediaRowInput => ({
  mediaType: row.mediaType?.trim() ?? '',
  title: row.title?.trim() ?? '',
  description: row.description?.trim() ?? '',
  url: row.url.trim(),
  thumbnailUrl: row.thumbnailUrl?.trim() ?? '',
  attribution: row.attribution?.trim() ?? '',
  publishedAt: row.publishedAt?.trim() ?? '',
  durationSeconds: row.durationSeconds,
  citationIds: row.citationIds ?? [],
});

function SourceBadge({ row }: { row: MergedMediaRow }) {
  if (row.sourceAuthority === 100 || row.source === 'dci-yearbook') {
    return <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">DCI Yearbook</span>;
  }
  if (row.source)
    return <span className="rounded bg-foreground/5 px-1.5 py-0.5">{row.source}</span>;
  if (row.added) return <span className="rounded bg-foreground/5 px-1.5 py-0.5">Fan added</span>;
  return <span className="rounded bg-foreground/5 px-1.5 py-0.5">Scraped</span>;
}
