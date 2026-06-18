import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { proxiedImage } from '@/lib/media';
import { cn } from '@/lib/utils';

const thumbDataUrlCache = new Map<string, string | null>();
const MIN_WIDTH_FOR_THUMBHASH = 96;
/** Images that load within this many ms of mount skip the fade-in. */
const INSTANT_LOAD_MS = 150;

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
  src: string | null | undefined;
  alt: string;
  width: number;
  widths?: number[];
  sizes?: string;
  fit?: 'cover' | 'contain';
  lazy?: boolean;
  priority?: boolean;
  assumeCached?: boolean;
  dark?: boolean;
  thumbDataUrl?: string | null;
  onError?: () => void;
  fallback?: ReactNode;
  className?: string;
  imgClassName?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [instant, setInstant] = useState(false);
  const [fetchedThumbDataUrl, setFetchedThumbDataUrl] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const mountTime = useRef(0);
  if (mountTime.current === 0) {
    mountTime.current = performance.now();
  }

  const handleError = () => {
    setFailed(true);
    onError?.();
  };

  const proxyOpts = { assumeCached, width, dark };
  const resolved = src ? proxiedImage(src, proxyOpts) : null;
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

  // Detect browser-cached images and set mount time.
  // Resets loaded/instant when src changes to a non-cached image.
  useLayoutEffect(() => {
    mountTime.current = performance.now();
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0) {
      setLoaded(true);
      setInstant(true);
    } else {
      setLoaded(false);
      setInstant(false);
    }
  }, [src]);

  // Fetch thumbhash when no thumbDataUrl is provided.
  useLayoutEffect(() => {
    if (loaded) return;
    if (typeof thumbDataUrl === 'string') {
      if (src) thumbDataUrlCache.set(src, thumbDataUrl);
      return;
    }

    let cancelled = false;
    setFetchedThumbDataUrl(null);

    if (!src || width <= MIN_WIDTH_FOR_THUMBHASH) return;

    const cached = thumbDataUrlCache.get(src);
    if (cached !== undefined) {
      setFetchedThumbDataUrl(cached);
      return;
    }

    const thumbUrl = `/api/media?u=${encodeURIComponent(src)}&thumbhash=1`;
    fetch(thumbUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data: { thumbhash: string } | null) => {
        if (cancelled || !data?.thumbhash || loaded) return;
        const { thumbHashToDataURL } = await import('thumbhash');
        const hashBytes = Uint8Array.from(atob(data.thumbhash), (c) => c.charCodeAt(0));
        const dataUrl = thumbHashToDataURL(hashBytes);
        thumbDataUrlCache.set(src!, dataUrl);
        if (!cancelled) setFetchedThumbDataUrl(dataUrl);
      })
      .catch(() => {
        thumbDataUrlCache.set(src!, null);
      });

    return () => {
      cancelled = true;
    };
  }, [src, thumbDataUrl, width, loaded]);

  const effectiveThumbDataUrl = thumbDataUrl ?? fetchedThumbDataUrl;

  if (!resolved || failed) {
    return fallback ? <>{fallback}</> : null;
  }

  const showPlaceholder = !loaded && (effectiveThumbDataUrl || ssrPlaceholder);
  const placeholderBg =
    effectiveThumbDataUrl ?? (ssrPlaceholder ? `url(${ssrPlaceholder})` : undefined);
  const isThumbhash = !!effectiveThumbDataUrl;
  const fadeCls = instant ? '' : 'transition-opacity duration-150 ease-out';

  return (
    <div className={cn('relative overflow-hidden', className)}>
      {showPlaceholder ? (
        <div
          aria-hidden
          className="absolute inset-0 scale-110 bg-cover bg-center"
          style={{
            backgroundImage: placeholderBg,
            filter: isThumbhash ? undefined : 'blur(20px)',
          }}
        />
      ) : null}
      <img
        ref={imgRef}
        src={resolved}
        srcSet={srcSet || undefined}
        sizes={sizes || undefined}
        alt={alt}
        loading={lazy ? 'lazy' : undefined}
        {...(priority ? { fetchPriority: 'high' as const } : {})}
        decoding="async"
        onLoad={() => {
          const elapsed = performance.now() - mountTime.current;
          if (elapsed < INSTANT_LOAD_MS) setInstant(true);
          setLoaded(true);
        }}
        onError={handleError}
        className={cn(
          'relative',
          fadeCls,
          fit === 'cover' ? 'object-cover' : 'object-contain',
          imgClassName
        )}
        style={{ opacity: loaded ? 1 : 0, width: '100%', height: '100%' }}
      />
    </div>
  );
}
