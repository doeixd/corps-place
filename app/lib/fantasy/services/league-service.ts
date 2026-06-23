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
import { paymentsEnabled } from '@/lib/fantasy/payments';
import type { LeagueConfig } from '@/lib/fantasy/config';
import { NotFound } from './errors';
import { ContributionsSql, ContributionsSqlLive } from './sql';

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
             m.corps_color, m.draft_position, m.status,
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

    return {
      league: {
        leagueId: league.league_id,
        slug: league.slug,
        name: league.name,
        season: league.season,
        status: league.status,
        maxMembers: Number(league.max_members),
        config: JSON.parse(league.config_json) as LeagueConfig,
        paymentStatus: league.payment_status,
      },
      members,
      draft,
      viewer,
      paymentsEnabled: paymentsEnabled(),
    };
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

  return { get, listMyLeagues };
});

export class LeagueService extends Context.Service<
  LeagueService,
  Effect.Success<typeof makeLeagueService>
>()('LeagueService') {}

export const LeagueServiceLive = Layer.effect(LeagueService, makeLeagueService).pipe(
  Layer.provide(ContributionsSqlLive)
);
