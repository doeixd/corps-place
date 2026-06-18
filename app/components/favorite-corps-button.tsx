import { Icon } from '@/components/icon';
import { HeartAddIcon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FavoriteCorpsInput } from '@/stores/favorite-corps-store';
import { favoriteCorpsStore, useIsFavorite } from '@/stores/favorite-corps-store';
import { AnimatePresence, motion } from 'motion/react';

export function FavoriteCorpsButton({
  corps,
  size = 'md',
  showLabel = false,
  className,
}: {
  corps: FavoriteCorpsInput;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}) {
  const isFav = useIsFavorite(corps.corpsKey);
  const label = isFav ? `Remove ${corps.name} as favorite` : `Set ${corps.name} as favorite`;

  const sizeTw = size === 'sm' ? 'size-7' : size === 'lg' ? 'size-10' : 'size-8';
  const iconSize = size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'md';

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={isFav}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (isFav) {
                favoriteCorpsStore.trigger.clear();
              } else {
                favoriteCorpsStore.trigger.set({ input: corps });
              }
            }}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border transition-colors',
              showLabel ? 'px-3 py-2 text-sm font-medium' : sizeTw,
              isFav
                ? 'border-primary/60 bg-primary/10 text-primary'
                : 'border-transparent text-text-muted hover:border-primary/40 hover:text-primary',
              className
            )}
          />
        }
      >
        <AnimatePresence mode="wait">
          <motion.span
            key={isFav ? 'filled' : 'outline'}
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.5, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 50, mass: 1 }}
            className="inline-flex"
          >
            <Icon icon={isFav ? FavouriteIcon : HeartAddIcon} size={iconSize} />
          </motion.span>
        </AnimatePresence>
        {showLabel ? <span>{isFav ? 'Favorited' : 'Favorite'}</span> : null}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
