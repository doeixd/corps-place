import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import { motion } from 'motion/react';
import { corpsPalette } from '@sdk/src/corpsColors.js';
import { Icon } from '@/components/icon';
import { HeartAddIcon } from '@/components/icons/generated';
import { FavouriteIcon } from '@/components/icons/favourite-filled';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { FavoriteCorpsInput } from '@/stores/favorite-corps-store';
import { favoriteCorpsStore, useIsFavorite } from '@/stores/favorite-corps-store';
import { themeStore } from '@/stores/theme-store';

const subscribeTheme = (onChange: () => void) => {
  const sub = themeStore.subscribe(onChange);
  return () => sub.unsubscribe();
};
const subscribeNoop = () => () => {};
const getThemeSnapshot = () => themeStore.getSnapshot().context.theme;
const getLightTheme = () => 'light' as const;

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

  // The corps accent is only needed when this card is favorited (snap to its
  // brand color) or once the user hovers (the hover-color preview). On a large
  // grid, deferring it means non-favorited, un-hovered cards do ZERO palette
  // work on mount — only the ≤1 favorited card computes anything up front.
  const [primed, setPrimed] = useState(false);
  const needAccent = isFav || primed;

  // React to theme toggles so the hover/fav color stays in sync with light/dark.
  const theme = useSyncExternalStore(
    needAccent ? subscribeTheme : subscribeNoop,
    needAccent ? getThemeSnapshot : getLightTheme,
    getLightTheme
  );

  // One single-mode palette (not the full light+dark+logo branding), computed
  // only for the favorite or cards the user has interacted with.
  const palette = needAccent ? computeButtonAccent(corps, theme) : null;

  const inlineFav =
    isFav && palette
      ? ({
          '--btn-accent': palette.accent,
          '--btn-accent-fg': palette.accentFg,
          borderColor: 'var(--btn-accent)',
          backgroundColor: 'color-mix(in oklch, var(--btn-accent), transparent 90%)',
          color: 'var(--btn-accent)',
        } as React.CSSProperties)
      : undefined;

  const hoverAccent =
    !isFav && palette ? ({ '--btn-hover': palette.accent } as React.CSSProperties) : undefined;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={isFav}
            // Compute the hover accent only once the user actually reaches for it.
            onPointerEnter={() => setPrimed(true)}
            onFocus={() => setPrimed(true)}
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
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border transition-colors',
              showLabel ? 'px-3 py-2 text-sm font-medium' : sizeTw,
              isFav
                ? 'border-(--btn-accent)/60 bg-(--btn-accent)/10 text-(--btn-accent)'
                : // Labelled variant reads as a proper button (resting border);
                  // the icon-only card variant stays a ghost heart.
                  cn(
                    showLabel
                      ? 'border-border text-text-secondary'
                      : 'border-transparent text-text-muted',
                    'hover:border-(--btn-hover)/40 hover:text-(--btn-hover)'
                  ),
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

/** Compute just the accent + accentFg for a corps in the *current* theme — a
 *  single `corpsPalette` derivation, not the full light+dark+logo branding the
 *  store persists. Pure (no DOM), so it's cheap and SSR-safe. */
function computeButtonAccent(
  corps: FavoriteCorpsInput,
  theme: string
): { accent: string; accentFg: string } {
  const colors = corps.colorPrimary
    ? { primary: corps.colorPrimary, secondary: corps.colorSecondary ?? undefined }
    : {};
  const p = corpsPalette(colors, theme === 'dark' ? 'dark' : 'light');
  return { accent: p.accent, accentFg: p.accentFg };
}
