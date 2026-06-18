// Per-platform "open cart on the merchant site" URL builders (MERCH_PLAN §9).
// Groups cart items by store and builds the best possible handoff:
//   - prefill (Shopify/Woo/BigCommerce/Big Cartel): a cart URL with the items
//   - link: just the product page(s)
// Invariant #7: a prefill item missing the data its template needs degrades to a
// plain product link rather than producing a broken cart URL.
import type { CartItem } from '@/stores/cart-store';

export interface StoreGroup {
  storeId: string;
  storeName: string;
  items: CartItem[];
  /** A single pre-filled cart URL when the whole group supports it, else null. */
  cartUrl: string | null;
}

// Shopify's cart permalink: `${origin}/cart/{variantId}:{qty},…`. We only build
// it when EVERY item is a genuine Shopify-base entry WITH a variant — otherwise
// we'd silently drop variant-less items or mis-shape a non-Shopify URL. When this
// returns null the panel falls back to per-item product links (covers all items).
const SHOPIFY_CART_BASE = /\/cart\/$/;

const shopifyCartUrl = (items: CartItem[]): string | null => {
  const base = items[0]?.addToCartTemplate;
  if (!base || !SHOPIFY_CART_BASE.test(base)) return null;
  // Every item must share the same Shopify base and carry a variant, or we bail.
  const ok = items.every((i) => i.addToCartTemplate === base && i.variantId);
  if (!ok) return null;
  const parts = items.map((i) => `${i.variantId}:${i.qty}`);
  return `${base}${parts.join(',')}`;
};

/** Build per-store handoff groups from a flat cart. */
export function groupForHandoff(items: readonly CartItem[]): StoreGroup[] {
  const byStore = new Map<string, CartItem[]>();
  for (const i of items) {
    const list = byStore.get(i.storeId) ?? [];
    list.push(i);
    byStore.set(i.storeId, list);
  }

  return [...byStore.entries()].map(([storeId, group]) => {
    const storeName = group[0]!.storeName;
    // Shopify is the only platform whose multi-item permalink we build today;
    // every other case falls back to per-item product links (always valid).
    const cartUrl = shopifyCartUrl(group);
    return { storeId, storeName, items: group, cartUrl };
  });
}
