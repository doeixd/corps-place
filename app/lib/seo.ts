// Centralized SEO helpers. `buildSeo` returns TanStack Router `head()` meta +
// links (title, description, canonical, Open Graph, Twitter) from one call so
// every route stays consistent. Product-specific tags / JSON-LD are layered on
// top by the caller.

import { readBrand, BRAND_CONFIG } from './brand';

export const SITE_URL = 'https://drumcorps.app';
export const SITE_NAME = 'Drum Corps';
export const JOBS_URL = 'https://pageantryjobs.com';

// Canonical/OG URLs + site name must match the brand of the host being served, or
// pageantryjobs.com pages emit drumcorps.app canonicals (Google treats them as
// duplicates of the corps site). readBrand() is isomorphic (host on the server,
// window on the client) and only runs inside head(); fall back to corps if it
// can't resolve (no request context).
export const siteBase = (): { url: string; name: string } => {
  try {
    return readBrand() === 'jobs'
      ? { url: JOBS_URL, name: BRAND_CONFIG.jobs.name }
      : { url: SITE_URL, name: SITE_NAME };
  } catch {
    return { url: SITE_URL, name: SITE_NAME };
  }
};

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
  const { url: siteUrl, name: siteName } = siteBase();
  const url = path ? `${siteUrl}${path}` : undefined;
  // Brand-aware default social card for pages that don't set their own image, so
  // every share unfurls with a branded card (favicon + name).
  const ogImage =
    image ?? (siteUrl === SITE_URL ? `${SITE_URL}/api/og/home` : `${JOBS_URL}/api/og/jobs-home`);

  const meta: HeadMeta[] = [
    { title },
    { name: 'description', content: description },
    ...(noindex ? [{ name: 'robots', content: 'noindex' } as HeadMeta] : []),
    // Open Graph
    { property: 'og:type', content: type },
    { property: 'og:site_name', content: siteName },
    { property: 'og:title', content: title },
    { property: 'og:description', content: description },
    ...(url ? [{ property: 'og:url', content: url } as HeadMeta] : []),
    ...(ogImage ? [{ property: 'og:image', content: ogImage } as HeadMeta] : []),
    // Twitter
    { name: 'twitter:card', content: ogImage ? 'summary_large_image' : 'summary' },
    { name: 'twitter:title', content: title },
    { name: 'twitter:description', content: description },
    ...(ogImage ? [{ name: 'twitter:image', content: ogImage } as HeadMeta] : []),
  ];

  return { meta, links: url ? [{ rel: 'canonical', href: url }] : [] };
}

/** Clamp a free-text blob to a meta-description-friendly length. */
export function clampDescription(text: string | null | undefined, fallback: string): string {
  const clean = text?.replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

/** A `head()` script entry for a JSON-LD blob. */
export function jsonLdScript(obj: object): { type: string; children: string } {
  return { type: 'application/ld+json', children: JSON.stringify(obj) };
}

/** schema.org BreadcrumbList from a list of {name, path} (path is site-relative). */
export function breadcrumbLd(items: { name: string; path: string }[]): object {
  const { url: siteUrl } = siteBase();
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: `${siteUrl}${it.path}`,
    })),
  };
}

/** buildSeo + optional JSON-LD blobs → a complete TanStack `head()` object
 *  ({ meta, links, scripts }). Keeps each route's head() to one call. */
export function seoHead(input: SeoInput & { jsonLd?: (object | null | undefined)[] }): {
  meta: HeadMeta[];
  links: { rel: string; href: string }[];
  scripts?: { type: string; children: string }[];
} {
  const { jsonLd, ...seo } = input;
  const base = buildSeo(seo);
  const blobs = (jsonLd ?? []).filter((b): b is object => Boolean(b));
  return blobs.length ? { ...base, scripts: blobs.map(jsonLdScript) } : base;
}
