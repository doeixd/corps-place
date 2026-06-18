import { Link } from '@tanstack/react-router';
import { ProgressiveImage } from '@/components/progressive-image';
import type { ShopCategoryCard as ShopCategoryCardData } from '@/lib/merch-types';
import { useThumbhash } from '@/hooks/use-thumbhash';

/**
 * A category card illustrated with a representative product image from that
 * category (per the chosen design). Falls back to a labelled gradient tile when a
 * category has no usable image, so the row never breaks.
 */
export function CategoryCard({ category }: { category: ShopCategoryCardData }) {
  const img = category.sampleImage;
  const thumb = useThumbhash(img);
  return (
    <Link
      to="/shop/category/$cat"
      params={{ cat: category.value }}
      className="card-hover group block h-full overflow-hidden rounded-xl border border-border"
    >
      <div className="relative aspect-square w-full bg-muted">
        {img ? (
          <>
            <ProgressiveImage
              src={img}
              alt={category.value}
              width={300}
              widths={[300, 600]}
              lazy
              fit="cover"
              thumbDataUrl={thumb}
              className="h-full w-full"
              imgClassName="transition-transform duration-200 group-hover:scale-[1.03]"
            />
            {/* A frosted-glass strip behind the label: blurs the photo directly
                behind the text so it stays legible over any product image. In
                light mode the strip is white with dark text; in dark mode it's
                a dark strip with white text. The gradient feathers the top edge. */}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-white via-white/92 via-55% to-transparent px-2.5 pb-2.5 pt-4 backdrop-blur-md [text-shadow:0_1px_2px_rgb(255_255_255/0.5)] dark:from-black dark:via-black/88 dark:via-55% dark:to-transparent dark:[text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">
              <div className="line-clamp-1 text-sm font-semibold text-black dark:text-white">
                {category.value}
              </div>
              <div className="text-xs text-black/70 dark:text-white/85">{category.count} items</div>
            </div>
          </>
        ) : (
          // No image: a dark brand tile so white text reads in both themes.
          <div className="relative flex h-full w-full items-center justify-center bg-gradient-to-tr from-primary/40 to-primary/15 p-3">
            <div className="absolute inset-0 bg-gradient-to-tr from-black/65 to-black/25" />
            <div className="relative text-center [text-shadow:0_1px_2px_rgb(0_0_0/0.3)] dark:[text-shadow:0_1px_3px_rgb(0_0_0/0.55)]">
              <div className="line-clamp-2 text-sm font-semibold text-white">{category.value}</div>
              <div className="text-xs text-white/85">{category.count} items</div>
            </div>
          </div>
        )}
      </div>
    </Link>
  );
}
