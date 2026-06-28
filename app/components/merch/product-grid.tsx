// Presentation-only responsive product grid (MERCH_PLAN §25).
import { ProductCard } from '@/components/merch/product-card';
import type { MerchProductSummary } from '@/lib/merch-types';
import { cn } from '@/lib/utils';

export function ProductGrid({
  products,
  className,
}: {
  products: MerchProductSummary[];
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
        className
      )}
    >
      {products.map((p) => (
        <ProductCard key={p.productId} product={p} />
      ))}
    </div>
  );
}
