import { createServerFileRoute } from '@tanstack/react-start/server';
import { getMerchStores, getMerchCatalogPage, getMerchFacets } from '@/lib/server-fns/hybrid';
import { urlsetResponse } from '@/lib/sitemap-shared';

// Shop sitemap — ~5k product/store/category pages, isolated from the core
// sitemap so merch listings can't dilute how search engines judge the rankable
// scores/events content.

export const ServerRoute = createServerFileRoute('/sitemap-shop.xml').methods({
  GET: async ({ request }) => {
    const origin = new URL(request.url).origin;
    const paths = new Set<string>(['/shop', '/shop/all', '/shop/stores']);

    const [stores, facets] = await Promise.all([
      getMerchStores().catch(() => []),
      getMerchFacets().catch(() => null),
    ]);
    for (const s of stores)
      if (s.productCount > 0) paths.add(`/shop/group/${encodeURIComponent(s.slug)}`);
    if (facets)
      for (const c of facets.categories) paths.add(`/shop/category/${encodeURIComponent(c.value)}`);

    try {
      let page = 1;
      let pages = 1;
      do {
        const slice = await getMerchCatalogPage({ data: page });
        for (const p of slice.items) paths.add(`/shop/${p.productId}`);
        pages = slice.pages;
        page += 1;
      } while (page <= pages);
    } catch {
      /* merch catalog unavailable — sitemap still lists stores/categories */
    }

    return urlsetResponse(origin, paths);
  },
});
