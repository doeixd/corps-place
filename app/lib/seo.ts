// Centralized SEO helpers. `buildSeo` returns TanStack Router `head()` meta +
// links (title, description, canonical, Open Graph, Twitter) from one call so
// every route stays consistent. Product-specific tags / JSON-LD are layered on
// top by the caller.

export const SITE_URL = 'https://drumcorps.app';
export const SITE_NAME = 'Drum Corps';

export interface SeoInput {
  title: string;
  description: string;
  /** Absolute path (e.g. `/shop/all`) → canonical + og:url. */
  path?: string;
  /** Absolute image URL for og:image / twitter:image. */
  image?: string;
  /** Open Graph object type. Defaults to `website`. */
  type?: 'website' | 'product' | 'article';
  /** When true, emit `robots: noindex` (e.g. personal/utility pages). */
  noindex?: boolean;
}

export interface HeadMeta {
  title?: string;
  name?: string;
  property?: string;
  content?: string;
}

export function buildSeo(input: SeoInput): {
  meta: HeadMeta[];
  links: { rel: string; href: string }[];
} {
  const { title, description, path, image, type = 'website', noindex } = input;
  const url = path ? `${SITE_URL}${path}` : undefined;

  const meta: HeadMeta[] = [
    { title },
    { name: 'description', content: description },
    ...(noindex ? [{ name: 'robots', content: 'noindex' } as HeadMeta] : []),
    // Open Graph
    { property: 'og:type', content: type },
    { property: 'og:site_name', content: SITE_NAME },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    ...(url ? [{ property: 'og:url', content: url } as HeadMeta] : []),
    ...(image ? [{ property: 'og:image', content: image } as HeadMeta] : []),
    // Twitter
    { name: 'twitter:card', content: image ? 'summary_large_image' : 'summary' },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    ...(image ? [{ name: 'twitter:image', content: image } as HeadMeta] : []),
  ];

  return { meta, links: url ? [{ rel: 'canonical', href: url }] : [] };
}

/** Clamp a free-text blob to a meta-description-friendly length. */
export function clampDescription(text: string | null | undefined, fallback: string): string {
  const clean = text?.replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}
