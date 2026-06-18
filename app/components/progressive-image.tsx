import { useState, type ReactNode } from 'react';
import { proxiedImage } from '@/lib/media';
import { cn } from '@/lib/utils';

/**
 * Zero-JS progressive image. The placeholder sits as a CSS background-image on
 * the container; the real <img> renders on top and naturally covers it on load.
 * No opacity toggling, no load-event tracking, no thumbhash fetch — the browser
 * just paints the image when it arrives.
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

  const handleError = () => {
    setFailed(true);
    onError?.();
  };

  const proxyOpts = { assumeCached, width, dark };
  const resolved = src ? proxiedImage(src, proxyOpts) : null;

  // Tiny proxy for the CSS background placeholder (browser upscale, no blur JS).
  const placeholderUrl =
    thumbDataUrl ??
    (src && width > 32 ? proxiedImage(src, { assumeCached, width: 32, dark }) : null);

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

  if (!resolved || failed) {
    return fallback ? <>{fallback}</> : null;
  }

  return (
    <div
      className={cn('relative overflow-hidden', className)}
      style={
        placeholderUrl
          ? {
              backgroundImage: `url(${placeholderUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }
          : undefined
      }
    >
      <img
        src={resolved}
        srcSet={srcSet || undefined}
        sizes={sizes || undefined}
        alt={alt}
        loading={lazy ? 'lazy' : undefined}
        {...(priority ? { fetchPriority: 'high' as const } : {})}
        decoding="async"
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
