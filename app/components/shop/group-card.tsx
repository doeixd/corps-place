import { Link } from '@tanstack/react-router';
import { GroupLogo } from '@/components/shop/group-logo';
import type { ShopGroupCard as ShopGroupCardData } from '@/lib/merch-types';

/** A group (corps/vendor) card: logo + name + item count, links to its storefront. */
export function GroupCard({ group }: { group: ShopGroupCardData }) {
  return (
    <Link
      to="/shop/group/$storeId"
      params={{ storeId: group.slug }}
      className="card-hover flex h-full flex-col items-center gap-2.5 rounded-xl border border-border bg-card p-4 text-center"
    >
      <GroupLogo
        name={group.name}
        logo={group.logo}
        storeLogo={group.storeLogo}
        width={64}
        className="size-16"
      />
      <div className="min-w-0">
        <div className="line-clamp-2 text-sm font-semibold leading-tight">{group.name}</div>
        <div className="mt-0.5 text-xs text-text-secondary">{group.count} items</div>
      </div>
    </Link>
  );
}
