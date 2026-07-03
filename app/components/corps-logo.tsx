import { useState } from 'react';
import { cn } from '@/lib/utils';
import { isDarkLogo } from '@/predicates/corps';
import { ProgressiveImage } from '@/components/progressive-image';

// Initials for the monogram fallback: first letters of the first two words.
const monogram = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

/**
 * The two theme-appropriate sources for a corps logo. A logo always has a base
 * (`light`) artwork; `dark` describes how it should look on a dark background:
 *  - a distinct URL — a hand-made dark-background asset, or
 *  - `'invert'` — auto-recolor the light artwork (for primarily dark/grey marks), or
 *  - `undefined` — the light artwork already works on dark; render one image.
 *
 * A bare string/null is shorthand for "same artwork on both themes".
 */
export type LogoSources = { light: string | null; dark?: string | 'invert' };
export type LogoSource = string | null | undefined | LogoSources;

type CorpsLike = {
  corps_logo?: string | null;
  corps_logo_dark?: number | null;
  /** Optional hand-made dark-background asset; overrides the auto-recolor. */
  corps_logo_dark_url?: string | null;
};

/**
 * Resolve a corps record to its light/dark logo sources. This is the single
 * place that decides the dark-background treatment — consumers just pass the
 * result to {@link CorpsLogo} and never reason about "dark logos" themselves.
 */
export function corpsLogoSource(corps: CorpsLike): LogoSource {
  const light = corps.corps_logo ?? null;
  if (corps.corps_logo_dark_url) return { light, dark: corps.corps_logo_dark_url };
  if (isDarkLogo(corps)) return { light, dark: 'invert' };
  return light; // same artwork on both themes
}

const normalizeSource = (logo: LogoSource): LogoSources =>
  typeof logo === 'object' && logo !== null ? logo : { light: logo ?? null, dark: undefined };

/**
 * A corps logo with a graceful fallback: renders the CDN logo when present (and
 * loadable), otherwise an initials monogram so every card stays uniform. Logos
 * are `object-contain` on a neutral tile since they vary in shape/background.
 *
 * When the logo has a distinct dark-background source (see {@link corpsLogoSource}),
 * both are rendered and swapped via the `.dark` class (committed pre-paint by the
 * no-FOUC script — SSR-safe, no flash, no theme JS).
 */
export function CorpsLogo({
  name,
  logo,
  className,
  width = 72,
  eager = false,
}: {
  name: string;
  /** A logo source: a plain URL, or `{ light, dark }` from {@link corpsLogoSource}. */
  logo: LogoSource;
  className?: string;
  /** Rendered tile width in CSS px; drives the resized variant + 2x srcset. */
  width?: number;
  /** Load immediately instead of lazily — for above-the-fold cards. */
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const { light, dark } = normalizeSource(logo);

  const darkUrl = dark === 'invert' ? light : (dark ?? null);
  const darkVariant = dark === 'invert';
  const hasDark = dark !== undefined && !!darkUrl && !failed;
  const showImg = !!light && !failed;

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-lg',
        showImg ? '' : 'bg-muted',
        className
      )}
    >
      {showImg ? (
        <>
          <ProgressiveImage
            src={light}
            alt={`${name} logo`}
            width={width}
            widths={[width, width * 2]}
            fit="contain"
            lazy={!eager}
            assumeCached
            fallback={null}
            onError={() => setFailed(true)}
            className={cn('h-full w-full', hasDark && 'dark:hidden')}
          />
          {hasDark ? (
            <ProgressiveImage
              src={darkUrl}
              alt={`${name} logo`}
              width={width}
              widths={[width, width * 2]}
              fit="contain"
              lazy={!eager}
              assumeCached
              dark={darkVariant}
              fallback={null}
              onError={() => setFailed(true)}
              className="hidden h-full w-full dark:block"
            />
          ) : null}
        </>
      ) : (
        <span className="text-sm font-semibold text-muted-foreground">{monogram(name)}</span>
      )}
    </div>
  );
}
