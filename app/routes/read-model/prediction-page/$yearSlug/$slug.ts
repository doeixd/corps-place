import { createServerFileRoute } from '@tanstack/react-start/server';
import {
  getHybridEventPredictionPageData,
  getHybridEventFullRecap,
} from '@/lib/server-fns/hybrid';
import { SHARD_HEADERS } from '@/lib/read-model-meta';

// Past-season prediction-page detail shard (loadDetailOrServer). Byte-matches the
// route loader's `fromServer`: page data + the judge-level full recap, combined.
// On error we let the framework 500 so loadDetailOrServer falls back to its own
// server-fn path. Cache-busted by the manifest ?v=.
export const ServerRoute = createServerFileRoute(
  '/read-model/prediction-page/$yearSlug/$slug'
).methods({
  GET: async ({ params }) => {
    const yearSlug = params.yearSlug;
    const slug = params.slug.replace(/\.json$/i, '');
    const [data, fullRecap] = await Promise.all([
      getHybridEventPredictionPageData({ data: { yearSlug, slug } }),
      getHybridEventFullRecap({ data: slug }).catch(() => null),
    ]);
    return new Response(JSON.stringify({ ...data, fullRecap }), { headers: SHARD_HEADERS });
  },
});
