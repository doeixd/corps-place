// Single favorite corps — persisted to localStorage, drives the site accent color.
// Only one corps can be favorited at a time; setting a new one replaces the old.
import { useSyncExternalStore } from 'react';
import { createStore } from '@xstate/store';
import { corpsPalette, hexToOklch } from '@sdk/src/corpsColors.js';
import type { CorpsBrandColors } from '@sdk/src/corpsColors.js';
import { themeStore } from './theme-store';

export const FAVORITE_STORAGE_KEY = 'corps-place-favorite-corps';

export interface FavoriteCorpsInput {
  corpsKey: string;
  name: string;
  slug: string | null;
  colorPrimary: string | null;
  colorSecondary: string | null;
}

/** Extracts the minimum fields needed for a favorite from a corps directory row. */
export function toFavoriteInput(corps: {
  corps_key: string;
  name: string;
  slug: string | null;
  color_primary: string | null;
  color_secondary: string | null;
}): FavoriteCorpsInput {
  return {
    corpsKey: corps.corps_key,
    name: corps.name,
    slug: corps.slug,
    colorPrimary: corps.color_primary,
    colorSecondary: corps.color_secondary,
  };
}

// Persisted shape — includes pre-computed light/dark palettes so the no-flash
// inline script can apply the accent before React mounts (no OKLCH math needed).
export interface PersistedFavorite {
  corpsKey: string;
  name: string;
  slug: string | null;
  colorPrimary: string | null;
  colorSecondary: string | null;
  lightPrimary: string;
  lightPrimaryForeground: string;
  darkPrimary: string;
  darkPrimaryForeground: string;
  /** Pre-computed --logo-dark for the no-flash script (corps secondary → oklch at L=0.17, C×0.3). */
  logoDark: string | null;
  addedAt: string;
}

function computePalettes(
  input: FavoriteCorpsInput
): Pick<
  PersistedFavorite,
  'lightPrimary' | 'lightPrimaryForeground' | 'darkPrimary' | 'darkPrimaryForeground' | 'logoDark'
> {
  const colors: Partial<CorpsBrandColors> = input.colorPrimary
    ? { primary: input.colorPrimary, secondary: input.colorSecondary }
    : {};
  const light = corpsPalette(colors, 'light');
  const dark = corpsPalette(colors, 'dark');
  // Pre-compute --logo-dark from the corps secondary color for the no-flash script.
  // L=0.17 keeps it legible as a dark structural fill; C×0.3 keeps it muted.
  let logoDark: string | null = null;
  if (input.colorSecondary) {
    const sec = hexToOklch(input.colorSecondary);
    if (sec) {
      logoDark = `oklch(0.17 ${+(sec.c * 0.3).toFixed(3)} ${+sec.h.toFixed(1)})`;
    }
  }
  return {
    lightPrimary: light.accent,
    lightPrimaryForeground: light.accentFg,
    darkPrimary: dark.accent,
    darkPrimaryForeground: dark.accentFg,
    logoDark,
  };
}

function toPersisted(input: FavoriteCorpsInput): PersistedFavorite {
  return {
    corpsKey: input.corpsKey,
    name: input.name,
    slug: input.slug,
    colorPrimary: input.colorPrimary,
    colorSecondary: input.colorSecondary,
    ...computePalettes(input),
    addedAt: new Date().toISOString(),
  };
}

function cleanFavorite(raw: unknown): PersistedFavorite | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.corpsKey !== 'string' || typeof r.name !== 'string') return null;
  // Recompute palettes from stored hex so any palette-format drift self-heals.
  return toPersisted({
    corpsKey: r.corpsKey,
    name: r.name,
    slug: typeof r.slug === 'string' ? r.slug : null,
    colorPrimary: typeof r.colorPrimary === 'string' ? r.colorPrimary : null,
    colorSecondary: typeof r.colorSecondary === 'string' ? r.colorSecondary : null,
  });
}

function persist(fav: PersistedFavorite | null): void {
  try {
    if (fav) {
      localStorage.setItem(FAVORITE_STORAGE_KEY, JSON.stringify(fav));
    } else {
      localStorage.removeItem(FAVORITE_STORAGE_KEY);
    }
  } catch {
    /* private mode / quota — favorite stays in-memory */
  }
}

// ── Apply accent colors to :root ────────────────────────────────────────────

export function applyFavoriteColors(fav: PersistedFavorite | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (fav) {
    const dark = root.classList.contains('dark');
    root.style.setProperty('--primary', dark ? fav.darkPrimary : fav.lightPrimary);
    root.style.setProperty(
      '--primary-foreground',
      dark ? fav.darkPrimaryForeground : fav.lightPrimaryForeground
    );
    if (fav.logoDark) {
      root.style.setProperty('--logo-dark', fav.logoDark);
    } else {
      root.style.removeProperty('--logo-dark');
    }
  } else {
    root.style.removeProperty('--primary');
    root.style.removeProperty('--primary-foreground');
    root.style.removeProperty('--logo-dark');
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

export const favoriteCorpsStore = createStore({
  context: { favorite: null as PersistedFavorite | null },
  on: {
    set: (_context, event: { input: FavoriteCorpsInput }) => ({
      favorite: toPersisted(event.input),
    }),
    clear: () => ({ favorite: null }),
    hydrate: (_context, event: { favorite: PersistedFavorite | null }) => ({
      favorite: event.favorite,
    }),
  },
});

// Persist + apply colors on every change.
favoriteCorpsStore.subscribe((snapshot) => {
  persist(snapshot.context.favorite);
  applyFavoriteColors(snapshot.context.favorite);
});

// Re-apply colors when the theme toggles (light ↔ dark palette swap).
themeStore.subscribe(() => {
  const fav = favoriteCorpsStore.getSnapshot().context.favorite;
  if (fav) applyFavoriteColors(fav);
});

// Hydrate from localStorage on module load (client only).
function hydrateFavorite(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(FAVORITE_STORAGE_KEY);
    const saved = raw ? cleanFavorite(JSON.parse(raw)) : null;
    favoriteCorpsStore.trigger.hydrate({ favorite: saved });
  } catch {
    /* ignore corrupt storage */
  }
}

if (typeof window !== 'undefined') hydrateFavorite();

// ── React hooks ──────────────────────────────────────────────────────────────

const SERVER_FAVORITE: PersistedFavorite | null = null;

const subscribeFavorite = (onChange: () => void) => {
  const sub = favoriteCorpsStore.subscribe(onChange);
  return () => sub.unsubscribe();
};

export function useFavoriteCorps(): PersistedFavorite | null {
  return useSyncExternalStore(
    subscribeFavorite,
    () => favoriteCorpsStore.getSnapshot().context.favorite,
    () => SERVER_FAVORITE
  );
}

export function useIsFavorite(corpsKey: string): boolean {
  const fav = useFavoriteCorps();
  return fav?.corpsKey === corpsKey;
}
