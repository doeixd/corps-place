import { useState } from 'react';
import { useForm, Form, Field, FieldArray, insert, remove } from '@formisch/react';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowBlock } from '@/lib/server-fns/contrib';
import { UniformInputSchema, type UniformInput } from '@/lib/contrib/schemas';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { GiftIcon } from '@/components/icons/generated';

const inputCls = 'w-full rounded border border-border bg-transparent px-2 py-1 text-sm';

/**
 * Uniform block (M3) — the first live wiki editor. Renders authored colors +
 * description + announcement link; signed-in users edit inline; signed-out users
 * get a sign-in CTA. Saves through the auth-gated `saveShowBlock` server-fn.
 */
export function UniformSection({
  corpsKey,
  season,
  initial,
}: {
  corpsKey: string;
  season: string;
  initial: UniformInput | null;
}) {
  const { data: session } = useSession();
  const [value, setValue] = useState<UniformInput | null>(initial);
  const [editing, setEditing] = useState(false);

  const signedIn = Boolean(session?.user);
  const hasContent =
    value && (value.colors.length > 0 || value.description || value.announcementUrl);

  return (
    <Card className={hasContent ? undefined : 'border-2 border-dashed border-foreground/15 ring-0'}>
      <CardContent className="py-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Icon icon={GiftIcon} size="sm" />
            Uniform
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
          <UniformEditor
            corpsKey={corpsKey}
            season={season}
            value={value}
            onSaved={(v) => {
              setValue(v);
              setEditing(false);
            }}
          />
        ) : hasContent ? (
          <UniformView value={value!} />
        ) : (
          <div className="flex items-center gap-3 text-text-secondary">
            <p className="text-sm">
              Colors, photos, the about text and the reveal announcement — waiting to be added.
            </p>
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

function UniformView({ value }: { value: UniformInput }) {
  return (
    <div className="space-y-3">
      {value.colors.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {value.colors.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className="size-6 rounded ring-1 ring-foreground/20"
                style={{ backgroundColor: c.hex }}
              />
              <span className="text-sm text-text-secondary">{c.label || c.hex}</span>
            </div>
          ))}
        </div>
      ) : null}
      {value.description ? (
        <p className="whitespace-pre-line text-sm text-text-secondary">{value.description}</p>
      ) : null}
      {value.announcementUrl ? (
        <a
          href={value.announcementUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm underline underline-offset-2"
        >
          Uniform announcement
        </a>
      ) : null}
    </div>
  );
}

function UniformEditor({
  corpsKey,
  season,
  value,
  onSaved,
}: {
  corpsKey: string;
  season: string;
  value: UniformInput | null;
  onSaved: (v: UniformInput) => void;
}) {
  // Formisch form driven by the shared Valibot schema; onSubmit gets validated output.
  const form = useForm({
    schema: UniformInputSchema,
    initialInput: value ?? { colors: [], description: '', announcementUrl: '' },
  });
  const [error, setError] = useState<string | null>(null);

  const submit = async (content: UniformInput) => {
    setError(null);
    try {
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'uniform', content } });
      onSaved(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  return (
    <Form of={form} onSubmit={submit} className="space-y-3">
      <FieldArray of={form} path={['colors']}>
        {(arr) => (
          <div className="space-y-2">
            {arr.items.map((id, i) => (
              <div key={id} className="flex items-center gap-2">
                <Field of={form} path={['colors', i, 'hex']}>
                  {(f) => (
                    <input
                      type="color"
                      value={typeof f.input === 'string' ? f.input : '#000000'}
                      onChange={(e) => f.onChange(e.target.value)}
                      className="size-8 rounded"
                    />
                  )}
                </Field>
                <Field of={form} path={['colors', i, 'label']}>
                  {(f) => (
                    <input
                      placeholder="label (e.g. Maroon)"
                      value={typeof f.input === 'string' ? f.input : ''}
                      onChange={(e) => f.onChange(e.target.value)}
                      className={`flex-1 ${inputCls}`}
                    />
                  )}
                </Field>
                <button
                  type="button"
                  onClick={() => remove(form, { path: ['colors'], at: i })}
                  className="text-text-secondary"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                insert(form, { path: ['colors'], initialInput: { hex: '#000000', label: '' } })
              }
              className="text-xs text-text-secondary underline underline-offset-2"
            >
              + Add color
            </button>
          </div>
        )}
      </FieldArray>

      <Field of={form} path={['description']}>
        {(f) => (
          <textarea
            placeholder="About the uniform…"
            value={typeof f.input === 'string' ? f.input : ''}
            onChange={(e) => f.onChange(e.target.value)}
            className={`min-h-20 ${inputCls}`}
          />
        )}
      </Field>
      <Field of={form} path={['announcementUrl']}>
        {(f) => (
          <input
            placeholder="Uniform announcement URL"
            value={typeof f.input === 'string' ? f.input : ''}
            onChange={(e) => f.onChange(e.target.value)}
            className={inputCls}
          />
        )}
      </Field>

      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      <button
        type="submit"
        className="rounded-md bg-primary px-4 py-1.5 text-sm text-primary-foreground"
      >
        Save
      </button>
    </Form>
  );
}
