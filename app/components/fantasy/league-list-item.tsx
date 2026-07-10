import { Link } from '@tanstack/react-router';
import type { listMyLeagues } from '@/lib/server-fns/fantasy';

export type LeagueRow = Awaited<ReturnType<typeof listMyLeagues>>['leagues'][number];

/** One league row. Deliberately light (a Link + image) with no collection deps,
 *  so it can render on the logged-out/SSR path without pulling TanStack DB. */
export function LeagueListItem({ league }: { league: LeagueRow }) {
  return (
    <Link
      to="/fantasy/$slug"
      params={{ slug: league.slug }}
      className="flex items-center gap-3 rounded-lg border border-border p-3 hover:bg-muted"
    >
      {league.image_media_id ? (
        <img
          src={`/api/fantasy-media/${league.image_media_id}`}
          alt=""
          className="size-10 shrink-0 rounded-lg border border-border object-cover"
        />
      ) : null}
      <span className="font-medium">{league.name}</span>
      <span className="ml-auto text-sm text-muted-foreground">
        {league.season} · {league.status}
        {league.role === 'owner' ? ' · owner' : ''}
      </span>
    </Link>
  );
}

/** The league list rendered straight from loader rows — no TanStack DB collection.
 *  Used for SSR + the Suspense fallback while the live-collection variant loads. */
export function StaticLeagueList({ leagues }: { leagues: LeagueRow[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {leagues.map((l) => (
        <li key={l.league_id}>
          <LeagueListItem league={l} />
        </li>
      ))}
    </ul>
  );
}
