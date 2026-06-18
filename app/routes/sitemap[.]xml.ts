import { createServerFileRoute } from '@tanstack/react-start/server';
import {
  getCorpsDirectory,
  getJudgeDirectory,
  getMerchStores,
  getMerchCatalogPage,
  getMerchFacets,
} from '@/lib/server-fns/hybrid';

// Site-wide sitemap. Enumerates the directory + detail pages (corps, judges) and
// the full merch catalog (products, group storefronts, category pages) so the
// shop is crawlable (MERCH_PLAN §17). Cached a day; regenerated on demand.

const STATIC_PATHS = ['/', '/events', '/corps', '/judges', '/shop', '/shop/all', '/shop/stores'];

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const ServerRoute = createServerFileRoute('/sitemap.xml').methods({
  GET: async ({ request }) => {
    const origin = new URL(request.url).origin;
    const paths = new Set<string>(STATIC_PATHS);

    const [corps, judges, stores, facets] = await Promise.all([
      getCorpsDirectory().catch(() => []),
      getJudgeDirectory().catch(() => []),
      getMerchStores().catch(() => []),
      getMerchFacets().catch(() => null),
    ]);

    for (const c of corps) if (c.slug) paths.add(`/corps/${c.slug}`);
    for (const j of judges) if (j.judge_id) paths.add(`/judges/${j.judge_id}`);
    for (const s of stores)
      if (s.productCount > 0) paths.add(`/shop/group/${encodeURIComponent(s.slug)}`);
    if (facets)
      for (const c of facets.categories) paths.add(`/shop/category/${encodeURIComponent(c.value)}`);

    // Page through the merch catalog for product detail URLs.
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
      /* merch catalog unavailable — sitemap still lists everything else */
    }

    const urls = [...paths]
      .map((p) => `  <url><loc>${xmlEscape(origin + p)}</loc></url>`)
      .join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

    return new Response(xml, {
      headers: {
        'content-type': 'application/xml; charset=utf-8',
        'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
      },
    });
  },
});
