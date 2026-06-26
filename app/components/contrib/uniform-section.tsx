import { useState } from 'react';
import { useForm, Form, Field, FieldArray, insert, remove } from '@formisch/react';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowBlock } from '@/lib/server-fns/contrib';
import { UniformInputSchema, type UniformInput } from '@/lib/contrib/schemas';
import { ImageDrop } from '@/components/contrib/image-drop';
import { ProgressiveImage } from '@/components/progressive-image';
import { UniformCarousel } from '@/components/contrib/uniform-carousel';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { GiftIcon, AddCircleIcon, Cancel01Icon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';

type UniformSection = UniformInput['sections'][number];
type UniformImage = NonNullable<UniformSection['images']>[number];

const SECTION_LABELS = ['brass', 'percussion', 'guard'] as const;
const labelTitle = (l: string) => l.charAt(0).toUpperCase() + l.slice(1);

/**
 * Uniform block (M9b) — multi-section editor. A single `uniform` block holds a
 * `sections[]` array (brass/percussion/guard); each section has its own colors,
 * description, announcement link and photos. Signed-in users edit inline via a
 * tabbed Formisch form; the read view tabs between sections with a carousel.
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
    value != null &&
    value.sections.some(
      (s) =>
        s.colors.length > 0 ||
        s.description ||
        s.announcementUrl ||
        (s.images?.length ?? 0) > 0
    );

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
              Colors, photos, the about text and the reveal announcement — by section, waiting to be
              added.
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

// ── Section tab strip (shared by view + edit) ─────────────────────────────────
function SectionTabs({
  sections,
  active,
  onSelect,
}: {
  sections: { label: string }[];
  active: number;
  onSelect: (i: number) => void;
}) {
  if (sections.length <= 1) return null;
  return (
    <div className="mb-3 flex gap-1 border-b border-foreground/10">
      {sections.map((s, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onSelect(i)}
          className={cn(
            '-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors',
            i === active
              ? 'border-foreground text-foreground'
              : 'border-transparent text-text-secondary hover:text-foreground'
          )}
        >
          {labelTitle(s.label)}
        </button>
      ))}
    </div>
  );
}

function UniformView({ value }: { value: UniformInput }) {
  const [active, setActive] = useState(0);
  const section = value.sections[active] ?? value.sections[0];
  if (!section) return null;
  return (
    <div className="space-y-3">
      <SectionTabs sections={value.sections} active={active} onSelect={setActive} />
      {section.images && section.images.length > 0 ? (
        <UniformCarousel images={section.images} />
      ) : null}
      {section.colors.length > 0 ? (
        <div className="flex flex-wrap gap-3">
          {section.colors.map((c, i) => (
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
      {section.description ? (
        <p className="whitespace-pre-line text-sm text-text-secondary">{section.description}</p>
      ) : null}
      {section.announcementUrl ? (
        <a
          href={section.announcementUrl}
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

const EMPTY_SECTION: UniformSection = {
  label: 'brass',
  colors: [],
  description: '',
  announcementUrl: '',
  images: [],
};

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
  // output. Photos aren't typed form fields (uploaded async), so they ride
  // alongside in local state (per section) and merge into the saved content.
  const initialSections = value?.sections.length ? value.sections : [EMPTY_SECTION];
  const form = useForm({
    schema: UniformInputSchema,
    initialInput: { sections: initialSections },
  });
  const [active, setActive] = useState(0);
  const [imagesBySection, setImagesBySection] = useState<UniformImage[][]>(
    initialSections.map((s) => s.images ?? [])
  );
  const [error, setError] = useState<string | null>(null);

  const submit = async (content: UniformInput) => {
    setError(null);
    try {
      const merged: UniformInput = {
        sections: content.sections.map((s, i) => ({ ...s, images: imagesBySection[i] ?? [] })),
      };
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'uniform', content: merged } });
      onSaved(merged);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  return (
    <Form of={form} onSubmit={submit} className="space-y-3">
      <FieldArray of={form} path={['sections']}>
        {(arr) => {
          const idx = Math.min(active, arr.items.length - 1);
          return (
            <div className="space-y-3">
              {/* Section tabs */}
              <div className="flex flex-wrap items-center gap-1 border-b border-foreground/10 pb-1">
                {arr.items.map((id, i) => (
                  <Field key={id} of={form} path={['sections', i, 'label']}>
                    {(f) => (
                      <button
                        type="button"
                        onClick={() => setActive(i)}
                        className={cn(
                          '-mb-px border-b-2 px-3 py-1.5 text-sm font-medium transition-colors',
                          i === idx
                            ? 'border-foreground text-foreground'
                            : 'border-transparent text-text-secondary hover:text-foreground'
                        )}
                      >
                        {labelTitle(typeof f.input === 'string' ? f.input : 'brass')}
                      </button>
                    )}
                  </Field>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    insert(form, { path: ['sections'], initialInput: EMPTY_SECTION });
                    setImagesBySection((xs) => [...xs, []]);
                    setActive(arr.items.length);
                  }}
                >
                  <Icon icon={AddCircleIcon} size="sm" />
                  Add Section
                </Button>
              </div>

              {arr.items.map((id, i) =>
                i === idx ? (
                  <SectionEditor
                    key={id}
                    form={form}
                    index={i}
                    corpsKey={corpsKey}
                    season={season}
                    images={imagesBySection[i] ?? []}
                    setImages={(updater) =>
                      setImagesBySection((xs) =>
                        xs.map((imgs, j) => (j === i ? updater(imgs) : imgs))
                      )
                    }
                    canRemove={arr.items.length > 1}
                    onRemove={() => {
                      remove(form, { path: ['sections'], at: i });
                      setImagesBySection((xs) => xs.filter((_, j) => j !== i));
                      setActive((a) => Math.max(0, a >= i ? a - 1 : a));
                    }}
                  />
                ) : null
              )}
            </div>
          );
        }}
      </FieldArray>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" size="sm">
        Save
      </Button>
    </Form>
  );
}

function SectionEditor({
  form,
  index,
  corpsKey,
  season,
  images,
  setImages,
  canRemove,
  onRemove,
}: {
  // Formisch form instance; typed loosely to avoid leaking its internals here.
  form: ReturnType<typeof useForm<typeof UniformInputSchema>>;
  index: number;
  corpsKey: string;
  season: string;
  images: UniformImage[];
  setImages: (updater: (prev: UniformImage[]) => UniformImage[]) => void;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const i = index;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Field of={form} path={['sections', i, 'label']}>
          {(f) => (
            <select
              value={typeof f.input === 'string' ? f.input : 'brass'}
              onChange={(e) => f.onChange(e.target.value as (typeof SECTION_LABELS)[number])}
              className="rounded-md border border-foreground/15 bg-transparent px-2 py-1 text-sm"
            >
              {SECTION_LABELS.map((l) => (
                <option key={l} value={l}>
                  {labelTitle(l)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {canRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onRemove}
            aria-label="Remove section"
          >
            <Icon icon={Cancel01Icon} size="sm" />
            Remove section
          </Button>
        ) : null}
      </div>

      <FieldArray of={form} path={['sections', i, 'colors']}>
        {(arr) => (
          <div className="space-y-2">
            {arr.items.map((id, j) => (
              <div key={id} className="flex items-center gap-2">
                <Field of={form} path={['sections', i, 'colors', j, 'hex']}>
                  {(f) => (
                    <input
                      type="color"
                      value={typeof f.input === 'string' ? f.input : '#000000'}
                      onChange={(e) => f.onChange(e.target.value)}
                      className="size-8 rounded"
                    />
                  )}
                </Field>
                <Field of={form} path={['sections', i, 'colors', j, 'label']}>
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
                  onClick={() => remove(form, { path: ['sections', i, 'colors'], at: j })}
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
                insert(form, {
                  path: ['sections', i, 'colors'],
                  initialInput: { hex: '#000000', label: '' },
                })
              }
            >
              <Icon icon={AddCircleIcon} size="sm" />
              Add color
            </Button>
          </div>
        )}
      </FieldArray>

      <Field of={form} path={['sections', i, 'description']}>
        {(f) => (
          <Textarea
            placeholder="About this section's uniform…"
            value={typeof f.input === 'string' ? f.input : ''}
            onChange={(e) => f.onChange(e.target.value)}
            className="min-h-20"
          />
        )}
      </Field>
      <Field of={form} path={['sections', i, 'announcementUrl']}>
        {(f) => (
          <Input
            placeholder="Uniform announcement URL"
            value={typeof f.input === 'string' ? f.input : ''}
            onChange={(e) => f.onChange(e.target.value)}
          />
        )}
      </Field>

      {/* Section photos (uploaded → R2 → /api/show-media). */}
      <div className="space-y-2">
        {images.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {images.map((img, j) => (
              <div
                key={j}
                className="group relative aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10"
              >
                <ProgressiveImage src={img.url} alt={img.alt || ''} width={160} fit="cover" />
                <button
                  type="button"
                  onClick={() => setImages((xs) => xs.filter((_, k) => k !== j))}
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
    </div>
  );
}
