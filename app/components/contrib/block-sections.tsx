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
import { LexicalFreeForm } from '@/components/contrib/lexical-free-form';
import { renderLexicalDoc } from '@/lib/contrib/lexical-render';
import { emptyFreeFormDoc, type FreeFormDoc } from '@/lib/contrib/free-form';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Icon, type IconComponent } from '@/components/icon';
import {
  CubeIcon,
  LinkSquare02Icon,
  Target02Icon,
  ViewIcon,
  BookOpen01Icon,
  AddCircleIcon,
  Cancel01Icon,
} from '@/components/icons/generated';

const str = (x: unknown) => (typeof x === 'string' ? x : '');

// A small inline row-remove button shared by the FieldArray editors.
const RemoveRowButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <Button type="button" variant="ghost" size="icon-sm" onClick={onClick} aria-label={label}>
    <Icon icon={Cancel01Icon} size="sm" />
  </Button>
);

// "+ Add …" affordance shared by the FieldArray editors.
const AddRowButton = ({ onClick, label }: { onClick: () => void; label: string }) => (
  <Button type="button" variant="ghost" size="xs" onClick={onClick}>
    <Icon icon={AddCircleIcon} size="sm" />
    {label}
  </Button>
);

/**
 * Shared chrome for an authored block (M3): title + icon, signed-in Edit/Add
 * toggle, signed-out sign-in CTA, the empty "calling out to contribute" state, and
 * the view/edit switch. The per-block view + Formisch editor are passed in.
 */
export function ContribBlock({
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
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing((e) => !e)}>
              {editing ? 'Cancel' : hasContent ? 'Edit' : 'Add'}
            </Button>
          ) : null}
        </div>

        {editing ? (
          edit(() => setEditing(false))
        ) : hasContent ? (
          view
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-text-secondary">
            <p className="text-sm">{emptyHint}</p>
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
        )}
      </CardContent>
    </Card>
  );
}

const SaveButton = ({ error }: { error: string | null }) => (
  <>
    {error ? <p className="text-sm text-destructive">{error}</p> : null}
    <Button type="submit" size="sm">
      Save
    </Button>
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
                <div className="flex-1 space-y-1.5">
                  <Field of={form} path={['items', i, 'name']}>
                    {(f) => (
                      <Input
                        placeholder="Prop name"
                        value={str(f.input)}
                        onChange={(e) => f.onChange(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field of={form} path={['items', i, 'description']}>
                    {(f) => (
                      <Input
                        placeholder="Description"
                        value={str(f.input)}
                        onChange={(e) => f.onChange(e.target.value)}
                      />
                    )}
                  </Field>
                </div>
                <RemoveRowButton
                  onClick={() => remove(form, { path: ['items'], at: i })}
                  label="Remove prop"
                />
              </div>
            ))}
            <AddRowButton
              onClick={() =>
                insert(form, { path: ['items'], initialInput: { name: '', description: '' } })
              }
              label="Add prop"
            />
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
                <div className="flex-1 space-y-1.5">
                  <Field of={form} path={['items', i, 'label']}>
                    {(f) => (
                      <Input
                        placeholder="Label (e.g. Show announcement)"
                        value={str(f.input)}
                        onChange={(e) => f.onChange(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field of={form} path={['items', i, 'url']}>
                    {(f) => (
                      <div>
                        <Input
                          placeholder="https://…"
                          value={str(f.input)}
                          onChange={(e) => f.onChange(e.target.value)}
                          aria-invalid={f.errors ? true : undefined}
                        />
                        {f.errors ? (
                          <p className="mt-1 text-xs text-destructive">{f.errors[0]}</p>
                        ) : null}
                      </div>
                    )}
                  </Field>
                </div>
                <RemoveRowButton
                  onClick={() => remove(form, { path: ['items'], at: i })}
                  label="Remove link"
                />
              </div>
            ))}
            <AddRowButton
              onClick={() =>
                insert(form, { path: ['items'], initialInput: { label: '', url: '' } })
              }
              label="Add link"
            />
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
          <Textarea
            placeholder="What is the show about? What do the moments / colors / staging mean?"
            value={str(f.input)}
            onChange={(e) => f.onChange(e.target.value)}
            className="min-h-32"
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
              aria-label="Remove photo"
              className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <Icon icon={Cancel01Icon} size="sm" />
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
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="button" size="sm" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save gallery'}
      </Button>
    </div>
  );
}

// ── The concept (free-form Lexical essay) ─────────────────────────────────────
export function AboutSection({ corpsKey, season, initial }: BlockProps<FreeFormDoc>) {
  const [value, setValue] = useState<FreeFormDoc | null>(initial);
  return (
    <ContribBlock
      icon={BookOpen01Icon}
      title="The concept"
      emptyHint="Tell the story of this show — the concept, the journey, what it all means."
      hasContent={Boolean(value?.plain?.trim())}
      view={renderLexicalDoc(value?.doc)}
      edit={(close) => (
        <AboutEditor
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

function AboutEditor({ corpsKey, season, value, onSaved }: EditorProps<FreeFormDoc>) {
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
      <LexicalFreeForm value={draft} onChange={setDraft} />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="button" size="sm" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
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
