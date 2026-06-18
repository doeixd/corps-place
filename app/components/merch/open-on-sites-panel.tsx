// Presentation-only (MERCH_PLAN §9, §25). The "checkout" replacement: lists the
// cart grouped by store with ONE button per store (popup-blocker safe — one user
// gesture opens one tab). Pre-filled cart where the platform supports it, else
// per-item "Buy on website" links.
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { ArrowRight02Icon, LinkSquare02Icon } from '@/components/icons/generated';
import { groupForHandoff } from '@/lib/merch-cart-links';
import type { CartItem } from '@/stores/cart-store';

export function OpenOnSitesPanel({ items }: { items: readonly CartItem[] }) {
  const groups = groupForHandoff(items);
  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <Card key={g.storeId}>
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="flex items-center justify-between gap-2">
              <div className="font-semibold">{g.storeName}</div>
              <span className="text-xs text-text-secondary">
                {g.items.length} item{g.items.length !== 1 ? 's' : ''}
              </span>
            </div>

            {g.cartUrl ? (
              <a
                href={g.cartUrl}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: 'default', size: 'default' })}
              >
                Open cart at {g.storeName}
                <Icon icon={ArrowRight02Icon} size="sm" />
              </a>
            ) : (
              <ul className="space-y-1.5">
                {g.items.map((i) => (
                  <li key={`${i.productId}|${i.variantId ?? ''}`}>
                    <a
                      href={i.productUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                    >
                      <Icon icon={LinkSquare02Icon} size="sm" />
                      {i.title}
                      {i.qty > 1 ? ` ×${i.qty}` : ''}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
