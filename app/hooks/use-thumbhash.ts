import { useState, useEffect, useRef } from 'react';

const cache = new Map<string, string | null>();

/**
 * Fetch a thumbhash data URL for an image. Results are cached across the
 * session so each URL is only fetched once. Returns null during SSR.
 */
export function useThumbhash(imageUrl: string | null | undefined): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(() =>
    imageUrl ? (cache.get(imageUrl) ?? null) : null
  );
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!imageUrl) return;

    const cached = cache.get(imageUrl);
    if (cached !== undefined) {
      setDataUrl(cached);
      return;
    }

    let cancelled = false;
    fetch(`/api/media?u=${encodeURIComponent(imageUrl)}&thumbhash=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then(async (data: { thumbhash: string } | null) => {
        if (cancelled || !data?.thumbhash) return;
        const { thumbHashToDataURL } = await import('thumbhash');
        const bytes = Uint8Array.from(atob(data.thumbhash), (c) => c.charCodeAt(0));
        const url = thumbHashToDataURL(bytes);
        cache.set(imageUrl!, url);
        if (!cancelled && mounted.current) setDataUrl(url);
      })
      .catch(() => {
        cache.set(imageUrl!, null);
      });

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  return dataUrl;
}
