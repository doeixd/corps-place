import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { proxiedImage } from '@/lib/media';
import { cn } from '@/lib/utils';

/** Delay before the placeholder becomes visible, so fast (cached) images
 *  don't flash a fuzzy placeholder first. */
const PLACEHOLDER_DELAY_MS = 120;

// URLs that have fully loaded once this session. A remounted instance of an
// already-seen image (back-nav to a grid, gallery revisit) is a browser cache
// hit, but `onLoad` still fires later than the placeholder delay for lazy
// images (the request only starts at the intersection check) — so without this
// the thumbhash flashes on every mount. Known-loaded URLs start as `loaded`
// and never render the placeholder at all.
const loadedOnce = new Set<string>();

/**
 * Progressive image using real <img> elements for both placeholder and final
 * artwork. The placeholder is hidden for ~120ms — if the real image loads
 * within that window the user never sees it; otherwise it fades in so the
 * space doesn't sit empty. Removed after the full image loads so alpha in
 * transparent PNG/WebP logos doesn't reveal a fuzzy copy underneath.
 */
export function ProgressiveImage({
  src,
  alt,
  width,
  widths,
  sizes,
  fit = 'cover',
  lazy = true,
  priority = false,
  aspectRatio,
  assumeCached = false,
  dark = false,
  thumbDataUrl,
  fallback,
  onError,
  className,
  imgClassName,
}: {
  src: string | null | undefined;
  alt: string;
  width: number;
  widths?: number[];
  sizes?: string;
  fit?: 'cover' | 'contain';
  lazy?: boolean;
  /** LCP hint: sets fetchPriority=high AND forces eager loading (overrides `lazy`). */
  priority?: boolean;
  /**
   * Reserve space before the image loads (prevents layout shift): rendered as
   * `aspect-ratio` on the wrapper. Callers that size the wrapper via className
   * can omit it.
   */
  aspectRatio?: number | string;
  assumeCached?: boolean;
  dark?: boolean;
  thumbDataUrl?: string | null;
  onError?: () => void;
  fallback?: ReactNode;
  className?: string;
  imgClassName?: string;
}) {
  const resolvedForState = src ? proxiedImage(src, { assumeCached, width, dark }) : null;
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(() =>
    Boolean(resolvedForState && loadedOnce.has(resolvedForState))
  );
  const [showPlaceholder, setShowPlaceholder] = useState(false);

  // Keyed by the component's base resolved URL (not img.currentSrc, which may
  // be a different srcset width variant and would never match the mount check).
  const markLoaded = useCallback(() => {
    if (resolvedForState) loadedOnce.add(resolvedForState);
    setLoaded(true);
  }, [resolvedForState]);

  // Catch images that finished loading BEFORE hydration attached onLoad (SSR +
  // warm cache — the common repeat-visit case). Without this, `loaded` stays
  // false and the placeholder fades in behind an already-complete image, which
  // bleeds through transparent logos. A ref callback runs at attach time, so it
  // sees the browser's actual state instead of waiting for an event that
  // already fired.
  const imgRef = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete && img.naturalWidth > 0) markLoaded();
    },
    [markLoaded]
  );

  // Delay the placeholder so fast-loading images don't flash it.
  useEffect(() => {
    if (loaded || !thumbDataUrl) return;
    const t = setTimeout(() => setShowPlaceholder(true), PLACEHOLDER_DELAY_MS);
    return () => clearTimeout(t);
  }, [loaded, thumbDataUrl]);

  const handleError = () => {
    setFailed(true);
    onError?.();
  };

  const resolved = resolvedForState;

  // Thumbhash data URLs are inline placeholders, so they don't add another image
  // request. If the caller has no thumbhash, render only the final image.
  const placeholderUrl = thumbDataUrl ?? null;

  const wList = widths ?? [width, width * 2];
  const srcSet =
    resolved && src
      ? wList
          .map((w) => {
            const u = w === width ? resolved : proxiedImage(src, { assumeCached, width: w, dark });
            return u ? `${u} ${w}w` : null;
          })
          .filter(Boolean)
          .join(', ')
      : undefined;

  const resolvedSizes = sizes ?? `${Math.round(width)}px`;
  // priority is the LCP hint — a lazy LCP image is a contradiction (loading=lazy
  // wins over fetchPriority and delays the request), so priority forces eager.
  const eager = priority || !lazy;

  if (!resolved || failed) {
    return fallback ? <>{fallback}</> : null;
  }

  return (
    <div
      className={cn('relative overflow-hidden', className)}
      style={aspectRatio !== undefined ? { aspectRatio } : undefined}
    >
      {placeholderUrl ? (
        <img
          src={placeholderUrl}
          alt=""
          aria-hidden="true"
          decoding="async"
          className={cn(
            'absolute inset-0 h-full w-full transition-opacity duration-150',
            fit === 'cover' ? 'object-cover' : 'object-contain',
            loaded && 'hidden',
            showPlaceholder ? 'opacity-100' : 'opacity-0'
          )}
        />
      ) : null}
      <img
        ref={imgRef}
        src={resolved}
        srcSet={srcSet || undefined}
        sizes={resolvedSizes}
        alt={alt}
        loading={eager ? undefined : 'lazy'}
        {...(priority ? { fetchPriority: 'high' as const } : {})}
        decoding="async"
        onLoad={markLoaded}
        onError={handleError}
        className={cn(
          'relative',
          fit === 'cover' ? 'object-cover' : 'object-contain',
          imgClassName
        )}
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
