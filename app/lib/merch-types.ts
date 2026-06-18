// Client-safe merch types + pure formatting. Deliberately free of DB/node
// imports so client components can import `formatPrice`. The Effect service (which
// touches the DB) lives in merch-directory.ts and must not be imported by the
// client bundle.

export type {
  MerchProductSummary,
  MerchProductDetail,
  MerchVariant,
  MerchStoreSummary,
  MerchFacets,
  CorpsMerchTeaser,
} from '@sdk/src/readModel/builders/merch.js';

import type { MerchProductSummary } from '@sdk/src/readModel/builders/merch.js';

/** A paginated slice of the catalog (shard shape === server-fn shape). */
export interface MerchCatalogPage {
  total: number;
  pageSize: number;
  pages: number;
  page: number;
  items: MerchProductSummary[];
}

/** The full catalog index in one payload (for client-side filtering). */
export interface MerchCatalog {
  total: number;
  items: MerchProductSummary[];
}

/** The corps logo fields a card needs (mirrors corpsLogoSource's input). */
export interface ShopLogoFields {
  corps_logo: string | null;
  corps_logo_dark: number | null;
  corps_logo_dark_url: string | null;
}

/** A group (corps/vendor store) card on the /shop landing. */
export interface ShopGroupCard {
  storeId: string;
  /** Human-readable storefront slug (corps slug, else slugified store_id). */
  slug: string;
  name: string;
  count: number;
  /** Corps logo fields (corps-linked groups). */
  logo: ShopLogoFields | null;
  /** Scraped + cached storefront logo URL (vendor groups without a corps logo). */
  storeLogo: string | null;
  sampleImage: string | null;
}

/** A category card on the /shop landing (uses a representative product image). */
export interface ShopCategoryCard {
  value: string;
  count: number;
  sampleImage: string | null;
}

/** Payload for the /shop landing page. */
export interface ShopHome {
  groups: ShopGroupCard[];
  categories: ShopCategoryCard[];
}

/** Payload for a single group storefront (/shop/group/$storeId). */
export interface ShopGroup {
  storeId: string;
  /** Human-readable storefront slug (corps slug, else slugified store_id). */
  slug: string;
  name: string;
  storeUrl: string;
  count: number;
  logo: ShopLogoFields | null;
  storeLogo: string | null;
  categories: { value: string; count: number }[];
  products: MerchProductSummary[];
}

/** Payload for a single category page (/shop/category/$cat). */
export interface ShopCategory {
  value: string;
  count: number;
  products: MerchProductSummary[];
}

/** Format a product's price (range-aware, currency-aware, never assumes USD). */
export function formatPrice(p: {
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
}): string {
  if (p.priceMin === null) return '—';
  const cur = p.currency ?? 'USD';
  const fmt = (n: number) => {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n);
    } catch {
      return `${cur} ${n.toFixed(2)}`;
    }
  };
  if (p.priceMax !== null && p.priceMax > p.priceMin)
    return `${fmt(p.priceMin)}–${fmt(p.priceMax)}`;
  return fmt(p.priceMin);
}

/**
 * Shape a product description for display. Storefront descriptions (esp. print-on-
 * demand) often pack the spec sheet into one blob with `•` markers or newlines —
 * we surface those as a real bullet list, with any leading sentence kept as an
 * intro paragraph. Prose without bullet markers is left as-is (single paragraph),
 * so we never turn normal sentences into spurious bullets.
 */
export function formatDescription(raw: string | null | undefined): {
  intro: string[];
  bullets: string[];
} {
  const text = (raw ?? '').trim();
  if (!text) return { intro: [], bullets: [] };

  const hasBullets = /[•●▪·]/.test(text) || /(^|\n)[ \t]*[-*][ \t]+/.test(text);
  if (!hasBullets) return { intro: [text], bullets: [] };

  const segments = text
    .replace(/[ \t]*[•●▪·][ \t]*/g, '\n') // inline bullet chars → line breaks
    .split(/\r?\n+/)
    .map((s) => s.replace(/^[ \t]*[-*][ \t]+/, '').trim()) // strip dash/asterisk markers
    .filter(Boolean);
  if (segments.length <= 1) return { intro: segments, bullets: [] };

  // A long, sentence-terminated lead reads as an intro; otherwise it's all a list.
  const [first, ...rest] = segments;
  const introIsSentence = /[.!?:]$/.test(first) && first.length > 50;
  return introIsSentence ? { intro: [first], bullets: rest } : { intro: [], bullets: segments };
}
