import { HybridCollection } from '@/components/hybrid-collection';
import { leaguesCollection, seedMyLeagues } from '@/db/fantasy-collections';
import { StaticLeagueList, type LeagueRow } from '@/components/fantasy/league-list-item';

/**
 * The signed-in, live-updating "my leagues" list. Split into its own default-
 * exported module so the route can load it lazily: the TanStack DB collection
 * layer it pulls (@tanstack/react-db differential dataflow + the HybridCollection
 * wrapper, ~190KB) then never ships to logged-out visitors — who only see the
 * marketing + sign-in shell on /fantasy — nor to signed-in users with no leagues.
 */
export default function MyLeaguesList({ leagues }: { leagues: LeagueRow[] }) {
  // Seed the collection's first sync from the loader rows (avoids a double fetch).
  if (typeof window !== 'undefined') seedMyLeagues(leagues);
  return (
    <HybridCollection collection={leaguesCollection} loader={leagues} seed={false}>
      {(rows) => <StaticLeagueList leagues={rows} />}
    </HybridCollection>
  );
}
