import { useEffect, useState, type ReactNode } from 'react';
import { proxiedImage } from '@/lib/media';
import { cn } from '@/lib/utils';

// Module-level cache: when multiple ProgressiveImages share the same source URL
// (e.g. same corps logo in a table and a card on one page), only the first
// instance fetches the thumbhash; the rest reuse the cached data URL.
const thumbDataUrlCache = new Map<string, string | null>();

/** Images this small don't benefit from a thumbhash LQIP — skip the fetch. */
const MIN_WIDTH_FOR_THUMBHASH = 96;

/**
 * A progressive image that:
 * 1. Shows a thumbhash LQIP (decoded client-side, zero extra network requests)
 * 2. Falls back to a 32px blurred WebP during SSR / until the thumbhash arrives
 * 3. Fades in the full-resolution image once it decodes (opacity transition)
 *
 * Wraps the img in a relative container so LQIP sits behind it. The caller
 * controls sizing, rounding, and layout via `className` on the container.
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
  assumeCached = false,
  dark = false,
  thumbDataUrl,
  fallback,
  onError,
  className,
  imgClassName,
}: {
  /** Raw (un-proxied) image URL. If null/undefined, renders the fallback. */
  src: string | null | undefined;
  alt: string;
  /** Render width in CSS px — drives the media proxy's width-matched WebP. */
  width: number;
  /** Responsive srcSet widths (defaults to [width, width * 2]). */
  widths?: number[];
  /** sizes attribute for responsive images (e.g. "(min-width: 1024px) 28rem, 100vw"). */
  sizes?: string;
  /** object-fit value (default: "cover"). */
  fit?: 'cover' | 'contain';
  /** Add loading="lazy" (default true). Set false for above-the-fold images. */
  lazy?: boolean;
  /** Add fetchpriority="high" for LCP images. */
  priority?: boolean;
  /** Pass assumeCached:true to proxiedImage (used for SDK-pre-cached images). */
  assumeCached?: boolean;
  /** Pass dark:true to proxiedImage (luminance-inverted variant for dark-mode logos). */
  dark?: boolean;
  /** Pre-computed thumbhash data URL (data:image/png;base64,…). When provided,
   *  the placeholder renders instantly with zero network requests — even during
   *  SSR. Omit to fetch the thumbhash via the media proxy API on mount. */
  thumbDataUrl?: string | null;
  /** Called when the image fails to load. */
  onError?: () => void;
  /** Rendered when src is null or the image fails to load. */
  fallback?: ReactNode;
  /** Applied to the outer container div. */
  className?: string;
  /** Applied to the <img> element. */
  imgClassName?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fetchedThumbDataUrl, setFetchedThumbDataUrl] = useState<string | null>(null);

  const handleError = () => {
    setFailed(true);
    onError?.();
  };

  // Resolve proxied URLs.
  const proxyOpts = { assumeCached, width, dark };
  const resolved = src ? proxiedImage(src, proxyOpts) : null;
  // 32px WebP fallback — used during SSR or when no thumbDataUrl is available yet.
  // Skip for tiny images where the blur effect is imperceptible.
  const ssrPlaceholder =
    !thumbDataUrl && src && width > MIN_WIDTH_FOR_THUMBHASH
      ? proxiedImage(src, { assumeCached, width: 32, dark })
      : null;
  const wList = widths ?? [width, width * 2];
  const srcSet = resolved
    ? wList
        .map((w) => {
          const u = src ? proxiedImage(src, { assumeCached, width: w, dark }) : null;
          return u ? `${u} ${w}w` : null;
        })
        .filter(Boolean)
        .join(', ')
    : undefined;

  // When thumbDataUrl is provided as a prop, use it directly — zero network
  // requests, instant placeholder even during SSR. Also seed the module-level
  // cache so other instances with the same URL can skip the fetch.
  useEffect(() => {
    if (typeof thumbDataUrl === 'string') {
      if (src) thumbDataUrlCache.set(src, thumbDataUrl);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    setFailed(false);
    setFetchedThumbDataUrl(null);

    // Tiny images (logos, avatars) — the LQIP is imperceptible. Skip the
    // fetch and rely on the 32px WebP SSR fallback.
    if (!src || width <= MIN_WIDTH_FOR_THUMBHASH) return;

    // Module-level cache hit: another instance already fetched this URL.
    const cached = thumbDataUrlCache.get(src);
    if (cached !== undefined) {
      setFetchedThumbDataUrl(cached);
      return;
    }

    const thumbUrl = `/api/media?u=${encodeURIComponent(src)}&thumbhash=1`;
    fetch(thumbUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data: { thumbhash: string } | null) => {
        if (cancelled || !data?.thumbhash) return;
        const { thumbHashToDataURL } = await import('thumbhash');
        const hashBytes = Uint8Array.from(atob(data.thumbhash), (c) => c.charCodeAt(0));
        const dataUrl = thumbHashToDataURL(hashBytes);
        thumbDataUrlCache.set(src!, dataUrl);
        if (!cancelled) setFetchedThumbDataUrl(dataUrl);
      })
      .catch(() => {
        thumbDataUrlCache.set(src!, null); // don't retry failed fetches
      });

    return () => {
      cancelled = true;
    };
  }, [src, thumbDataUrl, width]);

  const effectiveThumbDataUrl = thumbDataUrl ?? fetchedThumbDataUrl;

  // Error / empty state.
  if (!resolved || failed) {
    return fallback ? <>{fallback}</> : null;
  }

  const showPlaceholder = effectiveThumbDataUrl || ssrPlaceholder;
  const placeholderBg =
    effectiveThumbDataUrl ?? (ssrPlaceholder ? `url(${ssrPlaceholder})` : undefined);
  const isThumbhash = !!effectiveThumbDataUrl;

  return (
    <div className={cn('relative overflow-hidden', className)}>
      {/* LQIP placeholder: thumbhash data URL (instant) or 32px blurred WebP (SSR fallback). */}
      {showPlaceholder ? (
        <div
          aria-hidden
          className="absolute inset-0 scale-110 bg-cover bg-center transition-opacity duration-500"
          style={{
            backgroundImage: placeholderBg,
            filter: isThumbhash ? undefined : 'blur(20px)',
            opacity: loaded ? 0 : 1,
          }}
        />
      ) : null}
      <img
        src={resolved}
        srcSet={srcSet || undefined}
        sizes={sizes || undefined}
        alt={alt}
        loading={lazy ? 'lazy' : undefined}
        {...(priority ? { fetchPriority: 'high' as const } : {})}
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={handleError}
        className={cn(
          'relative transition-opacity duration-500',
          fit === 'cover' ? 'object-cover' : 'object-contain',
          imgClassName
        )}
        style={{ opacity: loaded ? 1 : 0, width: '100%', height: '100%' }}
      />
    </div>
  );
}
