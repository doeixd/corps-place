import { useState } from 'react';
import { saveShowBlock } from '@/lib/server-fns/contrib';
import type { MediaLinksInput, GalleryInput } from '@/lib/contrib/schemas';
import type { ShowDetailMedia } from '@sdk/src/readModel/builders/shows.js';
import { ContribBlock } from '@/components/contrib/block-sections';
import { ImageDrop } from '@/components/contrib/image-drop';
import { ProgressiveImage } from '@/components/progressive-image';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { ViewIcon, YoutubeIcon, AddCircleIcon, Cancel01Icon } from '@/components/icons/generated';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { parseVideo, type VideoEmbed } from '@/lib/video-embed';
import { fetchVideoMeta } from '@/lib/server-fns/video-meta';

type MediaLink = MediaLinksInput['items'][number];

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const isVideo = (m: MediaLink): boolean =>
  /youtube|youtu\.be|vimeo/i.test(m.url) || /video/i.test(m.mediaType ?? '');

/** A photo (uploaded image) vs. an external link/clip — drives grid vs. card layout. */
const isPhoto = (m: MediaLink): boolean =>
  /^image/i.test(m.mediaType ?? '') || /\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(m.url);

/** Legacy `gallery` photos as media items (mediaType=image), so the merged Media
 *  section still surfaces anything authored before gallery folded into media. */
const galleryAsMedia = (gallery: GalleryInput | null): MediaLink[] =>
  (gallery?.items ?? []).map((g) => ({
    url: g.url,
    title: g.alt ?? '',
    mediaType: 'image',
    thumbnailUrl: g.url,
  }));

/** Dedupe by URL, preserving first occurrence. */
const dedupe = (items: MediaLink[]): MediaLink[] => {
  const seen = new Set<string>();
  const out: MediaLink[] = [];
  for (const m of items) {
    if (m.url && !seen.has(m.url)) {
      seen.add(m.url);
      out.push(m);
    }
  }
  return out;
};

/**
 * Photos & video (seedable authored block). Merges the former Gallery (uploaded
 * photos) and Media (clips/links): shows the scraped media + any legacy gallery
 * photos until a contributor edits; the editor seeds from that so people add to
 * it rather than retype. Uploaded photos are stored as media items (mediaType
 * "image") — no schema change. The `gallery` photos migrate into the media block
 * on the next save.
 */
export function MediaSection({
  corpsKey,
  season,
  initial,
  scraped,
  gallery,
}: {
  corpsKey: string;
  season: string;
  initial: MediaLinksInput | null;
  scraped: ShowDetailMedia[];
  gallery: GalleryInput | null;
}) {
  const [value, setValue] = useState<MediaLinksInput | null>(initial);
  const base: MediaLink[] =
    value?.items ??
    scraped.map((m) => ({
      url: m.url,
      title: m.title ?? '',
      mediaType: m.mediaType ?? '',
      thumbnailUrl: m.thumbnailUrl ?? '',
    }));
  const items = dedupe([...base, ...galleryAsMedia(gallery)]);
  const photos = items.filter(isPhoto);
  const rest = items.filter((m) => !isPhoto(m));
  const videos = rest
    .map((m) => ({ m, v: parseVideo(m.url) }))
    .filter((x): x is { m: MediaLink; v: VideoEmbed } => x.v !== null);
  const links = rest.filter((m) => !parseVideo(m.url));
  const [active, setActive] = useState<{ embedUrl: string; title: string } | null>(null);
  const [photoIdx, setPhotoIdx] = useState<number | null>(null);
  const photo = photoIdx !== null ? photos[photoIdx] : null;
  const stepPhoto = (d: number) =>
    setPhotoIdx((i) => (i === null ? i : (i + d + photos.length) % photos.length));

  return (
    <>
    <ContribBlock
      icon={ViewIcon}
      title="Photos & video"
      emptyHint="Cover images, photos, and clips (YouTube, Vimeo) are waiting to be contributed."
      hasContent={items.length > 0}
      view={
        <div className="space-y-3">
          {photos.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {photos.map((m, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPhotoIdx(i)}
                  aria-label={`View ${m.title || 'photo'}`}
                  className="group block aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10"
                >
                  <ProgressiveImage
                    src={m.url}
                    alt={m.title || 'Show photo'}
                    width={240}
                    fit="cover"
                    className="size-full transition-transform duration-200 group-hover:scale-105"
                  />
                </button>
              ))}
            </div>
          ) : null}
          {videos.length > 0 ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {videos.map(({ m, v }, i) => {
                const thumb = v.thumbnailUrl ?? (m.thumbnailUrl || null);
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setActive({ embedUrl: v.embedUrl, title: m.title || 'Video' })}
                    aria-label={`Play ${m.title || 'video'}`}
                    className="group relative block aspect-video overflow-hidden rounded-lg ring-1 ring-foreground/10"
                  >
                    {thumb ? (
                      <ProgressiveImage
                        src={thumb}
                        alt={m.title || ''}
                        width={480}
                        fit="cover"
                        lazy
                        className="size-full"
                      />
                    ) : (
                      <span className="flex size-full items-center justify-center bg-muted">
                        <Icon icon={YoutubeIcon} size="lg" className="text-text-secondary" />
                      </span>
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/15 transition-colors group-hover:bg-black/30">
                      <span className="flex size-12 items-center justify-center rounded-full bg-black/60 text-white shadow-lg">
                        <svg viewBox="0 0 24 24" className="ml-0.5 size-6" fill="currentColor" aria-hidden>
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </span>
                    </span>
                    {m.title ? (
                      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-2 py-1 text-left text-xs text-white">
                        {m.title}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {links.length > 0 ? (
            <ul className="grid gap-3 sm:grid-cols-2">
              {links.map((m, i) => (
                <li key={i}>
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex gap-3 rounded-lg p-2 ring-1 ring-foreground/10 hover:bg-foreground/5"
                  >
                    <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
                      {m.thumbnailUrl ? (
                        <ProgressiveImage
                          src={m.thumbnailUrl}
                          alt=""
                          width={112}
                          fit="cover"
                          lazy
                          className="size-14"
                        />
                      ) : (
                        <Icon
                          icon={isVideo(m) ? YoutubeIcon : ViewIcon}
                          size="md"
                          className="text-text-secondary"
                        />
                      )}
                    </span>
                    <span className="min-w-0 self-center">
                      <span className="block truncate font-medium text-text-primary">
                        {m.title || m.mediaType || 'Media'}
                      </span>
                      <span className="block truncate text-xs text-text-secondary">
                        {hostOf(m.url)}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      }
      edit={(close) => (
        <MediaEditor
          corpsKey={corpsKey}
          season={season}
          seed={items}
          onSaved={(v) => {
            setValue(v);
            close();
          }}
        />
      )}
    />
      <Dialog
        open={!!active}
        onOpenChange={(o) => {
          if (!o) setActive(null);
        }}
      >
        <DialogContent className="max-w-3xl overflow-hidden p-0">
          <DialogTitle className="sr-only">{active?.title ?? 'Video'}</DialogTitle>
          {active ? (
            <div className="aspect-video w-full bg-black">
              <iframe
                src={`${active.embedUrl}?autoplay=1&rel=0`}
                title={active.title}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                className="size-full border-0"
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={photo !== null}
        onOpenChange={(o) => {
          if (!o) setPhotoIdx(null);
        }}
      >
        <DialogContent className="max-w-4xl overflow-hidden p-0">
          <DialogTitle className="sr-only">{photo?.title || 'Photo'}</DialogTitle>
          {photo ? (
            <div className="relative bg-black">
              <img
                src={photo.url}
                alt={photo.title || 'Show photo'}
                className="mx-auto max-h-[80vh] w-full object-contain"
              />
              {photo.title ? (
                <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-4 py-2 text-sm text-white">
                  {photo.title}
                </p>
              ) : null}
              {photos.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => stepPhoto(-1)}
                    aria-label="Previous photo"
                    className="absolute left-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-xl text-white hover:bg-black/70"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() => stepPhoto(1)}
                    aria-label="Next photo"
                    className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-xl text-white hover:bg-black/70"
                  >
                    ›
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function MediaEditor({
  corpsKey,
  season,
  seed,
  onSaved,
}: {
  corpsKey: string;
  season: string;
  seed: MediaLink[];
  onSaved: (v: MediaLinksInput) => void;
}) {
  const [items, setItems] = useState<MediaLink[]>(seed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<MediaLink>) =>
    setItems((xs) => xs.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const removeAt = (i: number) => setItems((xs) => xs.filter((_, j) => j !== i));

  // When a video link is pasted and has no title yet, auto-fill it from the
  // provider's oEmbed (YouTube/Vimeo). Best-effort; failures are ignored.
  const enrichVideo = (i: number, it: MediaLink) => {
    if (!it.url || it.title?.trim() || !parseVideo(it.url)) return;
    void fetchVideoMeta({ data: it.url }).then((meta) => {
      if (meta?.title) update(i, { title: meta.title, thumbnailUrl: meta.thumbnailUrl ?? '' });
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const content: MediaLinksInput = { items: items.filter((it) => it.url.trim()) };
      await saveShowBlock({ data: { corpsKey, season, pinnedKey: 'media', content } });
      onSaved(content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Uploaded photos */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-text-secondary">Photos</p>
        {items.some(isPhoto) ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {items.map((it, i) =>
              isPhoto(it) ? (
                <div
                  key={i}
                  className="group relative aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10"
                >
                  <ProgressiveImage src={it.url} alt={it.title || ''} width={160} fit="cover" />
                  <button
                    type="button"
                    onClick={() => removeAt(i)}
                    aria-label="Remove photo"
                    className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Icon icon={Cancel01Icon} size="sm" />
                  </button>
                </div>
              ) : null
            )}
          </div>
        ) : null}
        <ImageDrop
          corpsKey={corpsKey}
          season={season}
          kind="image"
          onUploaded={(r) =>
            setItems((xs) => [
              ...xs,
              { url: r.url, title: '', mediaType: 'image', thumbnailUrl: r.url },
            ])
          }
        />
      </div>

      {/* External clips / links */}
      <div className="space-y-2">
        <p className="text-sm font-medium text-text-secondary">Video &amp; links</p>
        {items.map((it, i) =>
          isPhoto(it) ? null : (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1 space-y-1.5">
                <Input
                  placeholder="Title (e.g. Finals performance)"
                  value={it.title ?? ''}
                  onChange={(e) => update(i, { title: e.target.value })}
                />
                <Input
                  placeholder="https://youtube.com/…"
                  value={it.url}
                  type="url"
                  inputMode="url"
                  onChange={(e) => update(i, { url: e.target.value })}
                  onBlur={() => enrichVideo(i, it)}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => removeAt(i)}
                aria-label="Remove media link"
              >
                <Icon icon={Cancel01Icon} size="sm" />
              </Button>
            </div>
          )
        )}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() =>
            setItems((xs) => [...xs, { url: '', title: '', mediaType: '', thumbnailUrl: '' }])
          }
        >
          <Icon icon={AddCircleIcon} size="sm" />
          Add video / link
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div>
        <Button type="button" size="sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
