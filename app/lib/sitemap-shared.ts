// Shared helpers for the sitemap routes (sitemap.xml index + per-section child
// sitemaps). Split out so the child routes don't duplicate the XML plumbing.
//
// WHY an index + children instead of one 17k-URL file: Google evaluates each
// sitemap file's quality separately and allocates crawl budget accordingly. A
// single file where 14k of 17.6k URLs are thin staff/shop pages buried the ~2.3k
// scores/events pages that can actually rank — Google sampled the thin pages and
// deprioritized the whole site (site: search returned ONE page, a /staff one).

export const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type DatedUrl = { loc: string; lastmod?: string };

const XML_HEADERS = {
  'content-type': 'application/xml; charset=utf-8',
  'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
} as const;

/** One <urlset> sitemap file. */
export function urlsetResponse(origin: string, paths: Iterable<string>, dated: DatedUrl[] = []): Response {
  const urls = [
    ...[...paths].map((p) => `  <url><loc>${xmlEscape(origin + p)}</loc></url>`),
    ...dated.map(
      (d) =>
        `  <url><loc>${xmlEscape(origin + d.loc)}</loc>${
          d.lastmod ? `<lastmod>${xmlEscape(d.lastmod)}</lastmod>` : ''
        }</url>`
    ),
  ].join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: XML_HEADERS });
}

/** The <sitemapindex> pointing at the child sitemaps. */
export function indexResponse(origin: string, files: string[]): Response {
  const body = files
    .map((f) => `  <sitemap><loc>${xmlEscape(origin + f)}</loc></sitemap>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
  return new Response(xml, { headers: XML_HEADERS });
}

/**
 * A lastmod that search engines will trust: never in the future. Google is
 * documented to IGNORE all of a site's lastmods once it sees unreliable ones —
 * and we were emitting future show dates (e.g. finals) as lastmod. Returns
 * undefined for future dates (the page exists but hasn't "last changed" on a
 * date that hasn't happened).
 */
export function honestLastmod(date: string | null | undefined): string | undefined {
  if (!date) return undefined;
  const d = date.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return d > today ? undefined : d;
}
