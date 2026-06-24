/**
 * InviteService (migration plan §3.3 / P2b) — invite create/revoke/get + the
 * race-safe acceptInvite. The atomic seat claim is an `UPDATE … RETURNING` CAS
 * (one row back = claimed); any failure after the claim releases the seat via
 * `Effect.onError` (the Effect analogue of the legacy try/catch releaseSeat).
 *
 * SERVER-ONLY. Mirrors the Context.Service shape of league-service.ts.
 */
import { Context, Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import type { Actor } from '@/lib/authz';
import {
  mintInviteToken,
  isoPlusDays,
  inviteUrl,
  DEFAULT_INVITE_DAYS,
} from '@/lib/fantasy/invites';
import { sendEmail } from '@/lib/email';
import { rateLimit } from '@/lib/rate-limit';
import { LeagueConflict, NotFound, RateLimited } from './errors';
import { makeGuards, requirePaid } from './guards';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

// League statuses that still allow new members to join (§7.3).
const JOINABLE = new Set(['setup', 'quiz', 'scheduled']);

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
  );

interface InviteRow {
  invite_id: string;
  league_id: string;
  token: string;
  max_uses: number;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
}

const makeInviteService = Effect.gen(function* () {
  const sql = yield* ContributionsSql;
  const g = makeGuards(sql);

  const create = Effect.fn('InviteService.create')(function* (input: {
    actor: Actor;
    leagueId: string;
    email?: string;
    maxUses?: number;
    expiresInDays?: number;
  }) {
    yield* requireDurableStorage;
    if (!rateLimit(`invite-create:${input.actor.userId}`, 30, 60_000))
      return yield* Effect.fail(new RateLimited({ action: 'invite-create' }));

    const league = yield* g.requireOwner(input.leagueId, input.actor);
    yield* requirePaid(league);

    const inviteId = randomUUID();
    const token = mintInviteToken();
    const now = new Date().toISOString();
    const expiresAt = isoPlusDays(now, input.expiresInDays ?? DEFAULT_INVITE_DAYS);

    yield* sql`
      INSERT INTO fantasy_invites
        (invite_id, league_id, token, created_by, email, max_uses, used_count, expires_at, created_at)
      VALUES (${inviteId}, ${input.leagueId}, ${token}, ${input.actor.userId},
              ${input.email ?? null}, ${input.maxUses ?? 1}, 0, ${expiresAt}, ${now})
    `.pipe(Effect.orDie);

    const url = inviteUrl(token);
    if (input.email) {
      const to = input.email;
      const name = league.name;
      yield* Effect.promise(() =>
        sendEmail({
          to,
          subject: `You're invited to ${name} — Fantasy DCI`,
          html: `<p>You've been invited to join the fantasy drum corps league <strong>${escapeHtml(name)}</strong>.</p>
                 <p><a href="${url}">Accept your invite</a></p>
                 <p>This link expires on ${expiresAt.slice(0, 10)}.</p>`,
          tag: 'fantasy_invite',
        })
      );
    }

    return { ok: true as const, token, url };
  });

  const revoke = Effect.fn('InviteService.revoke')(function* (input: {
    actor: Actor;
    inviteId: string;
  }) {
    yield* requireDurableStorage;
    const rows = yield* sql<{ league_id: string }>`
      SELECT league_id FROM fantasy_invites WHERE invite_id = ${input.inviteId}
    `.pipe(Effect.orDie);
    const invite = rows[0];
    if (!invite) return yield* Effect.fail(new NotFound({ message: 'invite' }));
    yield* g.requireOwner(invite.league_id, input.actor);
    yield* sql`
      UPDATE fantasy_invites SET revoked_at = ${new Date().toISOString()} WHERE invite_id = ${input.inviteId}
    `.pipe(Effect.orDie);
    return { ok: true as const };
  });

  // Public loader read: validate a token + describe the invite (token not echoed).
  const getInvite = Effect.fn('InviteService.getInvite')(function* (token: string) {
    const rows = yield* sql<InviteRow>`
      SELECT * FROM fantasy_invites WHERE token = ${token}
    `.pipe(Effect.orDie);
    const invite = rows[0];
    if (!invite) return { state: 'invalid' as const };

    const now = new Date().toISOString();
    if (invite.revoked_at) return { state: 'invalid' as const };
    if (invite.expires_at <= now) return { state: 'invalid' as const };
    if (Number(invite.used_count) >= Number(invite.max_uses)) return { state: 'used_up' as const };

    const leagues = yield* sql<{
      name: string;
      slug: string;
      status: string;
      max_members: number;
      owner_user_id: string;
    }>`
      SELECT name, slug, status, max_members, owner_user_id
      FROM fantasy_leagues WHERE league_id = ${invite.league_id}
    `.pipe(Effect.orDie);
    const league = leagues[0];
    if (!league) return { state: 'invalid' as const };
    if (!JOINABLE.has(league.status)) return { state: 'closed' as const };

    const memberCount = yield* g.activeMemberCount(invite.league_id);
    // Context for the invitee (§ P3): who's hosting + when the draft is.
    const owners = yield* sql<{ name: string | null }>`
      SELECT name FROM "user" WHERE id = ${league.owner_user_id}
    `.pipe(Effect.orDie);
    const drafts = yield* sql<{ scheduled_at: string | null }>`
      SELECT scheduled_at FROM fantasy_drafts WHERE league_id = ${invite.league_id}
    `.pipe(Effect.orDie);
    return {
      state: 'ok' as const,
      league: {
        name: league.name,
        slug: league.slug,
        memberCount,
        maxMembers: Number(league.max_members),
        hostName: owners[0]?.name ?? null,
        draftScheduledAt: drafts[0]?.scheduled_at ?? null,
      },
    };
  });

  const accept = Effect.fn('InviteService.accept')(function* (input: {
    actor: Actor;
    token: string;
    corpsName?: string;
    showTitle?: string;
    color?: string;
    logoMediaId?: string;
  }) {
    yield* requireDurableStorage;
    if (!rateLimit(`invite-accept:${input.actor.userId}`, 15, 60_000))
      return yield* Effect.fail(new RateLimited({ action: 'invite-accept' }));
    const now = new Date().toISOString();

    const existsRows = yield* sql<{ invite_id: string; league_id: string }>`
      SELECT invite_id, league_id FROM fantasy_invites WHERE token = ${input.token}
    `.pipe(Effect.orDie);
    const found = existsRows[0];
    if (!found) return yield* Effect.fail(new NotFound({ message: 'invite' }));
    const inviteId = found.invite_id;
    const leagueId = found.league_id;

    // Race-safe seat claim (Appendix G.3): atomically consume one use. A single
    // RETURNING row means we won the claim; zero means used-up/expired/revoked.
    const claimed = yield* sql<{ invite_id: string }>`
      UPDATE fantasy_invites SET used_count = used_count + 1
      WHERE token = ${input.token} AND revoked_at IS NULL AND expires_at > ${now}
        AND used_count < max_uses
      RETURNING invite_id
    `.pipe(Effect.orDie);
    if (claimed.length !== 1) return yield* Effect.fail(new LeagueConflict({ reason: 'used-up' }));

    const releaseSeat = sql`
      UPDATE fantasy_invites SET used_count = used_count - 1 WHERE invite_id = ${inviteId}
    `.pipe(Effect.orDie, Effect.asVoid);

    const corpsName = input.corpsName?.trim() || null;

    const body = Effect.gen(function* () {
      const league = yield* g.loadLeagueById(leagueId);
      if (!JOINABLE.has(league.status))
        return yield* Effect.fail(new LeagueConflict({ reason: 'draft-started' }));

      const existingRows = yield* sql<{ corps_name: string | null; status: string }>`
        SELECT corps_name, status FROM fantasy_members
        WHERE league_id = ${leagueId} AND user_id = ${input.actor.userId}
      `.pipe(Effect.orDie);
      const existing = existingRows[0];

      if (existing && existing.status === 'active') {
        // Already in — re-click is a no-op; release the seat we just claimed.
        yield* releaseSeat;
        return {
          ok: true as const,
          already: true,
          leagueId,
          slug: league.slug,
          needsIdentity: existing.corps_name == null,
        };
      }

      const count = yield* g.activeMemberCount(leagueId);
      if (count >= Number(league.max_members))
        return yield* Effect.fail(new LeagueConflict({ reason: 'full' }));

      if (existing) {
        yield* sql`
          UPDATE fantasy_members
          SET status = 'active', corps_name = COALESCE(${corpsName}, corps_name),
              show_title = COALESCE(${input.showTitle ?? null}, show_title),
              corps_color = COALESCE(${input.color ?? null}, corps_color),
              corps_logo_media_id = COALESCE(${input.logoMediaId ?? null}, corps_logo_media_id)
          WHERE league_id = ${leagueId} AND user_id = ${input.actor.userId}
        `.pipe(Effect.orDie);
      } else {
        yield* sql`
          INSERT INTO fantasy_members
            (league_id, user_id, role, corps_name, show_title, corps_color, corps_logo_media_id, status, joined_at)
          VALUES (${leagueId}, ${input.actor.userId}, 'member', ${corpsName},
                  ${input.showTitle ?? null}, ${input.color ?? null}, ${input.logoMediaId ?? null},
                  'active', ${now})
        `.pipe(Effect.orDie);
      }

      return {
        ok: true as const,
        already: false,
        leagueId,
        slug: league.slug,
        needsIdentity: corpsName == null,
      };
    });

    // Release the claimed seat on ANY failure/defect after the claim (mirrors the
    // legacy try/catch releaseSeat). The "already active" path releases itself and
    // succeeds, so onError does not fire there.
    return yield* body.pipe(Effect.onError(() => releaseSeat));
  });

  return { create, revoke, getInvite, accept };
});

export class InviteService extends Context.Service<
  InviteService,
  Effect.Success<typeof makeInviteService>
>()('InviteService') {}

export const InviteServiceLive = Layer.effect(InviteService, makeInviteService).pipe(
  Layer.provide(ContributionsSqlLive)
);
