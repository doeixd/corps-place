import { useState, type ReactNode } from 'react';
import { useForm, Form, Field, FieldArray, insert, remove } from '@formisch/react';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowBlock } from '@/lib/server-fns/contrib';
import {
  PropsInputSchema,
  LinksInputSchema,
  SymbolismInputSchema,
  type PropsInput,
  type LinksInput,
  type SymbolismInput,
  type GalleryInput,
} from '@/lib/contrib/schemas';
import { ImageDrop } from '@/components/contrib/image-drop';
import { ProgressiveImage } from '@/components/progressive-image';
import { LexicalFreeForm, type EditorCitation } from '@/components/contrib/lexical-free-form';
import { renderLexicalDoc, citationNumberMap } from '@/lib/contrib/lexical-render';
import { emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';
import { Card, CardContent } from '@/components/ui/card';
import { Icon, type IconComponent } from '@/components/icon';
import {
  CubeIcon,
  LinkSquare02Icon,
  Target02Icon,
  ViewIcon,
  BookOpen01Icon,
} from '@/components/icons/generated';

const inputCls = 'w-full rounded border border-border bg-transparent px-2 py-1 text-sm';
const str = (x: unknown) => (typeof x === 'string' ? x : '');

/**
 * Shared chrome for an authored block (M3): title + icon, signed-in Edit/Add
 * toggle, signed-out sign-in CTA, the empty "calling out to contribute" state, and
 * the view/edit switch. The per-block view + Formisch editor are passed in.
 */
function ContribBlock({
  icon,
  title,
  emptyHint,
  hasContent,
  view,
  edit,
}: {
  icon: IconComponent;
  title: string;
  emptyHint: string;
  hasContent: boolean;
  view: ReactNode;
  edit: (close: () => void) => ReactNode;
}) {
  const { data: session } = useSession();
  const [editing, setEditing] = useState(false);
  const signedIn = Boolean(session?.user);

  return (
    <Card className={hasContent ? undefined : 'border-2 border-dashed border-foreground/15 ring-0'}>
      <CardContent className="py-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Icon icon={icon} size="sm" />
            {title}
          </h2>
          {signedIn ? (
            <button
              type="button"
              onClick={() => setEditing((e) => !e)}
              className="text-xs text-text-secondary underline underline-offset-2 hover:text-foreground"
            >
              {editing ? 'Cancel' : hasContent ? 'Edit' : 'Add'}
            </button>
          ) : null}
        </div>

        {editing ? (
          edit(() => setEditing(false))
        ) : hasContent ? (
          view
        ) : (
          <div className="flex items-center gap-3 text-text-secondary">
            <p className="text-sm">{emptyHint}</p>
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
        )}
      </CardContent>
    </Card>
  );
}

const SaveButton = ({ error }: { error: string | null }) => (
  <>
    {error ? <p className="text-sm text-red-500">{error}</p> : null}
    <button
      type="submit"
      className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground"
    >
      Save
    </button>
  </>
);

// ── Props & staging ───────────────────────────────────────────────────────────
export function PropsSection({ corpsKey, season, initial }: BlockProps<PropsInput>) {
  const [value, setValue] = useState<PropsInput | null>(initial);
  return (
    <ContribBlock
      icon={CubeIcon}
      title="Props & staging"
      emptyHint="Photos and explanations of the props and staging are not here yet."
      hasContent={Boolean(value?.items.length)}
      view={
        <ul className="space-y-2">
          {value?.items.map((it, i) => (
            <li key={i}>
              <span className="font-medium text-text-primary">{it.name}</span>
              {it.description ? (
                <span className="text-sm text-text-secondary"> — {it.description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      }
      edit={(close) => (
        <PropsEditor
          corpsKey={corpsKey}
          season={season}
          value={value}
          onSaved={(v) => {
            setValue(v);
            close();
          }}
        />
      )}
    />
  );
}

function PropsEditor({ corpsKey, season, value, onSaved }: EditorProps<PropsInput>) {
  const form = useForm({ schema: PropsInputSchema, initialInput: value ?? { items: [] } });
  const [error, setError] = useState<string | null>(null);
  const submit = async (content: PropsInput) => {
    setError(null);
    try {
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'props', content } });
      onSaved(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };
  return (
    <Form of={form} onSubmit={submit} className="space-y-3">
      <FieldArray of={form} path={['items']}>
        {(arr) => (
          <div className="space-y-2">
            {arr.items.map((id, i) => (
              <div key={id} className="flex items-start gap-2">
                <div className="flex-1 space-y-1">
                  <Field of={form} path={['items', i, 'name']}>
                    {(f) => (
                      <input
                        placeholder="Prop name"
                        value={str(f.input)}
                        onChange={(e) => f.onChange(e.target.value)}
                        className={inputCls}
                      />
                    )}
                  </Field>
                  <Field of={form} path={['items', i, 'description']}>
                    {(f) => (
                      <input
                        placeholder="Description"
                        value={str(f.input)}
                        onChange={(e) => f.onChange(e.target.value)}
                        className={inputCls}
                      />
                    )}
                  </Field>
                </div>
                <button
                  type="button"
                  onClick={() => remove(form, { path: ['items'], at: i })}
                  className="text-text-secondary"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                insert(form, { path: ['items'], initialInput: { name: '', description: '' } })
              }
              className="text-xs text-text-secondary underline underline-offset-2"
            >
              + Add prop
            </button>
          </div>
        )}
      </FieldArray>
      <SaveButton error={error} />
    </Form>
  );
}

// ── Links & socials ───────────────────────────────────────────────────────────
export function LinksSection({ corpsKey, season, initial }: BlockProps<LinksInput>) {
  const [value, setValue] = useState<LinksInput | null>(initial);
  return (
    <ContribBlock
      icon={LinkSquare02Icon}
      title="Links & socials"
      emptyHint="Show announcement, listen-to links, Instagram / TikTok / YouTube — add them here."
      hasContent={Boolean(value?.items.length)}
      view={
        <ul className="flex flex-wrap gap-2">
          {value?.items.map((it, i) => (
            <li key={i}>
              <a
                href={it.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-primary/60 hover:text-foreground"
              >
                <Icon icon={LinkSquare02Icon} size="sm" />
                {it.label || new URL(it.url).host}
              </a>
            </li>
          ))}
        </ul>
      }
      edit={(close) => (
        <LinksEditor
          corpsKey={corpsKey}
          season={season}
          value={value}
          onSaved={(v) => {
            setValue(v);
            close();
          }}
        />
      )}
    />
  );
}

function LinksEditor({ corpsKey, season, value, onSaved }: EditorProps<LinksInput>) {
  const form = useForm({ schema: LinksInputSchema, initialInput: value ?? { items: [] } });
  const [error, setError] = useState<string | null>(null);
  const submit = async (content: LinksInput) => {
    setError(null);
    try {
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'links', content } });
      onSaved(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };
  return (
    <Form of={form} onSubmit={submit} className="space-y-3">
      <FieldArray of={form} path={['items']}>
        {(arr) => (
          <div className="space-y-2">
            {arr.items.map((id, i) => (
              <div key={id} className="flex items-start gap-2">
                <div className="flex-1 space-y-1">
                  <Field of={form} path={['items', i, 'label']}>
                    {(f) => (
                      <input
                        placeholder="Label (e.g. Show announcement)"
                        value={str(f.input)}
                        onChange={(e) => f.onChange(e.target.value)}
                        className={inputCls}
                      />
                    )}
                  </Field>
                  <Field of={form} path={['items', i, 'url']}>
                    {(f) => (
                      <div>
                        <input
                          placeholder="https://…"
                          value={str(f.input)}
                          onChange={(e) => f.onChange(e.target.value)}
                          className={inputCls}
                        />
                        {f.errors ? <p className="text-xs text-red-500">{f.errors[0]}</p> : null}
                      </div>
                    )}
                  </Field>
                </div>
                <button
                  type="button"
                  onClick={() => remove(form, { path: ['items'], at: i })}
                  className="text-text-secondary"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                insert(form, { path: ['items'], initialInput: { label: '', url: '' } })
              }
              className="text-xs text-text-secondary underline underline-offset-2"
            >
              + Add link
            </button>
          </div>
        )}
      </FieldArray>
      <SaveButton error={error} />
    </Form>
  );
}

// ── Concept & symbolism ─────────────────────────────────────────────────────
export function SymbolismSection({ corpsKey, season, initial }: BlockProps<SymbolismInput>) {
  const [value, setValue] = useState<SymbolismInput | null>(initial);
  return (
    <ContribBlock
      icon={Target02Icon}
      title="Concept & symbolism"
      emptyHint="What is this show about? Help explain the concept and its symbolism."
      hasContent={Boolean(value?.text?.trim())}
      view={<p className="whitespace-pre-line text-sm text-text-secondary">{value?.text}</p>}
      edit={(close) => (
        <SymbolismEditor
          corpsKey={corpsKey}
          season={season}
          value={value}
          onSaved={(v) => {
            setValue(v);
            close();
          }}
        />
      )}
    />
  );
}

function SymbolismEditor({ corpsKey, season, value, onSaved }: EditorProps<SymbolismInput>) {
  const form = useForm({ schema: SymbolismInputSchema, initialInput: value ?? { text: '' } });
  const [error, setError] = useState<string | null>(null);
  const submit = async (content: SymbolismInput) => {
    setError(null);
    try {
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'symbolism', content } });
      onSaved(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };
  return (
    <Form of={form} onSubmit={submit} className="space-y-3">
      <Field of={form} path={['text']}>
        {(f) => (
          <textarea
            placeholder="What is the show about? What do the moments / colors / staging mean?"
            value={str(f.input)}
            onChange={(e) => f.onChange(e.target.value)}
            className={`min-h-32 ${inputCls}`}
          />
        )}
      </Field>
      <SaveButton error={error} />
    </Form>
  );
}

// ── Photos & media gallery (uploads → R2 → ProgressiveImage) ──────────────────
export function GallerySection({ corpsKey, season, initial }: BlockProps<GalleryInput>) {
  const [value, setValue] = useState<GalleryInput | null>(initial);
  return (
    <ContribBlock
      icon={ViewIcon}
      title="Photos & media"
      emptyHint="Cover images, clips and photos are waiting to be contributed."
      hasContent={Boolean(value?.items.length)}
      view={
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {value?.items.map((it, i) => (
            <ProgressiveImage
              key={i}
              src={it.url}
              alt={it.alt || 'Show photo'}
              width={240}
              fit="cover"
              className="aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10"
            />
          ))}
        </div>
      }
      edit={(close) => (
        <GalleryEditor
          corpsKey={corpsKey}
          season={season}
          value={value}
          onSaved={(v) => {
            setValue(v);
            close();
          }}
        />
      )}
    />
  );
}

function GalleryEditor({ corpsKey, season, value, onSaved }: EditorProps<GalleryInput>) {
  const [items, setItems] = useState(value?.items ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const content: GalleryInput = { items };
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'gallery', content } });
      onSaved(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {items.map((it, i) => (
          <div
            key={i}
            className="group relative aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10"
          >
            <ProgressiveImage src={it.url} alt={it.alt || ''} width={160} fit="cover" />
            <button
              type="button"
              onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}
              className="absolute right-1 top-1 rounded bg-black/60 px-1.5 text-xs text-white"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <ImageDrop
        corpsKey={corpsKey}
        season={season}
        kind="image"
        onUploaded={(r) =>
          setItems((xs) => [...xs, { url: r.url, alt: '', width: r.width, height: r.height }])
        }
      />
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save gallery'}
      </button>
    </div>
  );
}

// ── The concept (free-form Lexical essay) ─────────────────────────────────────
export interface AboutCitation {
  citationId: string;
  title?: string | null;
  url?: string | null;
}

export function AboutSection({
  corpsKey,
  season,
  initial,
  citations = [],
}: BlockProps<FreeFormDoc> & { citations?: readonly AboutCitation[] }) {
  const [value, setValue] = useState<FreeFormDoc | null>(initial);
  const numbers = citationNumberMap(citations.map((c) => c.citationId));
  const editorCitations = citations.map((c) => ({
    citationId: c.citationId,
    label: `[${numbers[c.citationId]}] ${c.title || c.url || 'Source'}`,
  }));
  return (
    <ContribBlock
      icon={BookOpen01Icon}
      title="The concept"
      emptyHint="Tell the story of this show — the concept, the journey, what it all means."
      hasContent={Boolean(value?.plain?.trim())}
      view={renderLexicalDoc(value?.doc, numbers)}
      edit={(close) => (
        <AboutEditor
          corpsKey={corpsKey}
          season={season}
          value={value}
          citations={editorCitations}
          onSaved={(v) => {
            setValue(v);
            close();
          }}
        />
      )}
    />
  );
}

function AboutEditor({
  corpsKey,
  season,
  value,
  onSaved,
  citations = [],
}: EditorProps<FreeFormDoc> & { citations?: readonly EditorCitation[] }) {
  const [draft, setDraft] = useState<FreeFormDoc>(value ?? emptyFreeFormDoc('lexical'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'about', content: draft } });
      onSaved(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3">
      <LexicalFreeForm value={draft} onChange={setDraft} citations={citations} />
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

// ── shared prop types ─────────────────────────────────────────────────────────
interface BlockProps<T> {
  corpsKey: string;
  season: string;
  initial: T | null;
}
interface EditorProps<T> {
  corpsKey: string;
  season: string;
  value: T | null;
  onSaved: (v: T) => void;
}
