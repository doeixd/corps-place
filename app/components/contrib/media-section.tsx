import { useState } from 'react';
import { useForm, Form, Field } from '@formisch/react';
import { For, Show } from 'jotai-solid-api';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowOverride } from '@/lib/server-fns/contrib';
import type { OverrideRow } from '@/lib/contrib/store';
import { MediaRowInputSchema, type MediaRowInput } from '@/lib/contrib/schemas';
import { mediaNaturalKey, mergeMedia, type MergedMediaRow } from '@/lib/contrib/seedable';
import { SourceBadge, DivergenceBadge } from '@/components/contrib/provenance';
import { useRowMutation } from '@/components/contrib/use-row-mutation';
import {
  CitationMarks,
  CitationPicker,
  type CitationOption,
} from '@/components/contrib/citation-controls';
import type { ShowDetailMedia } from '@sdk/src/readModel/builders/shows.js';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { ProgressiveImage } from '@/components/progressive-image';
import { ViewIcon } from '@/components/icons/generated';

const inputCls =
  'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

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
  const { busy, error, run } = useRowMutation();
  const hide = () =>
    run(async () => {
      await saveShowOverride({
        data: {
          corpsKey,
          season,
          pinnedKey: 'media',
          naturalKey: row.naturalKey,
          state: 'hidden',
          content: null,
          expectedUpdatedAt: row.overrideUpdatedAt,
        },
      });
      onHidden();
    });

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
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
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
  const form = useForm({
    schema: MediaRowInputSchema,
    initialInput: {
      mediaType: row.mediaType ?? '',
      title: row.title ?? '',
      description: row.description ?? '',
      url: row.url,
      thumbnailUrl: row.thumbnailUrl ?? '',
      attribution: row.attribution ?? '',
      publishedAt: row.publishedAt ?? '',
      durationSeconds: row.durationSeconds,
      citationIds: row.citationIds ?? [],
    },
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (content: MediaRowInput) => {
    setSaving(true);
    setError(null);
    try {
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
          expectedUpdatedAt: row.overrideUpdatedAt,
        },
      });
      onSaved({
        ...row,
        ...content,
        naturalKey,
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
    <Form of={form} onSubmit={submit} className="space-y-2">
      <Field of={form} path={['url']}>
        {(f) => (
          <div>
            <input
              value={str(f.input)}
              onChange={(e) => f.onChange(e.target.value)}
              placeholder="Media URL"
              className={inputCls}
            />
            {f.errors ? (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {f.errors[0]}
              </p>
            ) : null}
          </div>
        )}
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field of={form} path={['title']}>
          {(f) => (
            <input
              value={str(f.input)}
              onChange={(e) => f.onChange(e.target.value)}
              placeholder="Title"
              className={inputCls}
            />
          )}
        </Field>
        <Field of={form} path={['mediaType']}>
          {(f) => (
            <input
              value={str(f.input)}
              onChange={(e) => f.onChange(e.target.value)}
              placeholder="Type"
              className={inputCls}
            />
          )}
        </Field>
      </div>
      <Field of={form} path={['attribution']}>
        {(f) => (
          <input
            value={str(f.input)}
            onChange={(e) => f.onChange(e.target.value)}
            placeholder="Attribution"
            className={inputCls}
          />
        )}
      </Field>
      <Field of={form} path={['thumbnailUrl']}>
        {(f) => (
          <input
            value={str(f.input)}
            onChange={(e) => f.onChange(e.target.value)}
            placeholder="Thumbnail URL"
            className={inputCls}
          />
        )}
      </Field>
      <Field of={form} path={['description']}>
        {(f) => (
          <textarea
            value={str(f.input)}
            onChange={(e) => f.onChange(e.target.value)}
            placeholder="Description"
            className={`min-h-20 ${inputCls}`}
          />
        )}
      </Field>
      <Field of={form} path={['durationSeconds']}>
        {(f) => (
          <input
            type="number"
            min={0}
            value={num(f.input)}
            onChange={(e) => f.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
            placeholder="Duration seconds"
            className={inputCls}
          />
        )}
      </Field>
      <Field of={form} path={['citationIds']}>
        {(f) => (
          <CitationPicker
            selected={(f.input as string[] | undefined) ?? []}
            citations={citations}
            onChange={(citationIds) => f.onChange(citationIds)}
          />
        )}
      </Field>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Form>
  );
}

const str = (x: unknown) => (typeof x === 'string' ? x : '');
const num = (x: unknown) => (typeof x === 'number' && !Number.isNaN(x) ? String(x) : '');

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
