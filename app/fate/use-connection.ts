import type { View, ViewRef } from '@nkzw/fate';
import { useRequest, useListView } from 'react-fate';

/**
 * `useConnection` — a higher-level hook that composes `useRequest` + `useListView`
 * into a single, fully type-safe call for connection-style (paginated) root lists.
 *
 * Instead of:
 *   const data = useRequest({ events: { list: EventConnectionView } })
 *   const [items, loadNext, loadPrev] = useListView(EventConnectionView, data.events)
 *
 * write:
 *   const [items, loadNext, loadPrev] = useConnection("events", EventConnectionView)
 *
 * The node ref type is derived from the ConnectionView's `items.node` view, so
 * `item.node` is typed exactly (e.g. `ViewRef<"Event">`) with no casts at the
 * call site. The two internal `as` bridges exist only because the dynamic root
 * key erases `useRequest`'s mapped-type inference — they're contained here so the
 * public signature stays sound.
 */

type LoadMoreFn = () => Promise<void>;

/** Minimal structural shape of a client ConnectionView (see fate-events.tsx). */
export type ConnectionView = {
  args?: Record<string, unknown>;
  items: { cursor?: boolean; node: unknown };
  pagination?: Record<string, boolean>;
};

/** The entity ref type for a ConnectionView, read off its `items.node` view. */
type NodeRef<CV extends ConnectionView> =
  CV['items']['node'] extends View<infer T, infer _S> ? ViewRef<T['__typename']> : never;

export type ConnectionEdge<CV extends ConnectionView> = {
  cursor?: string;
  node: NodeRef<CV>;
};

export function useConnection<CV extends ConnectionView>(
  rootKey: string,
  connectionView: CV,
  args?: CV['args']
): readonly [ReadonlyArray<ConnectionEdge<CV>>, LoadMoreFn | null, LoadMoreFn | null] {
  const data = useRequest({
    [rootKey]: { list: connectionView, ...(args ? { args } : {}) },
  } as Record<string, { list: CV; args?: CV['args'] }>);

  const connection = (data as Record<string, unknown>)[rootKey];

  return useListView(connectionView, connection as never) as readonly [
    ReadonlyArray<ConnectionEdge<CV>>,
    LoadMoreFn | null,
    LoadMoreFn | null,
  ];
}
