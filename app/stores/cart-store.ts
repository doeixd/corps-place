// Save-for-later cart (MERCH_PLAN §8). Client-only, persisted to localStorage.
// We never check out here — the cart links out to each merchant (see
// @/lib/merch-cart-links + open-on-sites-panel).
//
// Read it with useCartItems() — a useSyncExternalStore hook whose getServerSnapshot
// returns a stable empty list, so SSR and the first client (hydration) render agree
// and React swaps in the hydrated items right after, with NO useEffect.
import { useSyncExternalStore } from 'react';
import { createStore } from '@xstate/store';

export interface CartItem {
  productId: string;
  storeId: string;
  storeName: string;
  title: string;
  productUrl: string;
  image: string | null;
  price: number | null;
  currency: string | null;
  variantId: string | null;
  variantTitle: string | null;
  qty: number;
  cartCapability: 'prefill' | 'link';
  addToCartTemplate: string | null;
}

export const CART_STORAGE_KEY = 'corps-place-merch-cart';

interface ProductLike {
  productId: string;
  storeId: string;
  storeName: string;
  title: string;
  productUrl: string;
  image: string | null;
  priceMin: number | null;
  currency: string | null;
  cartCapability: 'prefill' | 'link';
  addToCartTemplate?: string | null;
}

/** Build a CartItem from a catalog summary or product detail (+ optional variant). */
export function toCartItem(
  p: ProductLike,
  variant?: { id: string; title: string; price: number | null } | null
): CartItem {
  return {
    productId: p.productId,
    storeId: p.storeId,
    storeName: p.storeName,
    title: p.title,
    productUrl: p.productUrl,
    image: p.image,
    price: variant?.price ?? p.priceMin,
    currency: p.currency,
    variantId: variant?.id ?? null,
    variantTitle: variant?.title ?? null,
    qty: 1,
    cartCapability: p.cartCapability,
    addToCartTemplate: p.addToCartTemplate ?? null,
  };
}

const persist = (items: CartItem[]) => {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* private mode / quota — cart stays in-memory */
  }
};

export const cartStore = createStore({
  context: { items: [] as CartItem[] },
  on: {
    add: (context, event: { item: CartItem }) => {
      // Merge by product+variant: bump qty instead of duplicating.
      const key = (i: CartItem) => `${i.productId}|${i.variantId ?? ''}`;
      const k = key(event.item);
      const existing = context.items.find((i) => key(i) === k);
      const items = existing
        ? context.items.map((i) => (key(i) === k ? { ...i, qty: i.qty + event.item.qty } : i))
        : [...context.items, event.item];
      return { items };
    },
    setQty: (context, event: { productId: string; variantId: string | null; qty: number }) => ({
      // Clamp to a sane positive integer — a blank/NaN input must not delete the
      // item or poison the cart-link `${variantId}:${qty}`.
      items: context.items.map((i) =>
        i.productId === event.productId && i.variantId === event.variantId
          ? { ...i, qty: Number.isFinite(event.qty) ? Math.max(1, Math.floor(event.qty)) : 1 }
          : i
      ),
    }),
    remove: (context, event: { productId: string; variantId: string | null }) => ({
      items: context.items.filter(
        (i) => !(i.productId === event.productId && i.variantId === event.variantId)
      ),
    }),
    clear: () => ({ items: [] as CartItem[] }),
    hydrate: (_context, event: { items: CartItem[] }) => ({ items: event.items }),
  },
});

// Persist every change (client only; on the server localStorage is absent).
cartStore.subscribe((snapshot) => persist(snapshot.context.items));

/** Load the persisted cart into the store (client only, idempotent). */
function hydrateCart(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return;
    const items = JSON.parse(raw) as CartItem[];
    if (Array.isArray(items)) cartStore.trigger.hydrate({ items });
  } catch {
    /* ignore corrupt storage */
  }
}

// Hydrate once at module load on the client — before React renders, so the very
// first post-hydration snapshot already has the saved items. The server never
// runs this (guarded), and useCartItems' getServerSnapshot keeps the hydration
// render itself empty, so there's no mismatch.
if (typeof window !== 'undefined') hydrateCart();

// Stable empty reference for SSR/hydration (useSyncExternalStore requires the
// server snapshot to be referentially stable).
const SERVER_ITEMS: readonly CartItem[] = [];

const subscribeCart = (onChange: () => void) => {
  const sub = cartStore.subscribe(onChange);
  return () => sub.unsubscribe();
};

/**
 * Subscribe to the cart's items (no useEffect; SSR-safe).
 *
 * Relies on @xstate/store returning a referentially-stable `context.items` between
 * unrelated renders (it only allocates a new array when a reducer changes it), so
 * useSyncExternalStore's Object.is check doesn't loop. The reducers above always
 * return a fresh `items` array on change, preserving that contract.
 */
export function useCartItems(): readonly CartItem[] {
  return useSyncExternalStore(
    subscribeCart,
    () => cartStore.getSnapshot().context.items,
    () => SERVER_ITEMS
  );
}
