// Client-only merch bookmarks, persisted to localStorage. This replaces the
// old save-for-later cart UI: bookmarks are just saved product cards.
import { useSyncExternalStore } from 'react';
import { createStore } from '@xstate/store';
import type { MerchProductSummary, ShopLogoFields } from '@/lib/merch-types';

export interface BookmarkItem extends MerchProductSummary {
  addedAt: string;
}

export const BOOKMARK_STORAGE_KEY = 'corps-place-merch-bookmarks';
const LEGACY_CART_STORAGE_KEY = 'corps-place-merch-cart';

export function toBookmarkItem(product: MerchProductSummary): BookmarkItem {
  // Pick only summary fields — `product` may be a MerchProductDetail, whose
  // description/images/variants would otherwise bloat localStorage.
  return {
    productId: product.productId,
    storeId: product.storeId,
    storeName: product.storeName,
    title: product.title,
    priceMin: product.priceMin,
    priceMax: product.priceMax,
    currency: product.currency,
    image: product.image,
    available: product.available,
    cartCapability: product.cartCapability,
    category: product.category,
    productUrl: product.productUrl,
    storeSlug: product.storeSlug,
    logo: product.logo,
    storeLogo: product.storeLogo,
    addedAt: new Date().toISOString(),
  };
}

const cleanLogo = (raw: unknown): ShopLogoFields | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.corps_logo !== 'string') return null;
  return {
    corps_logo: r.corps_logo,
    corps_logo_dark: typeof r.corps_logo_dark === 'number' ? r.corps_logo_dark : null,
    corps_logo_dark_url: typeof r.corps_logo_dark_url === 'string' ? r.corps_logo_dark_url : null,
  };
};

const cleanItems = (items: unknown): BookmarkItem[] => {
  if (!Array.isArray(items)) return [];
  const out: BookmarkItem[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const productId = typeof r.productId === 'string' ? r.productId : null;
    const title = typeof r.title === 'string' ? r.title : null;
    const productUrl = typeof r.productUrl === 'string' ? r.productUrl : null;
    const storeId = typeof r.storeId === 'string' ? r.storeId : null;
    const storeName = typeof r.storeName === 'string' ? r.storeName : '';
    if (!productId || !title || !productUrl || !storeId || seen.has(productId)) continue;
    seen.add(productId);
    out.push({
      productId,
      storeId,
      storeName,
      title,
      productUrl,
      image: typeof r.image === 'string' ? r.image : null,
      priceMin:
        typeof r.priceMin === 'number' ? r.priceMin : typeof r.price === 'number' ? r.price : null,
      priceMax:
        typeof r.priceMax === 'number' ? r.priceMax : typeof r.price === 'number' ? r.price : null,
      currency: typeof r.currency === 'string' ? r.currency : null,
      available: typeof r.available === 'boolean' ? r.available : null,
      cartCapability: r.cartCapability === 'prefill' ? 'prefill' : 'link',
      category: typeof r.category === 'string' ? r.category : null,
      storeSlug: typeof r.storeSlug === 'string' ? r.storeSlug : storeId,
      logo: cleanLogo(r.logo),
      storeLogo: typeof r.storeLogo === 'string' ? r.storeLogo : null,
      addedAt: typeof r.addedAt === 'string' ? r.addedAt : new Date().toISOString(),
    });
  }
  return out;
};

const persist = (items: BookmarkItem[]) => {
  try {
    localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* private mode / quota: bookmarks stay in-memory */
  }
};

export const bookmarkStore = createStore({
  context: { items: [] as BookmarkItem[] },
  on: {
    add: (context, event: { item: BookmarkItem }) => {
      const existing = context.items.some((i) => i.productId === event.item.productId);
      if (existing) return context;
      return { items: [event.item, ...context.items] };
    },
    remove: (context, event: { productId: string }) => ({
      items: context.items.filter((i) => i.productId !== event.productId),
    }),
    toggle: (context, event: { item: BookmarkItem }) => {
      const existing = context.items.some((i) => i.productId === event.item.productId);
      return existing
        ? { items: context.items.filter((i) => i.productId !== event.item.productId) }
        : { items: [event.item, ...context.items] };
    },
    clear: () => ({ items: [] as BookmarkItem[] }),
    hydrate: (_context, event: { items: BookmarkItem[] }) => ({ items: event.items }),
  },
});

bookmarkStore.subscribe((snapshot) => persist(snapshot.context.items));

function hydrateBookmarks(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(BOOKMARK_STORAGE_KEY);
    const saved = raw ? cleanItems(JSON.parse(raw)) : [];
    if (saved.length > 0) {
      bookmarkStore.trigger.hydrate({ items: saved });
      return;
    }

    const legacyRaw = localStorage.getItem(LEGACY_CART_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = cleanItems(JSON.parse(legacyRaw));
      if (legacy.length > 0) bookmarkStore.trigger.hydrate({ items: legacy });
      // One-time migration: drop the old cart key so it can't shadow future edits.
      localStorage.removeItem(LEGACY_CART_STORAGE_KEY);
    }
  } catch {
    /* ignore corrupt storage */
  }
}

if (typeof window !== 'undefined') hydrateBookmarks();

const SERVER_ITEMS: readonly BookmarkItem[] = [];

const subscribeBookmarks = (onChange: () => void) => {
  const sub = bookmarkStore.subscribe(onChange);
  return () => sub.unsubscribe();
};

export function useBookmarks(): readonly BookmarkItem[] {
  return useSyncExternalStore(
    subscribeBookmarks,
    () => bookmarkStore.getSnapshot().context.items,
    () => SERVER_ITEMS
  );
}
