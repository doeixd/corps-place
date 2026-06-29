/**
 * Shared loader gate for every `/admin/*` route (ADMIN_PAGE_PLAN §1 option A, §2).
 *
 * The repo keeps `beforeLoad` synchronous and enforces auth in the loader via a
 * server-fn (mirror `fantasy/index.tsx`). Each admin route does:
 *   `loader: requireAdminLoader('viewAdmin')`
 * and the component renders a sign-in prompt when `!actor`. A signed-in user without
 * the capability gets `notFound()` so the console's existence isn't advertised.
 * `requireCapability` re-checks inside every admin server-fn — that's the real gate;
 * this just shapes what the page renders.
 */
import { notFound } from '@tanstack/react-router';
import { requireAdmin } from '@/lib/server-fns/admin';
import type { Capability } from '@/lib/authz';

export type AdminGate =
  | { actor: { userId: string; role: string }; signedIn: true }
  | { actor: null; signedIn: false };

type AdminCap = Extract<
  Capability,
  | 'viewAdmin'
  | 'runJobs'
  | 'manageUsers'
  | 'manageFantasyQuiz'
  | 'manageFantasyLeagues'
  | 'customerSupport'
  | 'impersonate'
>;

export const requireAdminLoader = (cap: AdminCap) => async (): Promise<AdminGate> => {
  const result = await requireAdmin({ data: { cap } });
  if (result.status === 'ok') {
    return { actor: { userId: result.userId, role: result.role }, signedIn: true };
  }
  if (result.status === 'signed_out') return { actor: null, signedIn: false };
  throw notFound(); // signed in but unauthorized → don't reveal the console
};

/**
 * Loader that gates AND fetches the page's data server-side (AGENTS: data fetching
 * belongs in the loader, never a client `useEffect`). Returns `{ gate, data }`; `data`
 * is fetched only when authorized (null otherwise). Components read it via
 * `Route.useLoaderData()` and refresh after mutations with `router.invalidate()`.
 */
export const adminLoader =
  <T>(cap: AdminCap, fetch: (ctx: { deps: unknown }) => Promise<T>) =>
  async (ctx?: { deps?: unknown }): Promise<{ gate: AdminGate; data: T | null }> => {
    const gate = await requireAdminLoader(cap)();
    // Forward the loader context (carries `deps` from the route's `loaderDeps`, e.g.
    // URL search params) so pages can fetch URL-driven data. 0-arg callers ignore it.
    return { gate, data: gate.signedIn ? await fetch({ deps: ctx?.deps ?? {} }) : null };
  };
