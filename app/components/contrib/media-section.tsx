import { useState } from 'react';
import { saveShowBlock } from '@/lib/server-fns/contrib';
import type { MediaLinksInput } from '@/lib/contrib/schemas';
import type { ShowDetailMedia } from '@sdk/src/readModel/builders/shows.js';
import { ContribBlock } from '@/components/contrib/block-sections';
import { ProgressiveImage } from '@/components/progressive-image';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { ViewIcon, YoutubeIcon, AddCircleIcon, Cancel01Icon } from '@/components/icons/generated';

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

/**
 * Media wall (seedable authored block). Shows the scraped media until a
 * contributor edits; the editor pre-fills from the scrape (keeping thumbnails)
 * so people add clips/photos rather than retype.
 */
export function MediaSection({
  corpsKey,
  season,
  initial,
  scraped,
}: {
  corpsKey: string;
  season: string;
  initial: MediaLinksInput | null;
  scraped: ShowDetailMedia[];
}) {
  const [value, setValue] = useState<MediaLinksInput | null>(initial);
  const items: MediaLink[] =
    value?.items ??
    scraped.map((m) => ({
      url: m.url,
      title: m.title ?? '',
      mediaType: m.mediaType ?? '',
      thumbnailUrl: m.thumbnailUrl ?? '',
    }));

  return (
    <ContribBlock
      icon={ViewIcon}
      title="Media"
      emptyHint="Cover images, clips and photos are waiting to be contributed."
      hasContent={items.length > 0}
      view={
        <ul className="grid gap-3 sm:grid-cols-2">
          {items.map((m, i) => (
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
  const [items, setItems] = useState<MediaLink[]>(
    seed.length ? seed : [{ url: '', title: '', mediaType: '', thumbnailUrl: '' }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (i: number, patch: Partial<MediaLink>) =>
    setItems((xs) => xs.map((it, j) => (j === i ? { ...it, ...patch } : it)));

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
    <div className="space-y-2">
      {items.map((it, i) => (
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
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}
            aria-label="Remove media link"
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
          setItems((xs) => [...xs, { url: '', title: '', mediaType: '', thumbnailUrl: '' }])
        }
      >
        <Icon icon={AddCircleIcon} size="sm" />
        Add media link
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div>
        <Button type="button" size="sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save media'}
        </Button>
      </div>
    </div>
  );
}
