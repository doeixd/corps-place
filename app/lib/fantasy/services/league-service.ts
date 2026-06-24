/**
 * LeagueService (migration plan §3.3) — the first fantasy backend slice on
 * Effect. P0 implements `get(slug)`, which reproduces the legacy `getLeague`
 * server-fn payload byte-for-byte via the `ContributionsSql` `SqlClient`.
 *
 * Mirrors the `Context.Service` shape of `app/lib/event-directory.ts`:
 * `makeLeagueService` (Effect.gen) → `LeagueService` (Context.Service) →
 * `LeagueServiceLive` (Layer.effect), every public method an `Effect.fn`.
 *
 * SERVER-ONLY.
 */
import { Context, Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import type { Actor } from '@/lib/authz';
import { paymentsEnabled } from '@/lib/fantasy/payments';
import { vapidPublicKey } from '@/lib/fantasy/push';
import { rateLimit } from '@/lib/rate-limit';
import {
  DEFAULT_CONFIG,
  resolveLeagueConfig,
  draftShapeChanged,
  type LeagueConfig,
} from '@/lib/fantasy/config';
import { makeLeagueSlug, inviteUrl } from '@/lib/fantasy/invites';
import { resolveDraftOrder } from '@/lib/fantasy/draft-order';
import { getSeasonFinals } from '@/lib/fantasy/score-db';
import { LeagueConflict, NotFound, RateLimited } from './errors';
import { leagueReducer, type LeagueStatus } from '@/lib/fantasy/machines/league';
import { makeGuards } from './guards';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

// libsql cell readers (text/int/null columns only), matching the legacy server-fn.
const strOrNull = (v: unknown): string | null => (v == null ? null : (v as string));
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

interface LeagueRow {
  league_id: string;
  slug: string;
  name: string;
  season: string;
  status: string;
  max_members: number;
  config_json: string;
  payment_status: string;
  owner_user_id: string;
  image_media_id: unknown;
}

interface MemberRow {
  user_id: string;
  role: string;
  corps_name: unknown;
  show_title: unknown;
  corps_logo_media_id: unknown;
  corps_color: unknown;
  draft_position: unknown;
  quiz_taken: unknown;
  quiz_score: unknown;
  user_name: unknown;
  user_image: unknown;
}

interface DraftRow {
  status: string;
  scheduled_at: unknown;
  draft_type: string;
  total_rounds: number;
  current_pick_no: number;
}

export interface GetLeagueInput {
  slug: string;
  /** Resolved at the boundary from `getActor(getWebRequest())`; null when signed out. */
  viewerUserId: string | null;
}

interface LeagueSummaryRow {
  league_id: string;
  slug: string;
  name: string;
  season: string;
  status: string;
  role: string;
}

const makeLeagueService = Effect.gen(function* () {
  // Capture the SqlClient once at construction (provided by ContributionsSqlLive
  // on the *Live layer) so the methods below close over the concrete client and
  // carry NO residual requirement at their call sites.
  const sql = yield* ContributionsSql;

  const get = Effect.fn('LeagueService.get')(function* (input: GetLeagueInput) {
    // An unexpected SQL failure on a read is a 500, not a typed domain error —
    // `orDie` keeps the public error channel to `NotFound` only (matching the
    // clean RPC error schema), the same way event-directory surfaces infra
    // failures as defects rather than leaking the libsql error union.
    const leagues = yield* sql<LeagueRow>`
      SELECT * FROM fantasy_leagues WHERE slug = ${input.slug}
    `.pipe(Effect.orDie);
    const league = leagues[0];
    if (!league) return yield* Effect.fail(new NotFound({ message: 'league' }));

    const memberRows = yield* sql<MemberRow>`
      SELECT m.user_id, m.role, m.corps_name, m.show_title, m.corps_logo_media_id,
             m.corps_color, m.draft_position, m.status, m.quiz_score,
             (m.quiz_score IS NOT NULL) AS quiz_taken,
             u.name AS user_name, u.image AS user_image
      FROM fantasy_members m
      LEFT JOIN user u ON u.id = m.user_id
      WHERE m.league_id = ${league.league_id} AND m.status = 'active'
      ORDER BY m.joined_at
    `.pipe(Effect.orDie);
    const members = memberRows.map((m) => ({
      user_id: m.user_id,
      role: m.role,
      corps_name: strOrNull(m.corps_name),
      show_title: strOrNull(m.show_title),
      corps_logo_media_id: strOrNull(m.corps_logo_media_id),
      corps_color: strOrNull(m.corps_color),
      draft_position: numOrNull(m.draft_position),
      quiz_taken: Boolean(m.quiz_taken),
      user_name: strOrNull(m.user_name),
      user_image: strOrNull(m.user_image),
    }));

    const draftRows = yield* sql<DraftRow>`
      SELECT status, scheduled_at, draft_type, total_rounds, current_pick_no
      FROM fantasy_drafts WHERE league_id = ${league.league_id}
    `.pipe(Effect.orDie);
    const draftRow = draftRows[0];
    const draft = draftRow
      ? {
          status: draftRow.status,
          scheduled_at: strOrNull(draftRow.scheduled_at),
          draft_type: draftRow.draft_type,
          total_rounds: Number(draftRow.total_rounds),
          current_pick_no: Number(draftRow.current_pick_no),
        }
      : null;

    const viewer = {
      userId: input.viewerUserId,
      isMember: input.viewerUserId ? members.some((m) => m.user_id === input.viewerUserId) : false,
      isOwner: input.viewerUserId ? league.owner_user_id === input.viewerUserId : false,
    };

    // Projected draft seeding (§ P3) — quiz scores stay server-side; only the
    // resulting order (member ids) is returned. Reflects who's taken the quiz so far.
    const config = JSON.parse(league.config_json) as LeagueConfig;
    const manualOrder = memberRows
      .filter((m) => m.draft_position != null)
      .sort((a, b) => Number(a.draft_position) - Number(b.draft_position))
      .map((m) => m.user_id);
    const draftOrderPreview = resolveDraftOrder(
      memberRows.map((m) => ({
        userId: m.user_id,
        quizScore: m.quiz_score == null ? null : Number(m.quiz_score),
        completedAt: null,
      })),
      config.quizOrderDir,
      league.league_id,
      manualOrder
    );

    // Default shareable invite link, shown to the owner without a button — the
    // newest still-usable reusable invite (max_uses > 1). Read-only here; null
    // means the owner hasn't created one yet (§ invite rework).
    const shareRows = viewer.isOwner
      ? yield* sql<{ token: string; used_count: number; max_uses: number }>`
          SELECT token, used_count, max_uses FROM fantasy_invites
          WHERE league_id = ${league.league_id} AND revoked_at IS NULL AND max_uses > 1
            AND expires_at > ${new Date().toISOString()} AND used_count < max_uses
          ORDER BY created_at DESC LIMIT 1
        `.pipe(Effect.orDie)
      : [];
    const shareInvite = shareRows[0]
      ? {
          url: inviteUrl(shareRows[0].token),
          usedCount: Number(shareRows[0].used_count),
          maxUses: Number(shareRows[0].max_uses),
        }
      : null;

    return {
      league: {
        leagueId: league.league_id,
        slug: league.slug,
        name: league.name,
        season: league.season,
        status: league.status,
        maxMembers: Number(league.max_members),
        config,
        paymentStatus: league.payment_status,
        imageMediaId: strOrNull(league.image_media_id),
      },
      members,
      draft,
      draftOrderPreview,
      viewer,
      shareInvite,
      paymentsEnabled: paymentsEnabled(),
      // Push is only usable when VAPID keys are configured; the dashboard gates the
      // "draft alerts" toggle on this so it never renders as a dead control (§2.2).
      pushEnabled: vapidPublicKey() !== null,
    };
  });

  const { requireOwner } = makeGuards(sql);

  const create = Effect.fn('LeagueService.create')(function* (input: {
    actor: Actor;
    name: string;
    season: string;
    config?: unknown;
  }) {
    yield* requireDurableStorage;
    if (!rateLimit(`league-create:${input.actor.userId}`, 5, 60_000))
      return yield* Effect.fail(new RateLimited({ action: 'league-create' }));

    const config = input.config
      ? resolveLeagueConfig(input.config as Partial<LeagueConfig>)
      : DEFAULT_CONFIG;
    const leagueId = randomUUID();
    const slug = makeLeagueSlug(input.name);
    const now = new Date().toISOString();

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO fantasy_leagues
              (league_id, slug, name, owner_user_id, season, status, config_json,
               max_members, payment_status, created_at, updated_at)
            VALUES (${leagueId}, ${slug}, ${input.name}, ${input.actor.userId}, ${input.season},
                    'setup', ${JSON.stringify(config)}, 12, 'none', ${now}, ${now})
          `;
          yield* sql`
            INSERT INTO fantasy_members (league_id, user_id, role, status, joined_at)
            VALUES (${leagueId}, ${input.actor.userId}, 'owner', 'active', ${now})
          `;
        })
      )
      .pipe(Effect.orDie);

    return { ok: true as const, leagueId, slug };
  });

  const updateConfig = Effect.fn('LeagueService.updateConfig')(function* (input: {
    actor: Actor;
    leagueId: string;
    config: unknown;
  }) {
    yield* requireDurableStorage;
    const league = yield* requireOwner(input.leagueId, input.actor);
    const current = JSON.parse(league.config_json) as LeagueConfig;
    const next = resolveLeagueConfig(input.config as Partial<LeagueConfig>);

    // Draft-shape fields freeze once the draft is past 'scheduled' (§6).
    const started = yield* sql<{ one: number }>`
      SELECT 1 AS one FROM fantasy_drafts WHERE league_id = ${input.leagueId} AND status != 'scheduled' LIMIT 1
    `.pipe(Effect.orDie);
    if (started.length > 0 && draftShapeChanged(current, next))
      return yield* Effect.fail(new LeagueConflict({ reason: 'draft-shape-locked' }));

    // Scoring weights are editable until finals week, then locked (§16 V3).
    const weightsChanged = JSON.stringify(current.weights) !== JSON.stringify(next.weights);
    if (weightsChanged && next.weightsLockedAt === 'finals_week') {
      const finals = yield* Effect.promise(() => getSeasonFinals(league.season));
      const locked = Boolean(
        finals && finals.recapPresent && new Date().toISOString() >= finals.date
      );
      if (locked) return yield* Effect.fail(new LeagueConflict({ reason: 'weights-locked' }));
    }

    const now = new Date().toISOString();
    yield* sql`
      UPDATE fantasy_leagues SET config_json = ${JSON.stringify(next)}, updated_at = ${now}
      WHERE league_id = ${league.league_id}
    `.pipe(Effect.orDie);
    return { ok: true as const };
  });

  const rename = Effect.fn('LeagueService.rename')(function* (input: {
    actor: Actor;
    leagueId: string;
    name: string;
  }) {
    yield* requireDurableStorage;
    const league = yield* requireOwner(input.leagueId, input.actor);
    const name = input.name.trim();
    // Display name only — the slug stays put so existing invite links and
    // bookmarks keep resolving (§ inline rename). 2–60 chars, mirroring create.
    if (name.length < 2 || name.length > 60)
      return yield* Effect.fail(new LeagueConflict({ reason: 'bad-name' }));
    yield* sql`
      UPDATE fantasy_leagues SET name = ${name}, updated_at = ${new Date().toISOString()}
      WHERE league_id = ${league.league_id}
    `.pipe(Effect.orDie);
    return { ok: true as const, name };
  });

  const cancel = Effect.fn('LeagueService.cancel')(function* (input: {
    actor: Actor;
    leagueId: string;
  }) {
    yield* requireDurableStorage;
    const league = yield* requireOwner(input.leagueId, input.actor);
    // Owner exit hatch (§4.9) — the league lifecycle machine decides legality:
    // cancelable from any non-terminal status, refused once complete/canceled.
    const move = leagueReducer(league.status as LeagueStatus, { type: 'CANCEL' });
    if (!move.ok) return yield* Effect.fail(new LeagueConflict({ reason: 'joinable-closed' }));
    yield* sql`
      UPDATE fantasy_leagues SET status = ${move.next}, updated_at = ${new Date().toISOString()}
      WHERE league_id = ${league.league_id}
    `.pipe(Effect.orDie);
    return { ok: true as const };
  });

  const setImage = Effect.fn('LeagueService.setImage')(function* (input: {
    actor: Actor;
    leagueId: string;
    mediaId: string | null;
  }) {
    yield* requireDurableStorage;
    const league = yield* requireOwner(input.leagueId, input.actor);
    yield* sql`
      UPDATE fantasy_leagues SET image_media_id = ${input.mediaId}, updated_at = ${new Date().toISOString()}
      WHERE league_id = ${league.league_id}
    `.pipe(Effect.orDie);
    return { ok: true as const };
  });

  const listMyLeagues = Effect.fn('LeagueService.listMyLeagues')(function* (userId: string) {
    const rows = yield* sql<LeagueSummaryRow>`
      SELECT l.league_id, l.slug, l.name, l.season, l.status, m.role
      FROM fantasy_members m
      JOIN fantasy_leagues l ON l.league_id = m.league_id
      WHERE m.user_id = ${userId} AND m.status = 'active'
      ORDER BY l.created_at DESC
    `.pipe(Effect.orDie);
    return {
      leagues: rows.map((l) => ({
        league_id: l.league_id,
        slug: l.slug,
        name: l.name,
        season: l.season,
        status: l.status,
        role: l.role,
      })),
    };
  });

  return { get, listMyLeagues, create, updateConfig, rename, setImage, cancel };
});

export class LeagueService extends Context.Service<
  LeagueService,
  Effect.Success<typeof makeLeagueService>
>()('LeagueService') {}

export const LeagueServiceLive = Layer.effect(LeagueService, makeLeagueService).pipe(
  Layer.provide(ContributionsSqlLive)
);
