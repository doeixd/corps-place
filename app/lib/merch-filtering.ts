// Merch list selection: filter (Predicate.and) + sort (Match), mirrors
// @/lib/event-filtering / @/lib/judge-filtering. Pure + unit-testable.
import * as Match from 'effect/Match';
import * as Predicate from 'effect/Predicate';
import type { MerchProductSummary, MerchFacets } from '@/lib/merch-types';
import * as P from '@/predicates/merch';

export type MerchSort = 'featured' | 'price-asc' | 'price-desc' | 'name';

export interface MerchFilterContext {
  search: string;
  stores: string[]; // selected store ids; empty = all
  price: string; // bucket label, or 'all'
  category: string; // category label, or 'all'
  inStock: boolean;
  sort: MerchSort;
}

const priceOf = (p: MerchProductSummary) => (p.priceMin === null ? Infinity : p.priceMin);

const sortProducts = (sort: MerchSort, products: MerchProductSummary[]): MerchProductSummary[] =>
  Match.value(sort).pipe(
    Match.when('price-asc', () => [...products].sort((a, b) => priceOf(a) - priceOf(b))),
    Match.when('price-desc', () => [...products].sort((a, b) => priceOf(b) - priceOf(a))),
    Match.when('name', () => [...products].sort((a, b) => a.title.localeCompare(b.title))),
    Match.orElse(() => products) // 'featured' = the emitted order (available first)
  );

export const selectProducts = (
  products: MerchProductSummary[],
  filter: MerchFilterContext,
  facets: MerchFacets | null
): MerchProductSummary[] => {
  const bucket = facets?.priceBuckets.find((b) => b.label === filter.price) ?? null;
  const preds: Predicate.Predicate<MerchProductSummary>[] = [
    P.inStores(filter.stores),
    P.inCategory(filter.category),
    P.inPriceBucket(bucket ? { min: bucket.min, max: bucket.max } : null),
  ];
  if (P.hasSearchTerm(filter.search)) preds.push(P.matchesSearch(filter.search));
  if (filter.inStock) preds.push(P.isAvailable);
  const keep = preds.reduce(
    (acc, p) => Predicate.and(acc, p),
    (() => true) as Predicate.Predicate<MerchProductSummary>
  );
  return sortProducts(filter.sort, products.filter(keep));
};
