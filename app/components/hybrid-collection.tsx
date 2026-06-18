import type { ReactNode } from 'react';
import { useLiveQuery, type Collection } from '@tanstack/react-db';

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
  children,
}: {
  collection: Collection<T, string | number, any>;
  loader: T[];
  children: (rows: T[]) => ReactNode;
}) {
  if (typeof window === 'undefined') return <>{children(loader)}</>;
  return (
    <LiveBridge collection={collection} loader={loader}>
      {children}
    </LiveBridge>
  );
}

// Client-only: subscribes to the collection and falls back to the loader payload
// until the shard has loaded (the collection is empty on the first client render).
function LiveBridge<T extends object>({
  collection,
  loader,
  children,
}: {
  collection: Collection<T, string | number, any>;
  loader: T[];
  children: (rows: T[]) => ReactNode;
}) {
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
