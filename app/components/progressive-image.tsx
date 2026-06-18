import { useState, type ReactNode } from 'react';
import { proxiedImage } from '@/lib/media';
import { cn } from '@/lib/utils';

/**
 * Progressive image using real <img> elements for both placeholder and final
 * artwork. The placeholder is removed after the full image loads so alpha in
 * transparent PNG/WebP logos does not reveal a fuzzy low-res copy underneath.
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
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const handleError = () => {
    setFailed(true);
    onError?.();
  };

  const proxyOpts = { assumeCached, width, dark };
  const resolved = src ? proxiedImage(src, proxyOpts) : null;

  // Thumbhash data URLs are inline placeholders, so they don't add another image
  // request. If the caller has no thumbhash, render only the final image.
  const placeholderUrl = thumbDataUrl ?? null;

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

  const resolvedSizes = sizes ?? `${Math.round(width)}px`;

  if (!resolved || failed) {
    return fallback ? <>{fallback}</> : null;
  }

  return (
    <div className={cn('relative overflow-hidden', className)}>
      {placeholderUrl ? (
        <img
          src={placeholderUrl}
          alt=""
          aria-hidden="true"
          loading={lazy ? 'lazy' : undefined}
          decoding="async"
          className={cn(
            'absolute inset-0 h-full w-full',
            fit === 'cover' ? 'object-cover' : 'object-contain',
            loaded && 'hidden'
          )}
        />
      ) : null}
      <img
        src={resolved}
        srcSet={srcSet || undefined}
        sizes={resolvedSizes}
        alt={alt}
        loading={lazy ? 'lazy' : undefined}
        {...(priority ? { fetchPriority: 'high' as const } : {})}
        decoding="async"
        onLoad={() => setLoaded(true)}
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
