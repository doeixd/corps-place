// Server-backed TanStack DB collections for the Fantasy DCI read pages
// (migration plan §3.6 / P1b). Unlike the static read-model index shards
// (`./json-collection.ts`), fantasy data is dynamic + per-user/per-league, so the
// `sync` fetches the current value by calling the **server-fn** (which runs the
// Effect path server-side) and writes it via `begin/truncate/write/commit`.
//
// The browser bundle stays Effect-free: this imports only the server-fn
// references (thin client proxies) + plain `fetch` under the hood — never the
// services/RPC/SqlClient (those are code-split behind the server-fn). SSR is a
// no-op (the route loader paints first); `HybridCollection`/`HybridRecord` bridge
// the SSR→collection handover.
//
// Each collection exposes a `refetch()` so a mutation can refresh the live view
// (the sync retains its writer handle; refetch truncates + rewrites).
// Import everything from '@tanstack/react-db' (hoisted): it re-exports the core
// '@tanstack/db' types via `export *`. Importing '@tanstack/db' directly fails to
// resolve here (it isn't hoisted to the top-level node_modules).
import { createCollection, type Collection, type CollectionConfig } from '@tanstack/react-db';
import { getLeague, listMyLeagues, getStandings } from '@/lib/server-fns/fantasy';

type LeagueRow = Awaited<ReturnType<typeof listMyLeagues>>['leagues'][number];
type StandingRow = Awaited<ReturnType<typeof getStandings>>['rows'][number];
type LeagueDetail = Awaited<ReturnType<typeof getLeague>>;

type SyncWriter = {
  begin: () => void;
  write: (message: { type: 'insert'; value: never }) => void;
  commit: () => void;
  markReady: () => void;
  truncate: () => void;
};

type Entry<T extends object> = {
  collection: Collection<T, string | number, any>;
  refetch: () => Promise<void>;
};

/**
 * A collection whose rows are (re)loaded by calling a server-fn. The sync runs
 * once when the first subscriber attaches (lazy, client-only); `refetch()` reruns
 * the fetch and replaces the rows via `truncate`. Errors never wedge the
 * collection in "loading" — they `markReady()` so consumers fall back to their
 * SSR loader data.
 */
function serverBackedCollection<T extends object>(opts: {
  id: string;
  getKey: (row: T) => string | number;
  fetchRows: () => Promise<T[]>;
}): Entry<T> {
  let writer: SyncWriter | null = null;
  // Monotonic token so an older overlapping refetch can't clobber a newer one's
  // rows (begin/truncate/write/commit must not interleave between two loads).
  let seq = 0;

  const load = async (): Promise<void> => {
    if (typeof window === 'undefined' || !writer) return;
    const w = writer;
    const mySeq = ++seq;
    try {
      const rows = await opts.fetchRows();
      if (writer !== w || mySeq !== seq) return; // unsubscribed or superseded mid-flight
      w.begin();
      w.truncate();
      for (const row of rows) w.write({ type: 'insert', value: row as never });
      w.commit();
      w.markReady();
    } catch (err) {
      console.error(`[fantasy] collection "${opts.id}" sync failed`, err);
      if (mySeq === seq) w.markReady();
    }
  };

  const config: CollectionConfig<T, string | number> = {
    id: opts.id,
    getKey: opts.getKey,
    sync: {
      sync: (params) => {
        if (typeof window === 'undefined') {
          params.markReady();
          return;
        }
        writer = params as SyncWriter;
        void load();
        return () => {
          writer = null;
        };
      },
    },
  };

  return { collection: createCollection(config), refetch: load };
}

// ---------------------------------------------------------------------------
// leaguesCollection — global per-user list (fits the module-singleton model)
// ---------------------------------------------------------------------------

const myLeagues = serverBackedCollection<LeagueRow>({
  id: 'fantasy-my-leagues',
  getKey: (l) => l.league_id,
  // listMyLeagues throws UNAUTHENTICATED when signed out — caught → empty list.
  fetchRows: async () => (await listMyLeagues()).leagues,
});
export const leaguesCollection = myLeagues.collection;
export const refetchMyLeagues = myLeagues.refetch;

// ---------------------------------------------------------------------------
// per-slug collections — keyed registries (a module singleton can't hold a slug)
// ---------------------------------------------------------------------------

const standingsRegistry = new Map<string, Entry<StandingRow>>();
const standingsEntry = (slug: string): Entry<StandingRow> => {
  let entry = standingsRegistry.get(slug);
  if (!entry) {
    entry = serverBackedCollection<StandingRow>({
      id: `fantasy-standings-${slug}`,
      getKey: (r) => r.userId,
      fetchRows: async () => (await getStandings({ data: { slug } })).rows,
    });
    standingsRegistry.set(slug, entry);
  }
  return entry;
};
export const standingsCollection = (slug: string) => standingsEntry(slug).collection;
export const refetchStandings = (slug: string) => standingsEntry(slug).refetch();

const detailRegistry = new Map<string, Entry<LeagueDetail>>();
const detailEntry = (slug: string): Entry<LeagueDetail> => {
  let entry = detailRegistry.get(slug);
  if (!entry) {
    entry = serverBackedCollection<LeagueDetail>({
      id: `fantasy-league-${slug}`,
      // Single composite record per slug (league + members + draft + viewer).
      getKey: (d) => d.league.slug,
      fetchRows: async () => [await getLeague({ data: { slug } })],
    });
    detailRegistry.set(slug, entry);
  }
  return entry;
};
export const leagueDetailCollection = (slug: string) => detailEntry(slug).collection;
export const refetchLeagueDetail = (slug: string) => detailEntry(slug).refetch();
