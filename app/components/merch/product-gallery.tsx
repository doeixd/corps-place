import { useRef, useState } from 'react';
import { Show } from 'jotai-solid-api';
import { ProgressiveImage } from '@/components/progressive-image';
import { Icon } from '@/components/icon';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@/components/icons/generated';
import { useThumbhash } from '@/hooks/use-thumbhash';

/** Single gallery slide — self-contained so it can own its thumbhash fetch. */
function GalleryImage({ src, alt, lazy }: { src: string; alt: string; lazy: boolean }) {
  const thumb = useThumbhash(src);
  return (
    <ProgressiveImage
      src={src}
      alt={alt}
      width={640}
      widths={[640, 1280]}
      lazy={lazy}
      fit="cover"
      thumbDataUrl={thumb}
      className="h-full w-full shrink-0 snap-center"
    />
  );
}

/**
 * Product image carousel for the detail page: a large active image with prev/next
 * controls and a thumbnail strip. Presentational + self-contained — holds only the
 * active index in local state (no effects). Falls back to a single image, or an
 * empty frame when a product has no imagery.
 */
export function ProductGallery({ images, alt }: { images: string[]; alt: string }) {
  const mainRef = useRef<HTMLDivElement>(null);
  const programmaticUntil = useRef(0);
  const [active, setActive] = useState(0);
  const valid = images.filter(Boolean);

  if (valid.length === 0) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-md bg-muted text-sm text-text-muted">
        No image
      </div>
    );
  }

  const i = Math.min(active, valid.length - 1);
  const hasMany = valid.length > 1;
  const scrollTo = (idx: number) => {
    setActive(idx);
    programmaticUntil.current = performance.now() + 700;
    mainRef.current?.scrollTo({
      left: idx * mainRef.current.clientWidth,
      behavior: 'smooth',
    });
  };
  const go = (delta: number) => scrollTo((i + delta + valid.length) % valid.length);
  const syncActiveFromScroll = () => {
    if (performance.now() < programmaticUntil.current) return;
    const el = mainRef.current;
    if (!el) return;
    const next = Math.round(el.scrollLeft / el.clientWidth);
    if (next !== i && next >= 0 && next < valid.length) setActive(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-md bg-muted">
        <div
          ref={mainRef}
          onScroll={syncActiveFromScroll}
          className="scrollbar-none flex h-full snap-x snap-mandatory overflow-x-auto scroll-smooth touch-pan-x"
        >
          {valid.map((src, idx) => (
            <GalleryImage
              key={`${src}-${idx}`}
              src={src}
              alt={idx === i ? alt : ''}
              lazy={idx !== 0}
            />
          ))}
        </div>
        <Show when={hasMany}>
          {/* Native title hints (not base-ui Tooltip) to keep the floating-ui
              positioning stack off the product page — these are one-word labels. */}
          <button
            type="button"
            aria-label="Previous image"
            title="Previous"
            onClick={() => go(-1)}
            className="absolute left-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 shadow hover:bg-background"
          >
            <Icon icon={ArrowLeft01Icon} size="md" className="size-[1.125rem]" />
          </button>
          <button
            type="button"
            aria-label="Next image"
            title="Next"
            onClick={() => go(1)}
            className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-background/80 shadow hover:bg-background"
          >
            <Icon icon={ArrowRight01Icon} size="md" className="size-[1.125rem]" />
          </button>
          <div className="absolute bottom-2 right-2 rounded-full bg-background/80 px-2 py-0.5 text-xs text-text-secondary">
            {i + 1} / {valid.length}
          </div>
        </Show>
      </div>

      <Show when={hasMany}>
        <div className="carousel-scrollbar flex gap-2 overflow-x-auto pb-1">
          {valid.map((src, idx) => (
            <button
              type="button"
              key={`${src}-${idx}`}
              aria-label={`View image ${idx + 1}`}
              onClick={() => scrollTo(idx)}
              className={`shrink-0 overflow-hidden rounded-md border ${
                idx === i ? 'border-primary ring-1 ring-primary' : 'border-border'
              }`}
            >
              <ProgressiveImage src={src} alt="" width={72} fit="cover" className="h-16 w-16" />
            </button>
          ))}
        </div>
      </Show>
    </div>
  );
}
