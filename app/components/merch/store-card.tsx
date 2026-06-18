// Presentation-only store card (MERCH_PLAN §23.4). Takes data via props.
import { Link } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { Badge } from '@/components/reui/badge';
import { ArrowRight02Icon, LinkSquare02Icon } from '@/components/icons/generated';
import type { MerchStoreSummary } from '@/lib/merch-types';

export function StoreCard({ store }: { store: MerchStoreSummary }) {
  const hasProducts = store.productCount > 0;
  return (
    <Card className="card-hover flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col gap-2 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-semibold">{store.name}</div>
            <div className="mt-0.5 text-xs text-text-secondary">
              {hasProducts ? `${store.productCount} products` : 'Browse on website'}
            </div>
          </div>
          {store.platform ? (
            <Badge variant="secondary" size="xs" radius="full" className="shrink-0">
              {store.platform}
            </Badge>
          ) : null}
        </div>

        <div className="mt-auto pt-2">
          {hasProducts ? (
            <Link
              to="/shop/group/$storeId"
              params={{ storeId: store.slug }}
              className="group inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              Browse products
              <Icon icon={ArrowRight02Icon} size="sm" className="icon-shift" />
            </Link>
          ) : (
            <a
              href={store.storeUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Icon icon={LinkSquare02Icon} size="sm" />
              Shop on website
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
