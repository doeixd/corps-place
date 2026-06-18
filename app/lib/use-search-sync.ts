import { useEffect, useRef } from 'react';

/**
 * Two-way sync between an XState machine's context and the route's search params.
 *
 * The machine stays authoritative for behavior; the URL is a shareable projection
 * of a *synced slice* of its context. The mapping lives in one {@link SearchCodec}:
 *  - `encode(ctx)` → search params (emit `undefined` for values at their default
 *    so URLs stay clean),
 *  - `decode(search)` → the resolved synced slice (defaults filled in).
 *
 * The URL→machine direction collapses to a single `SYNC` event the machine
 * applies however it likes (usually an `assign` merge). Seed the machine's
 * `input` from `decode(search)` so initial context already matches the URL — then
 * this hook only mirrors ongoing changes and re-applies external navigations
 * (back/forward), with no mount-time clobber and no feedback loop.
 */
export interface SearchCodec<Ctx, Search> {
  encode: (ctx: Ctx) => Partial<Search>;
  decode: (search: Search) => Partial<Ctx>;
}

export type SyncEvent<Ctx> = { type: 'SYNC'; patch: Partial<Ctx> };

const stripUndefined = (o: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => Object.is(a[k], b[k]));
};

const syncValueEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => syncValueEqual(value, b[index]));
  }
  if (
    a != null &&
    b != null &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    Object.getPrototypeOf(a) === Object.prototype &&
    Object.getPrototypeOf(b) === Object.prototype
  ) {
    return shallowEqual(a as Record<string, unknown>, b as Record<string, unknown>);
  }
  return false;
};

export function useSearchSync<Ctx extends object, Search extends object>(args: {
  context: Ctx;
  send: (event: SyncEvent<Ctx>) => void;
  search: Search;
  navigate: (opts: { search: Search; replace?: boolean; resetScroll?: boolean }) => void;
  codec: SearchCodec<Ctx, Search>;
  /** Gate hydration until dependent data is ready (default true). */
  ready?: boolean;
}): void {
  const { context, send, search, navigate, codec, ready = true } = args;

  // Latest values, so the effects can stay keyed to just `search` / `context`.
  const ref = useRef({ context, send, search, navigate, codec });
  ref.current = { context, send, search, navigate, codec };

  // URL → machine: on (initial + external) search changes, apply the decoded
  // slice if it differs from the machine's current context.
  useEffect(() => {
    if (!ready) return;
    const { context: ctx, codec: c, send: sendFn } = ref.current;
    const patch = c.decode(search);
    const differs = (Object.keys(patch) as (keyof Ctx)[]).some(
      (k) => !syncValueEqual(ctx[k], patch[k])
    );
    if (differs) sendFn({ type: 'SYNC', patch });
  }, [search, ready]);

  // machine → URL: mirror the encoded slice into the search params (replace).
  useEffect(() => {
    if (!ready) return;
    const { search: cur, codec: c, navigate: nav } = ref.current;
    const next = stripUndefined({ ...cur, ...c.encode(context) });
    if (!shallowEqual(next, stripUndefined(cur)))
      // resetScroll:false — these are in-place view updates (roll/window/filter/
      // sort), not page navigations, so they must not jump the page to the top.
      nav({ search: next as unknown as Search, replace: true, resetScroll: false });
  }, [context, ready]);
}
