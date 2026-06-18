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
  // The exported Collection type lacks the internal `NonSingleResult` brand that
  // useLiveQuery's direct-collection overload keys on, so cast for the call only;
  // the public props above keep every call site fully type-checked.
  const { data } = useLiveQuery(collection as never);
  const rows = (data ?? []) as T[];
  return <>{children(rows.length > 0 ? rows : loader)}</>;
}
