import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { UniformInput } from '@/lib/contrib/schemas';
import { ProgressiveImage } from '@/components/progressive-image';
import { Icon } from '@/components/icon';
import { ArrowLeft01Icon, ArrowRight01Icon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';

type MediaItem = NonNullable<UniformInput['sections'][number]['images']>[number];

/**
 * Lightweight uniform image carousel (plan §3.5 / M9c). Shows one image at a time
 * with prev/next arrows + dot indicators; for 1–2 images it falls back to a static
 * grid (no carousel UX needed). Slide/fade via motion/react `AnimatePresence`.
 */
export function UniformCarousel({ images }: { images: MediaItem[] }) {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(0);

  if (images.length === 0) return null;

  // 1–2 images: a simple static grid reads better than a one-frame carousel.
  if (images.length <= 2) {
    return (
      <div className="grid grid-cols-2 gap-2">
        {images.map((img, i) => (
          <ProgressiveImage
            key={i}
            src={img.url}
            alt={img.alt || 'Uniform photo'}
            width={320}
            fit="cover"
            className="aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10"
          />
        ))}
      </div>
    );
  }

  const go = (delta: number) => {
    setDir(delta);
    setIndex((i) => (i + delta + images.length) % images.length);
  };
  const current = images[index];

  return (
    <div className="space-y-2">
      <div className="relative aspect-[4/3] overflow-hidden rounded-lg ring-1 ring-foreground/10">
        <AnimatePresence initial={false} custom={dir} mode="popLayout">
          <motion.div
            key={index}
            custom={dir}
            initial={{ opacity: 0, x: dir >= 0 ? 40 : -40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: dir >= 0 ? -40 : 40 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="absolute inset-0"
          >
            <ProgressiveImage
              src={current.url}
              alt={current.alt || 'Uniform photo'}
              width={640}
              fit="cover"
              className="size-full"
            />
          </motion.div>
        </AnimatePresence>

        <button
          type="button"
          onClick={() => go(-1)}
          aria-label="Previous photo"
          className="absolute left-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75"
        >
          <Icon icon={ArrowLeft01Icon} size="sm" />
        </button>
        <button
          type="button"
          onClick={() => go(1)}
          aria-label="Next photo"
          className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75"
        >
          <Icon icon={ArrowRight01Icon} size="sm" />
        </button>
      </div>

      <div className="flex items-center justify-center gap-1.5">
        {images.map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Go to photo ${i + 1}`}
            onClick={() => {
              setDir(i > index ? 1 : -1);
              setIndex(i);
            }}
            className={cn(
              'size-2 rounded-full transition-colors',
              i === index ? 'bg-foreground' : 'bg-foreground/25 hover:bg-foreground/40'
            )}
          />
        ))}
      </div>
    </div>
  );
}
