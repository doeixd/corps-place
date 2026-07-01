import { createServerFileRoute } from '@tanstack/react-start/server';
import { getHybridEventFullRecap, getCorpsByKeys } from '@/lib/server-fns/hybrid';

/**
 * Cacheable full-recap endpoint for the /scores index (and any lazy recap
 * consumer). Served under `/read-model/` ON PURPOSE: the service worker's data
 * path (public/sw.js) StaleWhileRevalidate-caches anything under that prefix, so
 * a recap fetched once is served INSTANTLY from cache on revisit and revalidated
 * in the background. Because the handler reads the LIVE read-model (via the same
 * services the SSR server fns use), it always converges to fresh data — a
 * re-scored event updates on the next revalidate, with no static-shard emit to
 * keep in sync. Public, read-only (recaps are public).
 *
 * NB: the static `public/read-model/recaps/*.json` shards are a local-dev-only
 * artifact (gitignored, never shipped to prod), so this dynamic route — not those
 * files — is what actually powers cached recaps in production.
 */
const run = async ({ params }: { params: { slug: string } }): Promise<Response> => {
  const slug = params.slug.replace(/\.json$/i, '');
  const recap = await getHybridEventFullRecap({ data: slug }).catch(() => null);
  const keys = (recap?.corps ?? [])
    .map((c: { corpsKey?: string | null }) => c.corpsKey)
    .filter((k: unknown): k is string => typeof k === 'string' && k.length > 0);
  const corps = keys.length ? await getCorpsByKeys({ data: keys }).catch(() => []) : [];

  return new Response(JSON.stringify({ recap, corps }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Short freshness window + long stale-while-revalidate: the SW (and plain
      // browser HTTP cache) serve the cached copy immediately and refresh in the
      // background, so scores stay both instant and up to date.
      'cache-control': 'public, max-age=30, stale-while-revalidate=86400',
    },
  });
};

export const ServerRoute = createServerFileRoute('/read-model/recaps/$slug').methods({
  GET: run,
});
