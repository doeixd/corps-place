import { setup, assign } from 'xstate';
import type { MerchFilterContext, MerchSort } from '@/lib/merch-filtering';
import type { SearchCodec, SyncEvent } from '@/lib/use-search-sync';

export type MerchFilterEvent =
  | { type: 'SET_SEARCH'; search: string }
  | { type: 'SET_STORES'; stores: string[] }
  | { type: 'SET_PRICE'; price: string }
  | { type: 'SET_CATEGORY'; category: string }
  | { type: 'TOGGLE_IN_STOCK' }
  | { type: 'SET_SORT'; sort: MerchSort }
  | { type: 'RESET' }
  | SyncEvent<MerchFilterContext>;

const DEFAULT: MerchFilterContext = {
  search: '',
  stores: [],
  price: 'all',
  category: 'all',
  inStock: false,
  sort: 'featured',
};

export const merchFilterMachine = setup({
  types: {
    context: {} as MerchFilterContext,
    events: {} as MerchFilterEvent,
    input: {} as Partial<MerchFilterContext>,
  },
}).createMachine({
  id: 'merchFilter',
  context: ({ input }) => ({ ...DEFAULT, ...input }),
  on: {
    SET_SEARCH: { actions: assign({ search: ({ event }) => event.search }) },
    SET_STORES: { actions: assign({ stores: ({ event }) => event.stores }) },
    SET_PRICE: { actions: assign({ price: ({ event }) => event.price }) },
    SET_CATEGORY: { actions: assign({ category: ({ event }) => event.category }) },
    TOGGLE_IN_STOCK: { actions: assign({ inStock: ({ context }) => !context.inStock }) },
    SET_SORT: { actions: assign({ sort: ({ event }) => event.sort }) },
    RESET: { actions: assign(() => ({ ...DEFAULT })) },
    SYNC: { actions: assign(({ context, event }) => ({ ...context, ...event.patch })) },
  },
});

export type MerchSearch = {
  q?: string;
  store?: string;
  price?: string;
  cat?: string;
  stock?: '1';
  sort?: MerchSort;
};

export const merchFilterSearchCodec = (): SearchCodec<MerchFilterContext, MerchSearch> => ({
  encode: (ctx) => ({
    q: ctx.search || undefined,
    store: ctx.stores.length > 0 ? ctx.stores.join(',') : undefined,
    price: ctx.price === 'all' ? undefined : ctx.price,
    cat: ctx.category === 'all' ? undefined : ctx.category,
    stock: ctx.inStock ? '1' : undefined,
    sort: ctx.sort === 'featured' ? undefined : ctx.sort,
  }),
  decode: (search) => ({
    search: search.q ?? '',
    stores: search.store ? search.store.split(',').filter(Boolean) : [],
    price: search.price ?? 'all',
    category: search.cat ?? 'all',
    inStock: search.stock === '1',
    sort: search.sort ?? 'featured',
  }),
});
