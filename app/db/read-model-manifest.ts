// Read-model manifest loader (DATA_LAYER_DECISION §4).
//
// The manifest is the single short-cached, revalidated entry point for the
// static read-model snapshot. It maps each eagerly-preloaded index collection to
// a content-hashed `?v=` URL (immutable, cached forever) and carries a global
// `version` token used to cache-bust on-demand detail shards. Emitted by
// sdk/scripts/emitReadModel.ts; cache headers set in proxy.mjs.

export type ReadModelManifest = {
  schema_version: number;
  built_at: string;
  current_season: string;
  /** Global cache-bust token for on-demand detail shards (changes every emit). */
  version: string;
  /** Versioned URLs (relative to /read-model/) for the index collections. */
  shards: {
    events: string;
    corps: string;
    judges: string;
    /** Optional: present once the emit/deploy pipeline publishes the staff index
     *  shard. Until then the staff directory renders from its route loader. */
    staff?: string;
  };
};

const MANIFEST_URL = '/read-model/manifest.json';

let manifestPromise: Promise<ReadModelManifest> | null = null;

/**
 * Fetch (and process-cache) the read-model manifest. The browser revalidates the
 * manifest cheaply (short max-age + SWR); the versioned shard URLs it points at
 * are immutable, so they download once and serve from cache thereafter.
 */
export function loadReadModelManifest(): Promise<ReadModelManifest> {
  return (manifestPromise ??= fetch(MANIFEST_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`read-model manifest ${res.status}`);
      return res.json() as Promise<ReadModelManifest>;
    })
    .catch((err) => {
      // Don't cache a failed fetch — let the next caller retry.
      manifestPromise = null;
      throw err;
    }));
}

/** Absolute URL for an index-collection shard (already carries its `?v=`). */
export function indexShardUrl(
  manifest: ReadModelManifest,
  shard: keyof ReadModelManifest['shards']
): string {
  return `/read-model/${manifest.shards[shard]}`;
}

/** Cache-busted URL for an on-demand detail shard, e.g. detailShardUrl(m, 'corps/blue-devils.json'). */
export function detailShardUrl(manifest: ReadModelManifest, rel: string): string {
  return `/read-model/${rel}?v=${encodeURIComponent(manifest.version)}`;
}
