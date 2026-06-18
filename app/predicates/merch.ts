// Composable predicates over merch products (MERCH_PLAN §17). Pure functions,
// combined with Predicate.and in @/lib/merch-filtering. Mirrors @/predicates/corps.
import * as Predicate from 'effect/Predicate';
import type { MerchProductSummary } from '@/lib/merch-types';

export const hasSearchTerm: Predicate.Predicate<string> = (term) =>
  Predicate.isString(term) && term.trim().length > 0;

export const matchesSearch = (term: string): Predicate.Predicate<MerchProductSummary> => {
  const q = term.trim().toLowerCase();
  return (p) => p.title.toLowerCase().includes(q) || p.storeName.toLowerCase().includes(q);
};

// Multi-store filter: an empty selection means "no filter"; otherwise keep
// products in ANY of the selected stores (OR).
export const inStores = (storeIds: readonly string[]): Predicate.Predicate<MerchProductSummary> => {
  if (storeIds.length === 0) return () => true;
  const set = new Set(storeIds);
  return (p) => set.has(p.storeId);
};

export const inCategory = (category: string): Predicate.Predicate<MerchProductSummary> =>
  category === 'all' ? () => true : (p) => p.category === category;

export const inPriceBucket = (
  bucket: { min: number; max: number | null } | null
): Predicate.Predicate<MerchProductSummary> =>
  bucket === null
    ? () => true
    : (p) =>
        p.priceMin !== null &&
        p.priceMin >= bucket.min &&
        (bucket.max === null || p.priceMin < bucket.max);

// Treat unknown availability (null) as available — only a hard `false` is hidden.
export const isAvailable: Predicate.Predicate<MerchProductSummary> = (p) => p.available !== false;
