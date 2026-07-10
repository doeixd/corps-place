/**
 * Fantasy admin/ops server-fns (ADMIN_PAGE_PLAN §9). Site-staff support tools, gated
 * by `manageFantasyLeagues` (distinct from the owner-gated controls in fantasy.ts).
 * Quiz-bank CRUD already lives in fantasy.ts (adminListQuestions/…, manageFantasyQuiz).
 * Every mutation is audited.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { randomUUID } from 'node:crypto';
import { getContributionsDb } from '@/lib/contributions-db';
import { requireCapability } from '@/lib/authz';
import { writeAudit } from '@/lib/admin-audit';
import { makeLeagueSlug } from '@/lib/fantasy/invites';
import { resolveLeagueConfig, type LeagueConfig } from '@/lib/fantasy/config';
import { sendEmail } from '@/lib/email';
import { sendPushToUser } from '@/lib/fantasy/push';
import { CAPTION_KEYS, CAPTION_CATEGORY, type CaptionKey } from '@/lib/fantasy/captions';
import * as draftEngine from '@/lib/fantasy/draft-engine';
import { Effect } from 'effect';
import { StandingsService } from '@/lib/fantasy/services/standings-service';
import { DraftService } from '@/lib/fantasy/services/draft-service';
// Lazy — a static `import { fantasyRuntime } from '@/rpc'` runs @/rpc's
// ManagedRuntime.make(FantasyServicesLive) side effect at module init, which
// can't be tree-shaken and so drags the whole nine-service fantasy runtime (+
// Stripe, web-push, better-auth, libsql) into the CLIENT bundle. Only these
// admin handlers need it, so load it on demand inside them.
const loadFantasyRuntime = () => import('@/rpc').then((m) => m.fantasyRuntime);

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
    const summary = await (await loadFantasyRuntime()).runPromise(
      Effect.flatMap(StandingsService, (s) => s.recompute(data.season))
    );
    await writeAudit(await getContributionsDb(), actor, {
      action: 'fantasy_recompute_standings',
      target: data.season,
      after: summary as unknown,
    });
    return { ok: true as const, summary };
  });

// ===========================================================================
// FANTASY TEST LAB (docs/plans/FANTASY_TEST_LAB_PLAN.md) — admin-only sandbox.
// ===========================================================================

const CreateTestLeagueInput = v.object({
  name: v.optional(v.string(), 'Test League'),
  members: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(12)), 4),
  season: v.optional(v.string(), '2026'),
  draftType: v.optional(v.picklist(['snake', 'linear']), 'snake'),
  pickSeconds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(600)), 60),
  withQuizScores: v.optional(v.boolean(), true),
});

const BOT_NAMES = [
  'Cadence Bot', 'Rimshot', 'Phantom Test', 'Echo Squad', 'Tempo Unit', 'Color Bot',
  'Brass Bot', 'Pit Crew', 'Drill Bot', 'Aux Line', 'Sabre Bot',
];
const BOT_COLORS = [
  '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04',
  '#db2777', '#4f46e5', '#65a30d', '#0d9488', '#e11d48',
];

/**
 * Spin up an `is_test` league owned by the admin + N-1 synthetic bot members
 * (Test Lab P1). The admin is a real owner (can sign in + receive notifications);
 * bots are `isBot` users with a non-routable unique email (so better-auth's NOT
 * NULL/UNIQUE email holds) and contactConsent left at 0 (never emailed).
 */
export const adminCreateTestLeague = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreateTestLeagueInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    const now = new Date().toISOString();
    const leagueId = randomUUID();
    const slug = makeLeagueSlug(data.name);
    const config = resolveLeagueConfig({ draftType: data.draftType, pickSeconds: data.pickSeconds });

    // payment_status 'paid' bypasses the unlock gate; is_test = 1 keeps it out of the
    // real cron + admin stats. status 'setup' so the admin runs quiz → schedule → draft.
    await db.execute({
      sql: `INSERT INTO fantasy_leagues
              (league_id, slug, name, owner_user_id, season, status, config_json,
               max_members, payment_status, is_test, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'setup', ?, 12, 'paid', 1, ?, ?)`,
      args: [leagueId, slug, data.name, actor.userId, data.season, JSON.stringify(config), now, now],
    });

    await db.execute({
      sql: `INSERT INTO fantasy_members
              (league_id, user_id, role, corps_name, corps_color, quiz_score, draft_position, status, joined_at)
            VALUES (?, ?, 'owner', ?, ?, ?, 1, 'active', ?)`,
      args: [leagueId, actor.userId, 'Your Test Corps', '#2563eb', data.withQuizScores ? 0.95 : null, now],
    });

    const botCount = data.members - 1;
    for (let i = 0; i < botCount; i++) {
      const botId = `testbot-${leagueId.slice(0, 8)}-${i}`;
      const botName = BOT_NAMES[i % BOT_NAMES.length];
      await db.execute({
        sql: `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role, isBot)
              VALUES (?, ?, ?, 0, ?, ?, 'user', 1)
              ON CONFLICT(id) DO NOTHING`,
        args: [botId, botName, `${botId}@bots.fantasy.invalid`, now, now],
      });
      await db.execute({
        sql: `INSERT INTO fantasy_members
                (league_id, user_id, role, corps_name, corps_color, quiz_score, draft_position, status, joined_at)
              VALUES (?, ?, 'member', ?, ?, ?, ?, 'active', ?)`,
        args: [
          leagueId, botId, `${botName} Corps`, BOT_COLORS[i % BOT_COLORS.length],
          data.withQuizScores ? Math.max(0.3, 0.9 - i * 0.07) : null, i + 2, now,
        ],
      });
    }

    await writeAudit(db, actor, {
      action: 'create_test_league',
      target: slug,
      after: { leagueId, slug, members: data.members } as unknown,
    });
    return { ok: true as const, leagueId, slug };
  });

/** List test leagues (is_test = 1) with member counts. Cap: manageFantasyLeagues. */
export const adminListTestLeagues = createServerFn({ method: 'GET' }).handler(async () => {
  await requireCapability(getWebRequest(), 'manageFantasyLeagues');
  const db = await getContributionsDb();
  const rows = (
    await db.execute(
      `SELECT l.league_id, l.slug, l.name, l.status, l.season,
              (SELECT COUNT(*) FROM fantasy_members m WHERE m.league_id = l.league_id AND m.status='active') AS members,
              d.status AS draft_status, d.current_pick_no, d.total_rounds, cu.name AS on_clock_name,
              l.created_at
       FROM fantasy_leagues l
       LEFT JOIN fantasy_drafts d ON d.league_id = l.league_id
       LEFT JOIN "user" cu ON cu.id = d.current_user_id
       WHERE l.is_test = 1 ORDER BY l.created_at DESC`
    )
  ).rows as unknown as Array<{
    league_id: string; slug: string; name: string; status: string; season: string;
    members: number; draft_status: string | null; current_pick_no: number | null;
    total_rounds: number | null; on_clock_name: string | null; created_at: string;
  }>;
  return {
    leagues: rows.map((r) => ({
      leagueId: r.league_id, slug: r.slug, name: r.name, status: r.status,
      season: r.season, members: Number(r.members), createdAt: r.created_at,
      draftStatus: r.draft_status,
      draftProgress:
        r.draft_status === 'live' && r.total_rounds != null
          ? {
              pickNo: Number(r.current_pick_no ?? 0) + 1,
              totalPicks: Number(r.total_rounds) * Number(r.members),
              onClock: r.on_clock_name ?? null,
            }
          : null,
    })),
  };
});

/** Delete a test league + its data + orphan bot users. Cap: manageFantasyLeagues. */
export const adminDeleteTestLeague = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    const league = (
      await db.execute({
        sql: `SELECT slug, is_test FROM fantasy_leagues WHERE league_id = ?`,
        args: [data.leagueId],
      })
    ).rows[0] as { slug?: string; is_test?: number } | undefined;
    if (!league || !league.is_test) throw new Error('NOT_A_TEST_LEAGUE');

    // Bot users that were members of this league (delete only if they belong to no
    // other league after we remove this one's memberships).
    const botIds = (
      await db.execute({
        sql: `SELECT m.user_id FROM fantasy_members m JOIN "user" u ON u.id = m.user_id
              WHERE m.league_id = ? AND u.isBot = 1`,
        args: [data.leagueId],
      })
    ).rows.map((r) => String((r as { user_id: string }).user_id));

    for (const t of ['fantasy_picks', 'fantasy_standings', 'fantasy_members', 'fantasy_drafts',
      'fantasy_scheduled_jobs', 'fantasy_notifications', 'fantasy_quiz_attempts',
      'fantasy_draft_queue', 'fantasy_invites']) {
      await db.execute({ sql: `DELETE FROM ${t} WHERE league_id = ?`, args: [data.leagueId] });
    }
    await db.execute({ sql: `DELETE FROM fantasy_leagues WHERE league_id = ?`, args: [data.leagueId] });
    for (const botId of botIds) {
      const stillMember = (
        await db.execute({ sql: `SELECT 1 FROM fantasy_members WHERE user_id = ? LIMIT 1`, args: [botId] })
      ).rows.length;
      if (!stillMember) await db.execute({ sql: `DELETE FROM "user" WHERE id = ? AND isBot = 1`, args: [botId] });
    }

    await writeAudit(db, actor, { action: 'delete_test_league', target: league.slug ?? data.leagueId });
    return { ok: true as const };
  });

// --- Test Lab P3: drive the draft (start now / force bot picks / fast-forward) ---

const assertTestLeague = async (
  db: Awaited<ReturnType<typeof getContributionsDb>>,
  leagueId: string
): Promise<{ config_json: string }> => {
  const row = (
    await db.execute({
      sql: `SELECT config_json, is_test FROM fantasy_leagues WHERE league_id = ?`,
      args: [leagueId],
    })
  ).rows[0] as { config_json?: string; is_test?: number } | undefined;
  if (!row || !row.is_test) throw new Error('NOT_A_TEST_LEAGUE');
  return { config_json: row.config_json ?? '{}' };
};

/** Schedule (now) + start a test league's draft, bypassing owner/reminders. Cap: manageFantasyLeagues. */
export const adminStartDraftNow = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    const { config_json } = await assertTestLeague(db, data.leagueId);
    const config = JSON.parse(config_json) as LeagueConfig;
    const rounds = CAPTION_KEYS.reduce((s, k) => s + (config.captionCaps?.[k] ?? 0), 0);
    const now = new Date().toISOString();
    // Ensure a 'scheduled' draft row exists (no reminders → no email spam on each test start).
    await db.execute({
      sql: `INSERT INTO fantasy_drafts
              (draft_id, league_id, status, scheduled_at, draft_type, pick_seconds, total_rounds, current_pick_no)
            VALUES (?, ?, 'scheduled', ?, ?, ?, ?, 0)
            ON CONFLICT(league_id) DO UPDATE SET
              scheduled_at = excluded.scheduled_at, draft_type = excluded.draft_type,
              pick_seconds = excluded.pick_seconds, total_rounds = excluded.total_rounds`,
      args: [randomUUID(), data.leagueId, now, config.draftType, config.pickSeconds, rounds],
    });
    await db.execute({
      sql: `UPDATE fantasy_leagues SET status = 'scheduled', updated_at = ? WHERE league_id = ?`,
      args: [now, data.leagueId],
    });
    const result = (await (await loadFantasyRuntime()).runPromise(
      Effect.flatMap(DraftService, (s) => s.start(data.leagueId))
    )) as { ok: boolean; reason?: string };
    await writeAudit(db, actor, { action: 'test_start_draft_now', target: data.leagueId });
    return result.ok ? { ok: true as const } : { ok: false as const, reason: result.reason };
  });

/** Force the current on-clock seat's best legal pick now (drives a bot's turn). Cap: manageFantasyLeagues. */
export const adminAutoPickCurrent = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    await assertTestLeague(db, data.leagueId);
    // No expectedDeadline → runAutoPickIfDue skips the timing guard and picks now.
    await (await loadFantasyRuntime()).runPromise(
      Effect.flatMap(DraftService, (s) => s.runAutoPickIfDue(data.leagueId))
    );
    return { ok: true as const };
  });

/** Auto-pick every remaining seat until the draft completes. Cap: manageFantasyLeagues. */
export const adminFastForwardDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    await assertTestLeague(db, data.leagueId);
    let picks = 0;
    for (let i = 0; i < 600; i++) {
      const draft = (
        await db.execute({
          sql: `SELECT status FROM fantasy_drafts WHERE league_id = ?`,
          args: [data.leagueId],
        })
      ).rows[0] as { status?: string } | undefined;
      if (!draft || draft.status !== 'live') break;
      await (await loadFantasyRuntime()).runPromise(
        Effect.flatMap(DraftService, (s) => s.runAutoPickIfDue(data.leagueId))
      );
      picks++;
    }
    await writeAudit(db, actor, {
      action: 'test_fast_forward_draft',
      target: data.leagueId,
      after: { picks } as unknown,
    });
    return { ok: true as const, picks };
  });

// --- Test Lab P2: quiz seeding ----------------------------------------------

const SAMPLE_QUESTIONS: { q: string; choices: string[]; correct: number; diff: 'easy' | 'medium' | 'hard'; exp: string }[] = [
  { q: 'What does “GE” stand for in drum corps scoring?', choices: ['Group Energy', 'General Effect', 'Guard Ensemble', 'Grand Entrance'], correct: 1, diff: 'easy', exp: 'General Effect rewards the overall emotional and artistic impact.' },
  { q: 'How many on-field performers may a World Class corps have?', choices: ['Up to 100', 'Up to 135', 'Up to 150', 'Unlimited'], correct: 2, diff: 'medium', exp: 'World Class corps may field up to 150 performers.' },
  { q: 'Which section is NOT part of a modern drum corps?', choices: ['Brass', 'Woodwinds', 'Battery percussion', 'Color guard'], correct: 1, diff: 'easy', exp: 'Drum corps use brass and percussion — no woodwinds.' },
  { q: 'Where is the DCI World Championship Finals traditionally held?', choices: ['Pasadena, CA', 'Indianapolis, IN', 'Allentown, PA', 'San Antonio, TX'], correct: 1, diff: 'medium', exp: 'Lucas Oil Stadium in Indianapolis hosts Finals.' },
  { q: 'The “pit” refers to which section?', choices: ['Front-ensemble percussion', 'The drum majors', 'The brass soloists', 'The guard captains'], correct: 0, diff: 'easy', exp: 'The front ensemble (pit) is the stationary percussion at the front sideline.' },
  { q: 'What is the maximum total score in a recap-style fantasy league here?', choices: ['50', '100', '200', 'No cap'], correct: 1, diff: 'medium', exp: 'Recap mode is a weighted average capped at 100.' },
  { q: 'Which caption family does “MB” belong to?', choices: ['Music', 'Visual', 'General Effect', 'Guard'], correct: 0, diff: 'easy', exp: 'MB = Music Brass.' },
  { q: 'A “snake” draft means…', choices: ['Order reverses each round', 'Owner picks twice', 'Random every pick', 'Fastest typer wins'], correct: 0, diff: 'easy', exp: 'Snake reverses the pick order every round to keep it fair.' },
  { q: 'Which is a real DCI corps?', choices: ['Bluecoats', 'Blue Thunder FC', 'Sky Ravens', 'The Octets'], correct: 0, diff: 'medium', exp: 'Bluecoats are a World Class corps from Canton, OH.' },
  { q: 'What does the color guard primarily use?', choices: ['Flags, rifles, sabres', 'Trumpets', 'Snare drums', 'Keyboards'], correct: 0, diff: 'easy', exp: 'The guard performs with flags, rifles, and sabres.' },
  { q: 'How many judged captions feed a corps’ score in this game?', choices: ['Four', 'Six', 'Eight', 'Ten'], correct: 2, diff: 'hard', exp: 'Eight captions: GE1, GE2, VP, VA, CG, MB, MA, MP.' },
  { q: 'Open Class corps differ from World Class mainly by…', choices: ['Size/resources', 'Instrument type', 'Field shape', 'Time of year'], correct: 0, diff: 'hard', exp: 'Open Class corps are typically smaller programs than World Class.' },
];

/** Seed a starter quiz bank (idempotent — fixed ids). Cap: manageFantasyLeagues. */
export const adminSeedQuizQuestions = createServerFn({ method: 'POST' }).handler(async () => {
  const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
  const db = await getContributionsDb();
  const now = new Date().toISOString();
  let added = 0;
  for (let i = 0; i < SAMPLE_QUESTIONS.length; i++) {
    const s = SAMPLE_QUESTIONS[i];
    const res = await db.execute({
      sql: `INSERT INTO fantasy_quiz_questions
              (question_id, prompt, choices_json, correct_index, explanation, difficulty,
               tags_json, active, author_user_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, '["sample"]', 1, ?, ?, ?)
            ON CONFLICT(question_id) DO NOTHING`,
      args: [`seed-q${i + 1}`, s.q, JSON.stringify(s.choices), s.correct, s.exp, s.diff, actor.userId, now, now],
    });
    added += Number(res.rowsAffected ?? 0);
  }
  await writeAudit(db, actor, { action: 'seed_quiz_questions', after: { added } as unknown });
  return { ok: true as const, added, total: SAMPLE_QUESTIONS.length };
});

/** Clear the admin's own quiz attempt for a test league so they can re-take. Cap: manageFantasyLeagues. */
export const adminResetQuizAttempt = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    await assertTestLeague(db, data.leagueId);
    await db.execute({
      sql: `DELETE FROM fantasy_quiz_attempts WHERE league_id = ? AND user_id = ?`,
      args: [data.leagueId, actor.userId],
    });
    await db.execute({
      sql: `UPDATE fantasy_members SET quiz_score = NULL WHERE league_id = ? AND user_id = ?`,
      args: [data.leagueId, actor.userId],
    });
    return { ok: true as const };
  });

// --- Test Lab P4: synthetic standings scores --------------------------------

interface SynthAgg {
  perCaption: Record<string, number>;
  contributions: Record<string, Array<{ corpsKey: string; value: number; weight: number }>>;
  ge: number;
  visual: number;
  music: number;
}

/**
 * Inject believable standings from the league's actual picks so the standings UI
 * is testable without real recap data. Each drafted corps gets a deterministic
 * caption score (stable per corps) × the pick weight. `final` locks the table.
 * Cap: manageFantasyLeagues.
 */
export const adminSeedSyntheticScores = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(v.object({ leagueId: v.string(), final: v.optional(v.boolean(), false) }), d)
  )
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    await assertTestLeague(db, data.leagueId);
    const now = new Date().toISOString();

    const picks = (
      await db.execute({
        sql: `SELECT user_id, corps_key, caption, weight FROM fantasy_picks WHERE league_id = ?`,
        args: [data.leagueId],
      })
    ).rows as unknown as Array<{ user_id: string; corps_key: string; caption: string; weight: number }>;
    if (picks.length === 0) throw new Error('NO_PICKS:run the draft first');

    // Stable pseudo-score per corps in ~[70.0, 92.9].
    const corpsScore = (k: string): number => {
      let h = 0;
      for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0;
      return Math.round((70 + (h % 230) / 10) * 10) / 10;
    };

    const byUser = new Map<string, SynthAgg>();
    for (const p of picks) {
      const e: SynthAgg =
        byUser.get(p.user_id) ?? { perCaption: {}, contributions: {}, ge: 0, visual: 0, music: 0 };
      const val = Math.round(corpsScore(p.corps_key) * Number(p.weight) * 10) / 10;
      e.perCaption[p.caption] = Math.round(((e.perCaption[p.caption] ?? 0) + val) * 10) / 10;
      (e.contributions[p.caption] ??= []).push({
        corpsKey: p.corps_key, value: val, weight: Number(p.weight),
      });
      const cat = CAPTION_CATEGORY[p.caption as CaptionKey] ?? 'ge';
      e[cat] = Math.round((e[cat] + val) * 10) / 10;
      byUser.set(p.user_id, e);
    }

    const rows = [...byUser.entries()]
      .map(([userId, e]) => ({ userId, total: Math.round((e.ge + e.visual + e.music) * 10) / 10, e }))
      .sort((a, b) => b.total - a.total);

    let rank = 1;
    for (const r of rows) {
      await db.execute({
        sql: `INSERT INTO fantasy_standings
                (league_id, user_id, through_competition_slug, total_score, ge_score, visual_score,
                 music_score, breakdown_json, rank, computed_at, is_final)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(league_id, user_id) DO UPDATE SET
                through_competition_slug = excluded.through_competition_slug,
                total_score = excluded.total_score, ge_score = excluded.ge_score,
                visual_score = excluded.visual_score, music_score = excluded.music_score,
                breakdown_json = excluded.breakdown_json, rank = excluded.rank,
                computed_at = excluded.computed_at, is_final = excluded.is_final`,
        args: [
          data.leagueId, r.userId, data.final ? 'test-finals' : null, r.total, r.e.ge,
          r.e.visual, r.e.music,
          JSON.stringify({ perCaption: r.e.perCaption, contributions: r.e.contributions }),
          rank, now, data.final ? 1 : 0,
        ],
      });
      rank++;
    }
    await writeAudit(db, actor, {
      action: 'seed_synthetic_scores',
      target: data.leagueId,
      after: { members: rows.length, final: data.final } as unknown,
    });
    return { ok: true as const, members: rows.length };
  });

// --- Test Lab P6: notification preview (send a template to the admin only) ---

const PREVIEW_LEAGUE = 'Test League';
const TEST_NOTIF: Record<
  string,
  { label: string; email?: { subject: string; html: string }; push?: { title: string; body: string } }
> = {
  draft_scheduled: {
    label: 'Draft scheduled (email)',
    email: {
      subject: `Draft scheduled — ${PREVIEW_LEAGUE}`,
      html: `<p>The draft for <strong>${PREVIEW_LEAGUE}</strong> is set for <strong>${new Date().toUTCString()}</strong>. Open the app for a local countdown, and be in the draft room when it starts.</p>`,
    },
  },
  draft_live: {
    label: 'Draft live (email + push)',
    email: {
      subject: `Your ${PREVIEW_LEAGUE} draft is live`,
      html: `<p>The draft room for <strong>${PREVIEW_LEAGUE}</strong> is open — come make your picks before your timer runs out.</p>`,
    },
    push: { title: 'Your draft is live', body: 'The draft room is open — come watch and make your picks.' },
  },
  draft_complete: {
    label: 'Draft complete (email + push)',
    email: {
      subject: `Your ${PREVIEW_LEAGUE} draft is complete`,
      html: `<p>Every pick is in for <strong>${PREVIEW_LEAGUE}</strong>. See the final rosters and follow the standings as the season scores.</p>`,
    },
    push: { title: 'Draft complete', body: 'Every pick is in — see the final rosters and the standings.' },
  },
  on_clock: {
    label: 'On the clock (push)',
    push: { title: "You're on the clock", body: 'Make your fantasy draft pick before the timer runs out.' },
  },
  on_deck: {
    label: 'On deck (push)',
    push: { title: "You're on deck", body: "You're up right after the current pick — get your corps ready." },
  },
  standings: {
    label: 'Standings updated (email)',
    email: {
      subject: `Standings updated — ${PREVIEW_LEAGUE}`,
      html: `<p>Standings just updated after the latest recap for <strong>${PREVIEW_LEAGUE}</strong>. Open the app to see where your corps landed.</p>`,
    },
  },
};

/** Send one notification template to the ADMIN only, to preview copy. Cap: manageFantasyLeagues. */
export const adminSendTestNotification = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(v.object({ kind: v.picklist(Object.keys(TEST_NOTIF) as [string, ...string[]]) }), d)
  )
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyLeagues');
    const db = await getContributionsDb();
    const tpl = TEST_NOTIF[data.kind];
    const me = (
      await db.execute({ sql: `SELECT email FROM "user" WHERE id = ?`, args: [actor.userId] })
    ).rows[0] as { email?: string } | undefined;

    let emailedTo: string | null = null;
    let pushed = false;
    if (tpl.email && me?.email) {
      await sendEmail({
        to: me.email,
        subject: `[TEST] ${tpl.email.subject}`,
        html: tpl.email.html,
        tag: 'fantasy_test_preview',
      });
      emailedTo = me.email;
    }
    if (tpl.push) {
      await sendPushToUser(actor.userId, { ...tpl.push, url: '/admin/fantasy/test-lab' }).catch(() => {});
      pushed = true;
    }
    await writeAudit(db, actor, { action: 'test_send_notification', target: data.kind });
    return { ok: true as const, emailedTo, pushed };
  });
