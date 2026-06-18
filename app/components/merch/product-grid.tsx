// Presentation-only responsive product grid (MERCH_PLAN §25).
import { ProductCard } from '@/components/merch/product-card';
import type { MerchProductSummary } from '@/lib/merch-types';

export function ProductGrid({ products }: { products: MerchProductSummary[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {products.map((p) => (
        <ProductCard key={p.productId} product={p} />
      ))}
    </div>
  );
}
