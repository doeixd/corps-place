import type { ReactNode } from 'react';
import { useLiveQuery, type Collection } from '@tanstack/react-db';
import { seedIndexCollection } from '@/db/json-collection';

/**
 * Renders directory data from the route's loader during SSR + first client paint,
 * then hands over to the live TanStack DB collection once it has bulk-loaded after
 * hydration (client-side filter/sort, offline-ready — DATA_LAYER_DECISION §3).
 *
 * Why a wrapper and not a hook: `useLiveQuery` can't run on the server (the
 * collection is empty/client-only there), and you can't call it conditionally
 * (rules of hooks). So the live read has to live in a child that only mounts in
 * the browser. This centralizes that SSR/hydration dance — and the reason for it —
 * that was previously copy-pasted across every directory route.
 *
 * Usage:
 *   <HybridCollection collection={corpsCollection} loader={loaderCorps}>
 *     {(corps) => <CorpsDirectoryContent corps={corps} />}
 *   </HybridCollection>
 */
export function HybridCollection<T extends object>({
  collection,
  loader,
  seed = true,
  children,
}: {
  // Row type is inferred from `loader`, not the collection: the collection's
  // own row type widens to a deep-writable `Record<string, unknown>`, so binding
  // T to it would clash with the loader/children's concrete row type.
  collection: Collection<any, string | number, any>;
  loader: T[];
  /**
   * Seed the collection's first sync from `loader` (skips the duplicate shard
   * fetch). MUST be false when the loader carries only a slice of the directory
   * (e.g. one season) — seeding a partial list would starve the collection.
   */
  seed?: boolean;
  children: (rows: T[]) => ReactNode;
}) {
  // NOTE: useLiveQuery inside LiveBridge is hydration-safe only because of the
  // pnpm patch on @tanstack/react-db (patches/): upstream omits the
  // getServerSnapshot arg to useSyncExternalStore, which throws React #407 →
  // #423 during hydration on every page rendered through this component —
  // React then discards the SSR DOM and re-renders the whole tree client-side
  // (losing scroll positions and doubling render work).
  if (typeof window === 'undefined') return <>{children(loader)}</>;
  return (
    <LiveBridge collection={collection} loader={loader} seed={seed}>
      {children}
    </LiveBridge>
  );
}

/**
 * Single-record variant of {@link HybridCollection} for a collection that holds
 * ONE composite row (e.g. a per-slug league detail payload). Renders the loader
 * record during SSR + first paint, then the live row once the collection has
 * synced — falling back to the loader until then (and on sync error).
 *
 * Usage:
 *   <HybridRecord collection={leagueDetailCollection(slug)} loader={data}>
 *     {(league) => <LeagueDashboard data={league} />}
 *   </HybridRecord>
 */
export function HybridRecord<T extends object>({
  collection,
  loader,
  children,
}: {
  // See HybridCollection: row type comes from `loader`, not the collection.
  collection: Collection<any, string | number, any>;
  loader: T;
  children: (row: T) => ReactNode;
}) {
  if (typeof window === 'undefined') return <>{children(loader)}</>;
  return (
    <RecordBridge collection={collection} loader={loader}>
      {children}
    </RecordBridge>
  );
}

function RecordBridge<T extends object>({
  collection,
  loader,
  children,
}: {
  collection: Collection<T, string | number, any>;
  loader: T;
  children: (row: T) => ReactNode;
}) {
  const { data } = useLiveQuery(collection as never);
  const rows = (data ?? []) as T[];
  // Prefer the live record once present; until the collection syncs (or if it
  // errored), render the SSR loader payload so the page never flashes empty.
  return <>{children(rows.length > 0 ? rows[0] : loader)}</>;
}

// Client-only: subscribes to the collection and falls back to the loader payload
// until the shard has loaded (the collection is empty on the first client render).
function LiveBridge<T extends object>({
  collection,
  loader,
  seed,
  children,
}: {
  collection: Collection<T, string | number, any>;
  loader: T[];
  seed: boolean;
  children: (rows: T[]) => ReactNode;
}) {
  // Seed the collection's first sync from the loader payload — same read-model
  // data the shard would return, so sync can skip the duplicate network fetch.
  // Must run before useLiveQuery's subscription triggers that sync; a no-op for
  // non-index collections and already-synced ones (the seed is one-shot).
  if (seed) seedIndexCollection((collection as { id?: string }).id, loader);
  const { data } = useLiveQuery(collection as never);
  const rows = (data ?? []) as T[];
  // The collection sorts by the configured key (e.g. corps_key), but the loader
  // was sorted by the read-model's ORDER BY (division -> name, date, etc.).
  // When the row counts match we know no client-side filter has been applied, so
  // preserve the loader's order to avoid a visible reorder flash on hydration.
  // When they differ a filter IS active — defer to the collection's result then.
  const useLoader = rows.length > 0 && rows.length === loader.length;
  return <>{children(useLoader ? loader : rows.length > 0 ? rows : loader)}</>;
}
