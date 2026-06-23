/**
 * Shared authz / lookup guards for the fantasy services (migration plan §3.3).
 * `makeGuards(sql)` binds a set of guard Effects to a captured `ContributionsSql`
 * client so each service can `const g = makeGuards(sql)` at construction and reuse
 * `requireOwner` / `requireMember` / etc. without re-implementing them.
 *
 * SqlError on these reads is unexpected → `orDie` (defect); the only typed
 * failures are the domain errors (NotFound / Forbidden / LeagueConflict).
 */
import { Effect } from 'effect';
import type { SqlClient } from 'effect/unstable/sql';
import type { Actor } from '@/lib/authz';
import { paymentsEnabled } from '@/lib/fantasy/payments';
import { Forbidden, LeagueConflict, NotFound } from './errors';

export interface LeagueRow {
  league_id: string;
  slug: string;
  name: string;
  season: string;
  status: string;
  owner_user_id: string;
  max_members: number;
  config_json: string;
  payment_status: string;
}

export const makeGuards = (sql: SqlClient.SqlClient) => {
  const loadLeagueById = Effect.fn('guards.loadLeagueById')(function* (leagueId: string) {
    const rows = yield* sql<LeagueRow>`
      SELECT * FROM fantasy_leagues WHERE league_id = ${leagueId}
    `.pipe(Effect.orDie);
    const league = rows[0];
    if (!league) return yield* Effect.fail(new NotFound({ message: 'league' }));
    return league;
  });

  const requireOwner = Effect.fn('guards.requireOwner')(function* (leagueId: string, actor: Actor) {
    const league = yield* loadLeagueById(leagueId);
    if (league.owner_user_id !== actor.userId) return yield* Effect.fail(new Forbidden());
    return league;
  });

  const requireMember = Effect.fn('guards.requireMember')(function* (
    leagueId: string,
    actor: Actor
  ) {
    const rows = yield* sql<{ user_id: string }>`
      SELECT user_id FROM fantasy_members
      WHERE league_id = ${leagueId} AND user_id = ${actor.userId} AND status = 'active'
    `.pipe(Effect.orDie);
    if (!rows[0]) return yield* Effect.fail(new Forbidden());
  });

  const activeMemberCount = Effect.fn('guards.activeMemberCount')(function* (leagueId: string) {
    const rows = yield* sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM fantasy_members WHERE league_id = ${leagueId} AND status = 'active'
    `.pipe(Effect.orDie);
    return Number(rows[0]?.n ?? 0);
  });

  return { loadLeagueById, requireOwner, requireMember, activeMemberCount };
};

/** When payments are live, a league must be paid before invite/draft (§12.2). */
export const requirePaid = (league: LeagueRow): Effect.Effect<void, LeagueConflict> =>
  paymentsEnabled() && league.payment_status !== 'paid'
    ? Effect.fail(new LeagueConflict({ reason: 'unpaid' }))
    : Effect.void;
