import { Icon } from '@/components/icon';
import { HeartAddIcon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FavoriteCorpsInput } from '@/stores/favorite-corps-store';
import { favoriteCorpsStore, useIsFavorite } from '@/stores/favorite-corps-store';
import { motion } from 'motion/react';

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
        <span className="relative inline-flex">
          <motion.span
            animate={{ opacity: isFav ? 1 : 0, scale: isFav ? 1 : 0.3 }}
            transition={{ type: 'spring', stiffness: 600, damping: 16, mass: 0.5 }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            <Icon icon={FavouriteIcon} size={iconSize} />
          </motion.span>
          <motion.span
            animate={{ opacity: isFav ? 0 : 1, scale: isFav ? 0.3 : 1 }}
            transition={{ type: 'spring', stiffness: 600, damping: 16, mass: 0.5 }}
            className="inline-flex"
          >
            <Icon icon={HeartAddIcon} size={iconSize} />
          </motion.span>
        </span>
        {showLabel ? <span>{isFav ? 'Favorited' : 'Favorite'}</span> : null}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
