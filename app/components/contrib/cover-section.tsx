import { useState } from 'react';
import { useSession, signIn } from '@/lib/auth-client';
import { saveShowBlock } from '@/lib/server-fns/contrib';
import type { CoverInput } from '@/lib/contrib/schemas';
import { ImageDrop } from '@/components/contrib/image-drop';
import { ProgressiveImage } from '@/components/progressive-image';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { ViewIcon, Cancel01Icon } from '@/components/icons/generated';

type CoverImage = NonNullable<CoverInput['image']>;

/**
 * The show's cover image — a full-width hero above the page header. Signed-in
 * users upload one (kind='cover' → R2 → /api/show-media); when empty it shows an
 * inviting drop affordance to contributors and nothing to logged-out readers.
 */
export function CoverSection({
  corpsKey,
  season,
  initial,
}: {
  corpsKey: string;
  season: string;
  initial: CoverInput | null;
}) {
  const { data: session } = useSession();
  const [image, setImage] = useState<CoverImage | null>(initial?.image ?? null);
  const [editing, setEditing] = useState(false);
  const signedIn = Boolean(session?.user);

  if (image && !editing) {
    return (
      <div className="group relative overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <ProgressiveImage
          src={image.url}
          alt="Show cover"
          width={1200}
          fit="cover"
          className="aspect-[21/9] w-full"
        />
        {signedIn ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setEditing(true)}
            className="absolute right-2 top-2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
          >
            Edit cover
          </Button>
        ) : null}
      </div>
    );
  }

  // Empty + logged out → render nothing (no empty hero for readers).
  if (!image && !editing && !signedIn) return null;

  if (!editing) {
    // Empty + signed in → an inviting prompt.
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-foreground/15 py-8 text-sm text-text-secondary transition-colors hover:border-primary/50 hover:text-foreground"
      >
        <Icon icon={ViewIcon} size="lg" className="opacity-60" />
        <span>Add a cover image for this show</span>
      </button>
    );
  }

  return (
    <CoverEditor
      corpsKey={corpsKey}
      season={season}
      image={image}
      onSaved={(img) => {
        setImage(img);
        setEditing(false);
      }}
      onCancel={() => setEditing(false)}
    />
  );
}

function CoverEditor({
  corpsKey,
  season,
  image,
  onSaved,
  onCancel,
}: {
  corpsKey: string;
  season: string;
  image: CoverImage | null;
  onSaved: (img: CoverImage | null) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CoverImage | null>(image);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const content: CoverInput = draft ? { image: draft } : {};
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'cover', content } });
      onSaved(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border-2 border-dashed border-foreground/15 p-4">
      {draft ? (
        <div className="group relative overflow-hidden rounded-lg ring-1 ring-foreground/10">
          <ProgressiveImage
            src={draft.url}
            alt="Show cover"
            width={1200}
            fit="cover"
            className="aspect-[21/9] w-full"
          />
          <button
            type="button"
            onClick={() => setDraft(null)}
            aria-label="Remove cover"
            className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md bg-black/60 text-white hover:bg-black/80"
          >
            <Icon icon={Cancel01Icon} size="sm" />
          </button>
        </div>
      ) : (
        <ImageDrop
          corpsKey={corpsKey}
          season={season}
          kind="cover"
          onUploaded={(r) => setDraft({ url: r.url, alt: '', width: r.width, height: r.height })}
        />
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save cover'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
