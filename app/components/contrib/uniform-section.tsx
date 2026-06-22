import { useState } from 'react';
import { useForm, Form, Field, FieldArray, insert, remove } from '@formisch/react';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowBlock } from '@/lib/server-fns/contrib';
import { UniformInputSchema, type UniformInput } from '@/lib/contrib/schemas';
import { ImageDrop } from '@/components/contrib/image-drop';
import { ProgressiveImage } from '@/components/progressive-image';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { GiftIcon, AddCircleIcon, Cancel01Icon } from '@/components/icons/generated';

type UniformImage = NonNullable<UniformInput['images']>[number];

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
    value &&
    (value.colors.length > 0 ||
      value.description ||
      value.announcementUrl ||
      (value.images?.length ?? 0) > 0);

  return (
    <Card className={hasContent ? undefined : 'border-2 border-dashed border-foreground/15 ring-0'}>
      <CardContent className="py-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-text-secondary">
            <Icon icon={GiftIcon} size="sm" />
            Uniform
          </h2>
          {signedIn ? (
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing((e) => !e)}>
              {editing ? 'Cancel' : hasContent ? 'Edit' : 'Add'}
            </Button>
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

function UniformView({ value }: { value: UniformInput }) {
  return (
    <div className="space-y-3">
      {value.images && value.images.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {value.images.map((img, i) => (
            <ProgressiveImage
              key={i}
              src={img.url}
              alt={img.alt || 'Uniform photo'}
              width={240}
              fit="cover"
              className="aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10"
            />
          ))}
        </div>
      ) : null}
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
  // Formisch form driven by the shared Valibot schema; onSubmit gets validated
  // output. Photos aren't a typed form field (they're uploaded async), so they
  // ride alongside in local state and merge into the saved content — mirroring
  // GalleryEditor.
  const form = useForm({
    schema: UniformInputSchema,
    initialInput: value ?? { colors: [], description: '', announcementUrl: '', images: [] },
  });
  const [images, setImages] = useState<UniformImage[]>(value?.images ?? []);
  const [error, setError] = useState<string | null>(null);

  const submit = async (content: UniformInput) => {
    setError(null);
    try {
      const merged = { ...content, images };
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'uniform', content: merged } });
      onSaved(merged);
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
                    <Input
                      placeholder="label (e.g. Maroon)"
                      value={typeof f.input === 'string' ? f.input : ''}
                      onChange={(e) => f.onChange(e.target.value)}
                      className="flex-1"
                    />
                  )}
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => remove(form, { path: ['colors'], at: i })}
                  aria-label="Remove color"
                >
                  <Icon icon={Cancel01Icon} size="sm" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() =>
                insert(form, { path: ['colors'], initialInput: { hex: '#000000', label: '' } })
              }
            >
              <Icon icon={AddCircleIcon} size="sm" />
              Add color
            </Button>
          </div>
        )}
      </FieldArray>

      <Field of={form} path={['description']}>
        {(f) => (
          <Textarea
            placeholder="About the uniform…"
            value={typeof f.input === 'string' ? f.input : ''}
            onChange={(e) => f.onChange(e.target.value)}
            className="min-h-20"
          />
        )}
      </Field>
      <Field of={form} path={['announcementUrl']}>
        {(f) => (
          <Input
            placeholder="Uniform announcement URL"
            value={typeof f.input === 'string' ? f.input : ''}
            onChange={(e) => f.onChange(e.target.value)}
          />
        )}
      </Field>

      {/* Uniform photos (uploaded → R2 → /api/show-media). */}
      <div className="space-y-2">
        {images.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((img, i) => (
              <div
                key={i}
                className="group relative aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10"
              >
                <ProgressiveImage src={img.url} alt={img.alt || ''} width={160} fit="cover" />
                <button
                  type="button"
                  onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))}
                  aria-label="Remove photo"
                  className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Icon icon={Cancel01Icon} size="sm" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <ImageDrop
          corpsKey={corpsKey}
          season={season}
          kind="uniform"
          onUploaded={(r) =>
            setImages((xs) => [...xs, { url: r.url, alt: '', width: r.width, height: r.height }])
          }
        />
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" size="sm">
        Save
      </Button>
    </Form>
  );
}
