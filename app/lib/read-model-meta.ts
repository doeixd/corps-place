// Read-model meta (from rm_meta) for the dynamic /read-model/ shard routes.
//
// `version` is the cache-bust token the manifest hands to the index + detail
// shards: it's the read-model's `built_at`, which changes on every emit / A/B
// slot flip, so a publish invalidates the shard URLs exactly once. Falls back
// gracefully when the read-model isn't configured (local dev builds from the
// relational DB and has no rm_meta) so the routes still serve.
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';

export type ReadModelMeta = {
  schema_version: number;
  built_at: string;
  current_season: string;
  /** Cache-bust token for shard URLs (changes every emit). */
  version: string;
};

const FALLBACK: ReadModelMeta = {
  schema_version: 0,
  built_at: 'dev',
  current_season: '',
  version: 'dev',
};

/** Cache headers for a versioned (`?v=`) index/detail shard: immutable — a new
 *  emit is a new URL, so the service worker (and browser) cache it forever. */
export const SHARD_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=31536000, immutable',
} as const;

export async function getReadModelMeta(): Promise<ReadModelMeta> {
  if (!readModelEnabled()) return FALLBACK;
  try {
    const rows = (await getReadModelClient().execute('SELECT key, value FROM rm_meta'))
      .rows as unknown as { key: string; value: string }[];
    const m = new Map(rows.map((r) => [String(r.key), String(r.value)]));
    const builtAt = m.get('built_at') ?? 'unknown';
    return {
      schema_version: Number(m.get('schema_version') ?? 0),
      built_at: builtAt,
      current_season: m.get('current_season') ?? '',
      // built_at is the natural version; fall back to schema_version if absent.
      version: builtAt !== 'unknown' ? builtAt : `sv${m.get('schema_version') ?? '0'}`,
    };
  } catch {
    return FALLBACK;
  }
}
