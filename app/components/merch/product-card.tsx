// Presentation-only product card (MERCH_PLAN §25). Reused by the catalog, store
// pages, and the corps-profile teaser. Bookmark state is client-local.
import { Link } from '@tanstack/react-router';
import { Card, CardContent } from '@/components/ui/card';
import { BookmarkButton } from '@/components/merch/bookmark-button';
import { GroupLogo } from '@/components/shop/group-logo';
import { Icon } from '@/components/icon';
import { LinkSquare02Icon } from '@/components/icons/generated';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ProgressiveImage } from '@/components/progressive-image';
import { formatPrice, type MerchProductSummary } from '@/lib/merch-types';
import { useThumbhash } from '@/hooks/use-thumbhash';

export function ProductCard({ product }: { product: MerchProductSummary }) {
  const thumb = useThumbhash(product.image);
  return (
    <Card className="card-hover flex h-full flex-col overflow-hidden">
      <Link to="/shop/$productId" params={{ productId: product.productId }} className="group block">
        <div className="aspect-square w-full overflow-hidden bg-muted">
          <ProgressiveImage
            src={product.image}
            alt={product.title}
            width={300}
            widths={[300, 600]}
            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, (max-width: 1280px) 25vw, 20vw"
            lazy
            fit="cover"
            thumbDataUrl={thumb}
            className="h-full w-full"
            imgClassName="transition-transform duration-200 group-hover:scale-[1.03]"
            fallback={
              <div className="flex h-full w-full items-center justify-center text-text-muted">
                No image
              </div>
            }
          />
        </div>
      </Link>
      <CardContent className="flex flex-1 flex-col gap-2">
        <Link
          to="/shop/$productId"
          params={{ productId: product.productId }}
          className="line-clamp-2 text-sm font-semibold hover:text-primary"
          title={product.title}
        >
          {product.title}
        </Link>
        <Link
          to="/shop/group/$storeId"
          params={{ storeId: product.storeSlug }}
          className="flex min-w-0 items-center gap-1.5 text-xs text-text-secondary hover:text-foreground"
        >
          <GroupLogo
            name={product.storeName}
            logo={product.logo}
            storeLogo={product.storeLogo}
            width={20}
            className="size-5"
          />
          <span className="truncate">{product.storeName}</span>
        </Link>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="text-sm font-medium">{formatPrice(product)}</span>
          <div className="flex items-center gap-1.5">
            <BookmarkButton product={product} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    href={product.productUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="View on store"
                    className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-text-secondary transition-colors hover:border-primary/60 hover:text-primary"
                  />
                }
              >
                <Icon icon={LinkSquare02Icon} size="sm" />
              </TooltipTrigger>
              <TooltipContent>View on store</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
