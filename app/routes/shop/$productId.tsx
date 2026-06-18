import { createFileRoute, notFound, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Show } from 'jotai-solid-api';
import { getMerchProduct } from '@/lib/server-fns/hybrid';
import { loadDetailOrServer } from '@/db/detail-shard';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { BookmarkButton } from '@/components/merch/bookmark-button';
import { ProductGallery } from '@/components/merch/product-gallery';
import { GroupLogo } from '@/components/shop/group-logo';
import { Icon } from '@/components/icon';
import { LinkSquare02Icon, SentIcon } from '@/components/icons/generated';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPrice, formatDescription, type MerchProductDetail } from '@/lib/merch-types';
import { buildSeo, clampDescription, SITE_URL } from '@/lib/seo';

export const Route = createFileRoute('/shop/$productId')({
  loader: async ({ params }) => {
    const product = await loadDetailOrServer<MerchProductDetail | null>(
      `merch/products/${params.productId}.json`,
      () => getMerchProduct({ data: params.productId })
    );
    if (!product) throw notFound();
    return { product };
  },
  head: ({ loaderData, params }) => {
    const p = loaderData?.product;
    if (!p) return {};

    const title = `${p.title} — ${p.storeName} — Shop`;
    const rawDesc = p.description?.replace(/\s+/g, ' ').trim();
    const description = clampDescription(
      p.description,
      `${p.title} from ${p.storeName}. Browse drum corps merch on Drum Corps.`
    );
    const path = `/shop/${params.productId}`;
    const canonical = `${SITE_URL}${path}`;
    const image = p.images[0] ?? p.image ?? undefined;
    const availability =
      p.available === false ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock';
    const base = buildSeo({ title, description, path, image, type: 'product' });

    const productLd = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: p.title,
      image: p.images.length > 0 ? p.images : image ? [image] : undefined,
      description: rawDesc || undefined,
      sku: p.productId,
      category: p.category ?? undefined,
      brand: { '@type': 'Brand', name: p.storeName },
      offers: {
        '@type': 'Offer',
        price: p.priceMin ?? undefined,
        priceCurrency: p.currency ?? undefined,
        availability,
        url: p.productUrl,
      },
    };
    const breadcrumbLd = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Shop', item: `${SITE_URL}/shop` },
        {
          '@type': 'ListItem',
          position: 2,
          name: p.storeName,
          item: `${SITE_URL}/shop/group/${p.storeSlug}`,
        },
        { '@type': 'ListItem', position: 3, name: p.title, item: canonical },
      ],
    };

    return {
      meta: [
        ...base.meta,
        // Product-specific Open Graph
        ...(p.priceMin != null
          ? [{ property: 'product:price:amount', content: String(p.priceMin) }]
          : []),
        ...(p.currency ? [{ property: 'product:price:currency', content: p.currency }] : []),
        { property: 'product:availability', content: p.available === false ? 'oos' : 'instock' },
      ],
      links: base.links,
      scripts: [
        { type: 'application/ld+json', children: JSON.stringify(productLd) },
        { type: 'application/ld+json', children: JSON.stringify(breadcrumbLd) },
      ],
    };
  },
  staleTime: 60_000,
  component: ProductDetail,
});

function ProductDetail() {
  const { product } = Route.useLoaderData();
  const [variantId, setVariantId] = useState<string | null>(product.variants[0]?.id ?? null);
  const variant = product.variants.find((v) => v.id === variantId) ?? null;
  const desc = formatDescription(product.description);
  // Prefer the ingested image set (carousel); fall back to the single primary image.
  const galleryImages =
    product.images.length > 0 ? product.images : product.image ? [product.image] : [];

  // Native share sheet where available (mobile + some desktops); otherwise copy
  // the link to the clipboard. Both no-op silently if the user cancels/denies.
  const onShare = async () => {
    if (typeof navigator === 'undefined') return;
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: product.title, url });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
      }
    } catch {
      /* user dismissed the share/permission prompt */
    }
  };

  return (
    <PageShell>
      <PageHeader title={product.title} backTo="/shop/all" backLabel="All Products" />

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="px-3 py-2">
            <ProductGallery images={galleryImages} alt={product.title} />
          </div>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-4 py-4">
            <div>
              <Link
                to="/shop/group/$storeId"
                params={{ storeId: product.storeSlug }}
                className="flex min-w-0 items-center gap-1.5 text-sm text-text-secondary hover:text-foreground"
              >
                <GroupLogo
                  name={product.storeName}
                  logo={product.logo}
                  storeLogo={product.storeLogo}
                  width={24}
                  className="size-6"
                />
                <span className="truncate">{product.storeName}</span>
              </Link>
              <div className="mt-1 text-lg font-semibold">
                {formatPrice(
                  variant
                    ? {
                        priceMin: variant.price,
                        priceMax: variant.price,
                        currency: product.currency,
                      }
                    : product
                )}
              </div>
              <p className="mt-1 text-xs text-text-muted">
                Price shown is from the latest sync — confirm on the store.
              </p>
            </div>

            <Show when={product.variants.length > 1}>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-text-secondary">Options</span>
                <select
                  value={variantId ?? ''}
                  onChange={(e) => setVariantId(e.target.value)}
                  className="rounded-md border border-border bg-background px-3 py-2"
                >
                  {product.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title}
                      {v.available === false ? ' (sold out)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </Show>

            <div className="flex items-center gap-3">
              <BookmarkButton product={product} showLabel />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <a
                      href={product.productUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="View on store"
                      className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-primary/60 hover:text-primary"
                    />
                  }
                >
                  <Icon icon={LinkSquare02Icon} size="sm" />
                  <span>View on store</span>
                </TooltipTrigger>
                <TooltipContent>Opens the store's page in a new tab</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onShare}
                      aria-label="Share"
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-text-secondary transition-colors hover:border-primary/60 hover:text-primary"
                    />
                  }
                >
                  <Icon icon={SentIcon} size="sm" className="-translate-x-px translate-y-px" />
                </TooltipTrigger>
                <TooltipContent>Share</TooltipContent>
              </Tooltip>
            </div>

            <Show when={desc.intro.length > 0 || desc.bullets.length > 0}>
              <div className="space-y-3 text-sm leading-relaxed text-text-secondary">
                {desc.intro.map((p, i) => (
                  <p key={i} className="whitespace-pre-line">
                    {p}
                  </p>
                ))}
                <Show when={desc.bullets.length > 0}>
                  <ul className="list-disc space-y-1 pl-5 marker:text-text-tertiary">
                    {desc.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </Show>
              </div>
            </Show>
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}
