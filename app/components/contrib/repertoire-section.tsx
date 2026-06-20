import { useState } from 'react';
import { For, Show } from 'jotai-solid-api';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowOverride } from '@/lib/server-fns/contrib';
import type { OverrideRow } from '@/lib/contrib/store';
import type { RepertoireRowInput } from '@/lib/contrib/schemas';
import { mergeRepertoire, type MergedRepertoireRow } from '@/lib/contrib/seedable';
import { SourceBadge, DivergenceBadge } from '@/components/contrib/provenance';
import { useRowMutation } from '@/components/contrib/use-row-mutation';
import {
  CitationMarks,
  CitationPicker,
  type CitationOption,
} from '@/components/contrib/citation-controls';
import type { ShowDetailRepertoire } from '@sdk/src/readModel/builders/shows.js';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { MusicNote03Icon } from '@/components/icons/generated';

const inputCls =
  'w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30';

export function RepertoireSection({
  corpsKey,
  season,
  scraped,
  overrides,
  citations,
}: {
  corpsKey: string;
  season: string;
  scraped: readonly ShowDetailRepertoire[];
  overrides: readonly OverrideRow[];
  citations: readonly CitationOption[];
}) {
  const { data: session } = useSession();
  const [rows, setRows] = useState(() => mergeRepertoire(scraped, overrides));
  const [editing, setEditing] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState<MergedRepertoireRow | null>(null);
  const signedIn = Boolean(session?.user);

  const replaceRow = (naturalKey: string, next: MergedRepertoireRow) =>
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
            <Icon icon={MusicNote03Icon} size="sm" />
            Repertoire
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
              Add work
            </button>
          ) : null}
        </div>

        <Show
          when={rows.length > 0}
          fallback={
            <div className="flex items-center gap-3 text-text-secondary">
              <p className="text-sm">
                No repertoire on file yet. Add the works, composers and arrangers.
              </p>
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
          <ul className="divide-y divide-foreground/10">
            <For each={rows}>
              {(piece) => (
                <li className="py-3 first:pt-0 last:pb-0">
                  {editing === piece.naturalKey ? (
                    <RepertoireEditor
                      row={piece}
                      citations={citations}
                      onCancel={() => setEditing(null)}
                      onSaved={(next) => {
                        replaceRow(piece.naturalKey, next);
                        setEditing(null);
                      }}
                      corpsKey={corpsKey}
                      season={season}
                    />
                  ) : (
                    <RepertoireRow
                      row={piece}
                      signedIn={signedIn}
                      citations={citations}
                      onEdit={() => setEditing(piece.naturalKey)}
                      onHidden={() => removeRow(piece.naturalKey)}
                      corpsKey={corpsKey}
                      season={season}
                    />
                  )}
                </li>
              )}
            </For>
          </ul>
        </Show>

        {editing === 'new' && newDraft ? (
          <div className="mt-4 border-t border-foreground/10 pt-4">
            <RepertoireEditor
              row={newDraft}
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
              corpsKey={corpsKey}
              season={season}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RepertoireRow({
  row,
  signedIn,
  corpsKey,
  season,
  onEdit,
  onHidden,
  citations,
}: {
  row: MergedRepertoireRow;
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
          pinnedKey: 'repertoire',
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
        <div className="min-w-0 flex-1">
          <div className="font-medium text-text-primary">
            <Show when={row.hyperlink} fallback={row.workTitle}>
              {(href) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
                >
                  {row.workTitle}
                </a>
              )}
            </Show>
            <CitationMarks citationIds={row.citationIds} citations={citations} />
          </div>
          <Show when={creditLine(row.composer, row.arranger)}>
            {(credit) => <p className="text-sm text-text-secondary">{credit}</p>}
          </Show>
          <Show when={row.notes || row.description}>
            {(text) => <p className="text-sm text-text-secondary">{text}</p>}
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

function RepertoireEditor({
  row,
  corpsKey,
  season,
  onCancel,
  onSaved,
  citations,
}: {
  row: MergedRepertoireRow;
  corpsKey: string;
  season: string;
  onCancel: () => void;
  onSaved: (row: MergedRepertoireRow) => void;
  citations: readonly CitationOption[];
}) {
  const [draft, setDraft] = useState<RepertoireRowInput>(row);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (
    key: keyof RepertoireRowInput,
    value: RepertoireRowInput[keyof RepertoireRowInput]
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const content = blankToEmpty(draft);
      const state = row.added ? 'added' : 'edited';
      const res = await saveShowOverride({
        data: {
          corpsKey,
          season,
          pinnedKey: 'repertoire',
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
        value={draft.workTitle}
        onChange={(e) => set('workTitle', e.target.value)}
        placeholder="Work title"
        className={inputCls}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          value={draft.composer ?? ''}
          onChange={(e) => set('composer', e.target.value)}
          placeholder="Composer"
          className={inputCls}
        />
        <input
          value={draft.arranger ?? ''}
          onChange={(e) => set('arranger', e.target.value)}
          placeholder="Arranger"
          className={inputCls}
        />
      </div>
      <input
        value={draft.hyperlink ?? ''}
        onChange={(e) => set('hyperlink', e.target.value)}
        placeholder="Source / listen URL"
        className={inputCls}
      />
      <textarea
        value={draft.notes ?? ''}
        onChange={(e) => set('notes', e.target.value)}
        placeholder="Notes"
        className={`min-h-20 ${inputCls}`}
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

const newRow = (index: number): MergedRepertoireRow => ({
  workTitle: '',
  composer: '',
  arranger: '',
  description: '',
  hyperlink: '',
  relatedCorpsKey: '',
  notes: '',
  citationIds: [],
  naturalKey: `fan-added#${index + 1}-${Date.now()}`,
  sourceHash: null,
  source: null,
  sourceAuthority: null,
  sourceUrl: null,
  scrapeDiverged: false,
  overrideUpdatedAt: null,
  overridden: false,
  added: true,
});

const blankToEmpty = (row: RepertoireRowInput): RepertoireRowInput => ({
  workTitle: row.workTitle.trim(),
  composer: row.composer?.trim() ?? '',
  arranger: row.arranger?.trim() ?? '',
  description: row.description?.trim() ?? '',
  hyperlink: row.hyperlink?.trim() ?? '',
  relatedCorpsKey: row.relatedCorpsKey?.trim() ?? '',
  notes: row.notes?.trim() ?? '',
  citationIds: row.citationIds ?? [],
});

const creditLine = (
  composer: string | null | undefined,
  arranger: string | null | undefined
): string => {
  const parts: string[] = [];
  if (composer) parts.push(`by ${composer}`);
  if (arranger) parts.push(`arr. ${arranger}`);
  return parts.join(' · ');
};
