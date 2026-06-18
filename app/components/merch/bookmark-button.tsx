import { Icon } from '@/components/icon';
import { HeartAddIcon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { bookmarkStore, toBookmarkItem, useBookmarks } from '@/stores/bookmark-store';
import { cn } from '@/lib/utils';
import type { MerchProductSummary } from '@/lib/merch-types';
import { motion } from 'motion/react';

export function BookmarkButton({
  product,
  showLabel = false,
  className,
}: {
  product: MerchProductSummary;
  showLabel?: boolean;
  className?: string;
}) {
  const bookmarks = useBookmarks();
  const saved = bookmarks.some((item) => item.productId === product.productId);
  const label = saved ? 'Remove bookmark' : 'Bookmark product';

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={saved}
            onClick={() => {
              bookmarkStore.trigger.toggle({ item: toBookmarkItem(product) });
            }}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border transition-colors',
              showLabel ? 'px-3 py-2 text-sm font-medium' : 'size-8',
              saved
                ? 'border-primary/60 bg-primary/10 text-primary'
                : 'border-border text-text-secondary hover:border-primary/60 hover:text-primary',
              className
            )}
          />
        }
      >
        <span className="relative inline-flex">
          <motion.span
            animate={{ opacity: saved ? 1 : 0, scale: saved ? 1 : 0.3 }}
            transition={{ type: 'spring', stiffness: 600, damping: 16, mass: 0.5 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            <Icon icon={FavouriteIcon} size="sm" />
          </motion.span>
          <motion.span
            animate={{ opacity: saved ? 0 : 1, scale: saved ? 0.3 : 1 }}
            transition={{ type: 'spring', stiffness: 600, damping: 16, mass: 0.5 }}
            className="inline-flex"
          >
            <Icon icon={HeartAddIcon} size="sm" />
          </motion.span>
        </span>
        {showLabel ? <span>{saved ? 'Bookmarked' : 'Bookmark'}</span> : null}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
