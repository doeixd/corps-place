import { Icon } from '@/components/icon';
import { HeartAddIcon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FavoriteCorpsInput } from '@/stores/favorite-corps-store';
import { favoriteCorpsStore, useIsFavorite } from '@/stores/favorite-corps-store';

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
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border',
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
          <span
            className={cn(
              'absolute inset-0 inline-flex items-center justify-center',
              isFav ? 'opacity-100' : 'opacity-0'
            )}
          >
            <Icon icon={FavouriteIcon} size={iconSize} />
          </span>
          <span className={cn('inline-flex', isFav ? 'opacity-0' : 'opacity-100')}>
            <Icon icon={HeartAddIcon} size={iconSize} />
          </span>
        </span>
        {showLabel ? <span>{isFav ? 'Favorited' : 'Favorite'}</span> : null}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
