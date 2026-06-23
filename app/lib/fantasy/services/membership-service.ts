/**
 * MembershipService (migration plan §3.3 / P2c) — corps identity + member removal
 * on the Effect path. Ports the legacy setCorpsIdentity / removeMember server-fns.
 *
 * SERVER-ONLY.
 */
import { Context, Effect, Layer } from 'effect';
import type { Actor } from '@/lib/authz';
import { LeagueConflict } from './errors';
import { makeGuards } from './guards';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

const makeMembershipService = Effect.gen(function* () {
  const sql = yield* ContributionsSql;
  const g = makeGuards(sql);

  const setCorpsIdentity = Effect.fn('MembershipService.setCorpsIdentity')(function* (input: {
    actor: Actor;
    leagueId: string;
    corpsName: string;
    showTitle?: string;
    color?: string;
    logoMediaId?: string;
  }) {
    yield* requireDurableStorage;
    yield* g.requireMember(input.leagueId, input.actor);

    // Corps name must be unique within the league (case-insensitive), excluding self.
    const clash = yield* sql<{ one: number }>`
      SELECT 1 AS one FROM fantasy_members
      WHERE league_id = ${input.leagueId} AND user_id != ${input.actor.userId} AND status = 'active'
        AND lower(corps_name) = lower(${input.corpsName}) LIMIT 1
    `.pipe(Effect.orDie);
    if (clash[0]) return yield* Effect.fail(new LeagueConflict({ reason: 'name-taken' }));

    yield* sql`
      UPDATE fantasy_members
      SET corps_name = ${input.corpsName}, show_title = ${input.showTitle ?? ''},
          corps_color = ${input.color ?? null},
          corps_logo_media_id = COALESCE(${input.logoMediaId ?? null}, corps_logo_media_id)
      WHERE league_id = ${input.leagueId} AND user_id = ${input.actor.userId}
    `.pipe(Effect.orDie);
    return { ok: true as const };
  });

  const removeMember = Effect.fn('MembershipService.removeMember')(function* (input: {
    actor: Actor;
    leagueId: string;
    userId: string;
  }) {
    yield* requireDurableStorage;
    const league = yield* g.requireOwner(input.leagueId, input.actor);

    // Pre-draft only — once the draft is past 'scheduled', rosters are locked.
    const started = yield* sql<{ status: string }>`
      SELECT status FROM fantasy_drafts WHERE league_id = ${input.leagueId} AND status != 'scheduled'
    `.pipe(Effect.orDie);
    if (started[0]) return yield* Effect.fail(new LeagueConflict({ reason: 'draft-started' }));
    if (input.userId === league.owner_user_id)
      return yield* Effect.fail(new LeagueConflict({ reason: 'cannot-remove-owner' }));

    yield* sql`
      UPDATE fantasy_members SET status = 'removed'
      WHERE league_id = ${input.leagueId} AND user_id = ${input.userId}
    `.pipe(Effect.orDie);
    return { ok: true as const };
  });

  return { setCorpsIdentity, removeMember };
});

export class MembershipService extends Context.Service<
  MembershipService,
  Effect.Success<typeof makeMembershipService>
>()('MembershipService') {}

export const MembershipServiceLive = Layer.effect(MembershipService, makeMembershipService).pipe(
  Layer.provide(ContributionsSqlLive)
);
