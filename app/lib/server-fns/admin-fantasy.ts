/**
 * Fantasy admin/ops server-fns (ADMIN_PAGE_PLAN §9). Site-staff support tools, gated
 * by `manageFantasyLeagues` (distinct from the owner-gated controls in fantasy.ts).
 * Quiz-bank CRUD already lives in fantasy.ts (adminListQuestions/…, manageFantasyQuiz).
 * Every mutation is audited.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { requireCapability } from '@/lib/authz';
import { writeAudit } from '@/lib/admin-audit';
import * as draftEngine from '@/lib/fantasy/draft-engine';
import { Effect } from 'effect';
import { StandingsService } from '@/lib/fantasy/services/standings-service';
import { provideFantasy } from '@/rpc';

export interface AdminLeagueRow {
  leagueId: string;
  slug: string;
  name: string;
  ownerUserId: string;
  season: string;
  status: string;
  members: number;
  createdAt: string;
}

const ListLeaguesInput = v.object({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)), 100),
});

/** List leagues with member counts. Cap: manageFantasyLeagues. */
export const adminListLeagues = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(ListLeaguesInput, d))
  .handler(async ({ data }): Promise<AdminLeagueRow[]> => {
    await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    const rows = (
      await db.execute({
        sql: `SELECT l.league_id, l.slug, l.name, l.owner_user_id, l.season, l.status, l.created_at,
                     (SELECT COUNT(*) FROM fantasy_members m
                        WHERE m.league_id = l.league_id AND m.status = 'active') AS members
              FROM fantasy_leagues l ORDER BY l.created_at DESC LIMIT ?`,
        args: [data.limit],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      leagueId: String(r.league_id),
      slug: String(r.slug),
      name: String(r.name),
      ownerUserId: String(r.owner_user_id),
      season: String(r.season),
      status: String(r.status),
      members: Number(r.members ?? 0),
      createdAt: String(r.created_at),
    }));
  });

export interface AdminLeagueDetail {
  league: AdminLeagueRow;
  draftStatus: string | null;
  members: {
    userId: string;
    role: string;
    corpsName: string | null;
    status: string;
  }[];
}

/** League detail: members + draft status. Cap: manageFantasyLeagues. */
export const adminGetLeague = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }): Promise<AdminLeagueDetail> => {
    await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    const l = (
      await db.execute({
        sql: 'SELECT * FROM fantasy_leagues WHERE league_id = ?',
        args: [data.leagueId],
      })
    ).rows[0] as unknown as Record<string, unknown> | undefined;
    if (!l) throw new Error('NOT_FOUND');
    const members = (
      await db.execute({
        sql: `SELECT user_id, role, corps_name, status FROM fantasy_members WHERE league_id = ?`,
        args: [data.leagueId],
      })
    ).rows as unknown as Record<string, unknown>[];
    const draft = (
      await db.execute({
        sql: 'SELECT status FROM fantasy_drafts WHERE league_id = ?',
        args: [data.leagueId],
      })
    ).rows[0] as { status?: string } | undefined;
    const memberCount = members.filter((m) => String(m.status) === 'active').length;
    return {
      league: {
        leagueId: String(l.league_id),
        slug: String(l.slug),
        name: String(l.name),
        ownerUserId: String(l.owner_user_id),
        season: String(l.season),
        status: String(l.status),
        members: memberCount,
        createdAt: String(l.created_at),
      },
      draftStatus: draft?.status ?? null,
      members: members.map((m) => ({
        userId: String(m.user_id),
        role: String(m.role),
        corpsName: (m.corps_name as string) ?? null,
        status: String(m.status),
      })),
    };
  });

const LeagueIdInput = v.object({ leagueId: v.string() });

/** Pause a stuck/abused live draft (support). Cap: manageFantasyLeagues. */
export const adminPauseDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(LeagueIdInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    await draftEngine.pauseDraft(data.leagueId);
    await writeAudit(await getContributionsDb(), actor, {
      action: 'fantasy_pause_draft',
      target: data.leagueId,
    });
    return { ok: true as const };
  });

/** Resume a paused draft (support). Cap: manageFantasyLeagues. */
export const adminResumeDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(LeagueIdInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    await draftEngine.resumeDraft(data.leagueId);
    await writeAudit(await getContributionsDb(), actor, {
      action: 'fantasy_resume_draft',
      target: data.leagueId,
    });
    return { ok: true as const };
  });

/** Cancel a league (support/abuse). Cap: manageFantasyLeagues. */
export const adminCancelLeague = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(LeagueIdInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    const before = (
      await db.execute({
        sql: 'SELECT status FROM fantasy_leagues WHERE league_id = ?',
        args: [data.leagueId],
      })
    ).rows[0] as { status?: string } | undefined;
    if (!before) throw new Error('NOT_FOUND');
    await db.execute({
      sql: `UPDATE fantasy_leagues SET status = 'canceled', updated_at = ? WHERE league_id = ?`,
      args: [new Date().toISOString(), data.leagueId],
    });
    await writeAudit(db, actor, {
      action: 'fantasy_cancel_league',
      target: data.leagueId,
      before: before.status ?? null,
      after: 'canceled',
    });
    return { ok: true as const };
  });

/** Profanity/abuse take-down of a member's corps identity. Cap: manageFantasyLeagues. */
export const adminTakedownIdentity = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string(), userId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    const before = (
      await db.execute({
        sql: 'SELECT corps_name, show_title FROM fantasy_members WHERE league_id = ? AND user_id = ?',
        args: [data.leagueId, data.userId],
      })
    ).rows[0] as Record<string, unknown> | undefined;
    if (!before) throw new Error('NOT_FOUND');
    await db.execute({
      sql: `UPDATE fantasy_members
            SET corps_name = NULL, show_title = NULL, corps_logo_media_id = NULL, corps_color = NULL
            WHERE league_id = ? AND user_id = ?`,
      args: [data.leagueId, data.userId],
    });
    await writeAudit(db, actor, {
      action: 'fantasy_takedown_identity',
      target: `${data.leagueId}:${data.userId}`,
      before: { corpsName: before.corps_name ?? null, showTitle: before.show_title ?? null },
    });
    return { ok: true as const };
  });

/** Force a standings recompute for a season (e.g. after a corrected recap). Cap: manageFantasyLeagues. */
export const adminRecomputeStandings = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(v.object({ season: v.pipe(v.string(), v.regex(/^\d{4}$/)) }), d)
  )
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const summary = await Effect.runPromise(
      Effect.flatMap(StandingsService, (s) => s.recompute(data.season)).pipe(provideFantasy)
    );
    await writeAudit(await getContributionsDb(), actor, {
      action: 'fantasy_recompute_standings',
      target: data.season,
      after: summary as unknown,
    });
    return { ok: true as const, summary };
  });
