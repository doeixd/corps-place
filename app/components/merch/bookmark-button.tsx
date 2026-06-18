import { Icon } from '@/components/icon';
import { HeartAddIcon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { bookmarkStore, toBookmarkItem, useBookmarks } from '@/stores/bookmark-store';
import { cn } from '@/lib/utils';
import type { MerchProductSummary } from '@/lib/merch-types';
import { AnimatePresence, motion } from 'motion/react';

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
        <AnimatePresence mode="wait">
          <motion.span
            key={saved ? 'filled' : 'outline'}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 50, mass: 1 }}
            className="inline-flex"
          >
            <Icon icon={saved ? FavouriteIcon : HeartAddIcon} size="sm" />
          </motion.span>
        </AnimatePresence>
        {showLabel ? <span>{saved ? 'Bookmarked' : 'Bookmark'}</span> : null}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
