import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import { motion } from 'motion/react';
import { Icon } from '@/components/icon';
import { HeartAddIcon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FavoriteCorpsInput } from '@/stores/favorite-corps-store';
import {
  favoriteCorpsStore,
  useIsFavorite,
  computeFavoriteBranding,
} from '@/stores/favorite-corps-store';
import { themeStore } from '@/stores/theme-store';

/**
 * Favorite (heart) button for a corps. When favorited, the button snaps
 * immediately to that corps's own brand color via inline styles — it does not
 * wait for the global --primary CSS transition on the shell/logo.
 * (FAVORITE_CORPS_BRANDING_PLAN §Switching Favorites).
 */
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

  // React to theme toggles so the hover/fav color stays in sync with light/dark.
  const theme = useSyncExternalStore(
    (onChange) => themeStore.subscribe(onChange).unsubscribe,
    () => themeStore.getSnapshot().context.theme,
    () => 'light'
  );

  // Compute the corps's own accent so we snap to it immediately on click
  // (bypassing the global --primary CSS transition on the shell/logo).
  const [palette, setPalette] = useState(() => computeButtonPalette(corps, theme));
  if (typeof window !== 'undefined') {
    const next = computeButtonPalette(corps, theme);
    if (next.accent !== palette.accent || next.accentFg !== palette.accentFg) {
      setPalette(next);
    }
  }

  const inlineFav = isFav
    ? ({
        '--btn-accent': palette.accent,
        '--btn-accent-fg': palette.accentFg,
        borderColor: 'var(--btn-accent)',
        backgroundColor: 'color-mix(in oklch, var(--btn-accent), transparent 90%)',
        color: 'var(--btn-accent)',
      } as React.CSSProperties)
    : undefined;

  const hoverAccent = isFav
    ? undefined
    : ({
        '--btn-hover': palette.accent,
      } as React.CSSProperties);

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
            style={{ ...inlineFav, ...hoverAccent }}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border',
              showLabel ? 'px-3 py-2 text-sm font-medium' : sizeTw,
              isFav
                ? 'border-(--btn-accent)/60 bg-(--btn-accent)/10 text-(--btn-accent)'
                : 'border-transparent text-text-muted hover:border-(--btn-hover)/40 hover:text-(--btn-hover)',
              className
            )}
          />
        }
      >
        <span className="relative inline-flex">
          <motion.span
            animate={{ opacity: isFav ? 1 : 0, scale: isFav ? 1 : 0.3 }}
            transition={{
              scale: { type: 'spring', stiffness: 600, damping: 16, mass: 0.5 },
              opacity: { duration: 0.15, ease: 'easeOut' },
            }}
            className="absolute inset-0 inline-flex items-center justify-center"
          >
            <Icon icon={FavouriteIcon} size={iconSize} />
          </motion.span>
          <motion.span
            animate={{ opacity: isFav ? 0 : 1, scale: isFav ? 0.3 : 1 }}
            transition={{
              scale: { type: 'spring', stiffness: 600, damping: 16, mass: 0.5 },
              opacity: { duration: 0.15, ease: 'easeOut' },
            }}
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

/** Compute the accent + accentFg for a corps in the current theme, using the
 *  shared palette derivation so it matches what the store would set on :root. */
function computeButtonPalette(
  corps: FavoriteCorpsInput,
  theme: string
): { accent: string; accentFg: string } {
  if (typeof document === 'undefined') return { accent: '#fd5007', accentFg: '#fff' };
  const branding = computeFavoriteBranding(corps);
  const dark = theme === 'dark';
  return {
    accent: dark ? branding.darkPrimary : branding.lightPrimary,
    accentFg: dark ? branding.darkPrimaryForeground : branding.lightPrimaryForeground,
  };
}
