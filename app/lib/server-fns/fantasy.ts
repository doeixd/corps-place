/**
 * Fantasy DCI server functions — leagues, invites, membership, corps identity
 * (Fantasy DCI plan Appendix F.1, milestone M1).
 *
 * Conventions (plan §0.5): UUID string ids, ISO-8601 UTC timestamps, raw libsql
 * on `contributions.db`, valibot re-validation server-side, `getActor` authz on
 * every write, durable-storage fail-closed (I-7). Errors throw with the exact
 * messages `UNAUTHENTICATED` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT[:reason]` so
 * routes can branch on them.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import type { Client, Row } from '@libsql/client';
import { Effect } from 'effect';
import * as v from 'valibot';
import { LeagueService } from '@/lib/fantasy/services/league-service';
import { StandingsService } from '@/lib/fantasy/services/standings-service';
import { provideFantasy } from '@/rpc';
import { getContributionsDb, durableStorageStatus } from '@/lib/contributions-db';
import { getActor, requireCapability, type Actor } from '@/lib/authz';
import {
  DEFAULT_CONFIG,
  resolveLeagueConfig,
  totalRounds,
  draftShapeChanged,
  type LeagueConfig,
} from '@/lib/fantasy/config';
import {
  planQuestionCounts,
  scoreQuiz,
  type Difficulty,
  type ServedQuestion,
} from '@/lib/fantasy/quiz';
import { seededShuffle } from '@/lib/fantasy/draft-order';
import { getDraftPool, getSeasonFinals } from '@/lib/fantasy/score-db';
import * as draftEngine from '@/lib/fantasy/draft-engine';
import { enqueueDraftReminders } from '@/lib/fantasy/jobs';
import { vapidPublicKey } from '@/lib/fantasy/push';
import {
  paymentsEnabled,
  createLeagueCheckoutSession,
  refundPaymentIntent,
} from '@/lib/fantasy/payments';
import {
  makeLeagueSlug,
  mintInviteToken,
  isoPlusDays,
  DEFAULT_INVITE_DAYS,
} from '@/lib/fantasy/invites';
import { sendEmail } from '@/lib/email';
import { rateLimit } from '@/lib/rate-limit';

// League statuses that still allow new members to join (§7.3).
const JOINABLE = new Set(['setup', 'quiz', 'scheduled']);

/** Throw a uniform CONFLICT when a per-user action exceeds its rate budget (§13). */
const limitPerUser = (action: string, userId: string, max: number, windowMs = 60_000): void => {
  if (!rateLimit(`${action}:${userId}`, max, windowMs)) throw new Error('CONFLICT:rate-limited');
};

const siteOrigin = (): string =>
  (process.env.BETTER_AUTH_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

// libsql Row cells are typed `Value` (string|number|bigint|ArrayBuffer|null),
// which isn't JSON-serializable for a server-fn return. These casts read a cell
// as a known primitive (our columns only ever hold text/int/null) and keep the
// `no-base-to-string` lint quiet (no String()/template coercion of a wide type).
const str = (v: unknown): string => v as string;
const strOrNull = (v: unknown): string | null => (v == null ? null : (v as string));

// ---------------------------------------------------------------------------
// shared guards
// ---------------------------------------------------------------------------

const requireActor = async (): Promise<Actor> => {
  const actor = await getActor(getWebRequest());
  if (!actor) throw new Error('UNAUTHENTICATED');
  return actor;
};

/** Fail closed when the durable volume is missing (I-7) — never write to ephemeral FS. */
const assertDurable = (): void => {
  const status = durableStorageStatus();
  if (!status.ready) throw new Error(`STORAGE_UNAVAILABLE: ${status.reason}`);
};

const loadLeagueById = async (db: Client, leagueId: string): Promise<Row> => {
  const row = (
    await db.execute({ sql: 'SELECT * FROM fantasy_leagues WHERE league_id = ?', args: [leagueId] })
  ).rows[0];
  if (!row) throw new Error('NOT_FOUND');
  return row;
};

const requireOwner = async (db: Client, leagueId: string, actor: Actor): Promise<Row> => {
  const league = await loadLeagueById(db, leagueId);
  if (league.owner_user_id !== actor.userId) throw new Error('FORBIDDEN');
  return league;
};

const requireMember = async (db: Client, leagueId: string, actor: Actor): Promise<Row> => {
  const row = (
    await db.execute({
      sql: "SELECT * FROM fantasy_members WHERE league_id = ? AND user_id = ? AND status = 'active'",
      args: [leagueId, actor.userId],
    })
  ).rows[0];
  if (!row) throw new Error('FORBIDDEN');
  return row;
};

/** When payments are live, a league must be paid before it can invite/draft (§12.2). */
const requirePaid = (league: Row): void => {
  if (paymentsEnabled() && str(league.payment_status) !== 'paid')
    throw new Error('CONFLICT:unpaid');
};

const activeMemberCount = async (db: Client, leagueId: string): Promise<number> => {
  const row = (
    await db.execute({
      sql: "SELECT COUNT(*) AS n FROM fantasy_members WHERE league_id = ? AND status = 'active'",
      args: [leagueId],
    })
  ).rows[0];
  return Number(row?.n ?? 0);
};

// ---------------------------------------------------------------------------
// leagues
// ---------------------------------------------------------------------------

const CreateLeagueInput = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Name required'), v.maxLength(60)),
  season: v.pipe(v.string(), v.regex(/^\d{4}$/, 'Season must be a 4-digit year')),
  config: v.optional(v.unknown()),
});

export const createLeague = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreateLeagueInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    limitPerUser('league-create', actor.userId, 5);
    assertDurable();
    const db = await getContributionsDb();

    const config: LeagueConfig = data.config
      ? resolveLeagueConfig(data.config as Partial<LeagueConfig>)
      : DEFAULT_CONFIG;

    const leagueId = crypto.randomUUID();
    const slug = makeLeagueSlug(data.name);
    const now = new Date().toISOString();

    await db.batch(
      [
        {
          sql: `INSERT INTO fantasy_leagues
                  (league_id, slug, name, owner_user_id, season, status, config_json,
                   max_members, payment_status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'setup', ?, 12, 'none', ?, ?)`,
          args: [
            leagueId,
            slug,
            data.name,
            actor.userId,
            data.season,
            JSON.stringify(config),
            now,
            now,
          ],
        },
        {
          sql: `INSERT INTO fantasy_members (league_id, user_id, role, status, joined_at)
                VALUES (?, ?, 'owner', 'active', ?)`,
          args: [leagueId, actor.userId, now],
        },
      ],
      'write'
    );

    return { ok: true as const, leagueId, slug };
  });

// Strangler shim (migration plan P0): the handler stays a thin `createServerFn`
// boundary but delegates to `LeagueService` over the Effect/SqlClient path
// (`runPromise` lives only here, at the boundary, per AGENTS.md). The actor is
// resolved here and passed in; the returned payload is identical to the legacy
// raw-SQL version. A failed `NotFound` is re-thrown as the legacy `NOT_FOUND`
// string so route branching is unchanged during the strangler.
export const getLeague = createServerFn({ method: 'GET' })
  .validator((d: { slug: string }) => v.parse(v.object({ slug: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    const program = Effect.flatMap(LeagueService, (svc) =>
      svc.get({ slug: data.slug, viewerUserId: actor?.userId ?? null })
    ).pipe(
      provideFantasy,
      Effect.catchTag('NotFound', () => Effect.fail(new Error('NOT_FOUND')))
    );
    return Effect.runPromise(program);
  });

// Strangler shim (P1): delegates to LeagueService over the Effect path.
export const listMyLeagues = createServerFn({ method: 'GET' }).handler(async () => {
  const actor = await requireActor();
  const program = Effect.flatMap(LeagueService, (svc) => svc.listMyLeagues(actor.userId)).pipe(
    provideFantasy
  );
  return Effect.runPromise(program);
});

const UpdateConfigInput = v.object({ leagueId: v.string(), config: v.unknown() });

export const updateLeagueConfig = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UpdateConfigInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    const league = await requireOwner(db, data.leagueId, actor);
    const current = JSON.parse(str(league.config_json)) as LeagueConfig;
    const next = resolveLeagueConfig(data.config as Partial<LeagueConfig>);

    // Draft-shape fields freeze once the draft is past 'scheduled' (§6); only
    // `weights` (and notify prefs) stay editable after that.
    const draftStarted = Boolean(
      (
        await db.execute({
          sql: "SELECT 1 FROM fantasy_drafts WHERE league_id = ? AND status != 'scheduled' LIMIT 1",
          args: [data.leagueId],
        })
      ).rows[0]
    );
    if (draftStarted && draftShapeChanged(current, next)) {
      throw new Error('CONFLICT:draft-shape-locked');
    }

    // Scoring weights are editable until finals week, then locked (§16 V3).
    const weightsChanged = JSON.stringify(current.weights) !== JSON.stringify(next.weights);
    if (weightsChanged && next.weightsLockedAt === 'finals_week') {
      const finals = await getSeasonFinals(str(league.season));
      const locked = Boolean(
        finals && finals.recapPresent && new Date().toISOString() >= finals.date
      );
      if (locked) throw new Error('CONFLICT:weights-locked');
    }

    const now = new Date().toISOString();
    await db.execute({
      sql: 'UPDATE fantasy_leagues SET config_json = ?, updated_at = ? WHERE league_id = ?',
      args: [JSON.stringify(next), now, str(league.league_id)],
    });
    return { ok: true as const };
  });

// ---------------------------------------------------------------------------
// invites
// ---------------------------------------------------------------------------

const CreateInviteInput = v.object({
  leagueId: v.string(),
  email: v.optional(v.pipe(v.string(), v.email())),
  maxUses: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
  expiresInDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(90))),
});

export const createInvite = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreateInviteInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    limitPerUser('invite-create', actor.userId, 30);
    const db = await getContributionsDb();
    const league = await requireOwner(db, data.leagueId, actor);
    requirePaid(league);
    const leagueName = str(league.name);

    const inviteId = crypto.randomUUID();
    const token = mintInviteToken();
    const now = new Date().toISOString();
    const expiresAt = isoPlusDays(now, data.expiresInDays ?? DEFAULT_INVITE_DAYS);

    await db.execute({
      sql: `INSERT INTO fantasy_invites
              (invite_id, league_id, token, created_by, email, max_uses, used_count, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      args: [
        inviteId,
        data.leagueId,
        token,
        actor.userId,
        data.email ?? null,
        data.maxUses ?? 1,
        expiresAt,
        now,
      ],
    });

    const url = `${siteOrigin()}/fantasy/join/${token}`;
    if (data.email) {
      await sendEmail({
        to: data.email,
        subject: `You're invited to ${leagueName} — Fantasy DCI`,
        html: `<p>You've been invited to join the fantasy drum corps league <strong>${escapeHtml(leagueName)}</strong>.</p>
               <p><a href="${url}">Accept your invite</a></p>
               <p>This link expires on ${expiresAt.slice(0, 10)}.</p>`,
        tag: 'fantasy_invite',
      });
    }

    return { ok: true as const, token, url };
  });

export const revokeInvite = createServerFn({ method: 'POST' })
  .validator((d: { inviteId: string }) => v.parse(v.object({ inviteId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    const invite = (
      await db.execute({
        sql: 'SELECT league_id FROM fantasy_invites WHERE invite_id = ?',
        args: [data.inviteId],
      })
    ).rows[0];
    if (!invite) throw new Error('NOT_FOUND');
    await requireOwner(db, str(invite.league_id), actor);
    await db.execute({
      sql: 'UPDATE fantasy_invites SET revoked_at = ? WHERE invite_id = ?',
      args: [new Date().toISOString(), data.inviteId],
    });
    return { ok: true as const };
  });

/** Public loader read: validate a token and describe the invite (no token echoed back). */
export const getInvite = createServerFn({ method: 'GET' })
  .validator((d: { token: string }) => v.parse(v.object({ token: v.string() }), d))
  .handler(async ({ data }) => {
    const db = await getContributionsDb();
    const invite = (
      await db.execute({
        sql: 'SELECT * FROM fantasy_invites WHERE token = ?',
        args: [data.token],
      })
    ).rows[0];
    if (!invite) return { state: 'invalid' as const };

    const now = new Date().toISOString();
    if (invite.revoked_at) return { state: 'invalid' as const };
    if (str(invite.expires_at) <= now) return { state: 'invalid' as const };
    if (Number(invite.used_count) >= Number(invite.max_uses)) return { state: 'used_up' as const };

    const league = (
      await db.execute({
        sql: 'SELECT name, slug, status, max_members FROM fantasy_leagues WHERE league_id = ?',
        args: [invite.league_id],
      })
    ).rows[0];
    if (!league) return { state: 'invalid' as const };
    if (!JOINABLE.has(str(league.status))) return { state: 'closed' as const };

    const memberCount = await activeMemberCount(db, str(invite.league_id));
    return {
      state: 'ok' as const,
      league: {
        name: str(league.name),
        slug: str(league.slug),
        memberCount,
        maxMembers: Number(league.max_members),
      },
    };
  });

const AcceptInviteInput = v.object({
  token: v.string(),
  // Same bounds as setCorpsIdentity — the accept path writes straight to the member row.
  corpsName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(40))),
  showTitle: v.optional(v.pipe(v.string(), v.maxLength(80))),
  color: v.optional(v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb color'))),
  logoMediaId: v.optional(v.pipe(v.string(), v.maxLength(64))),
});

export const acceptInvite = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(AcceptInviteInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    limitPerUser('invite-accept', actor.userId, 15);
    assertDurable();
    const db = await getContributionsDb();
    const now = new Date().toISOString();

    const invite = (
      await db.execute({ sql: 'SELECT * FROM fantasy_invites WHERE token = ?', args: [data.token] })
    ).rows[0];
    if (!invite) throw new Error('NOT_FOUND');
    const inviteId = str(invite.invite_id);
    const leagueId = str(invite.league_id);

    // Race-safe seat claim (Appendix G.3): atomically consume one use.
    const claim = await db.execute({
      sql: `UPDATE fantasy_invites SET used_count = used_count + 1
            WHERE token = ? AND revoked_at IS NULL AND expires_at > ? AND used_count < max_uses`,
      args: [data.token, now],
    });
    if (claim.rowsAffected !== 1) throw new Error('CONFLICT:used-up');

    // Anything past this point that fails must release the claimed seat.
    const releaseSeat = () =>
      db.execute({
        sql: 'UPDATE fantasy_invites SET used_count = used_count - 1 WHERE invite_id = ?',
        args: [inviteId],
      });

    try {
      const league = await loadLeagueById(db, leagueId);
      if (!JOINABLE.has(str(league.status))) throw new Error('CONFLICT:draft-started');

      const existing = (
        await db.execute({
          sql: 'SELECT corps_name, status FROM fantasy_members WHERE league_id = ? AND user_id = ?',
          args: [leagueId, actor.userId],
        })
      ).rows[0];

      if (existing && existing.status === 'active') {
        // Already in — re-click is a no-op; we didn't consume a seat.
        await releaseSeat();
        return {
          ok: true as const,
          already: true,
          leagueId,
          slug: str(league.slug),
          needsIdentity: existing.corps_name == null,
        };
      }

      if ((await activeMemberCount(db, leagueId)) >= Number(league.max_members)) {
        throw new Error('CONFLICT:full');
      }

      const corpsName = data.corpsName?.trim() || null;
      if (existing) {
        // Re-activate a previously-removed member.
        await db.execute({
          sql: `UPDATE fantasy_members
                SET status = 'active', corps_name = COALESCE(?, corps_name),
                    show_title = COALESCE(?, show_title), corps_color = COALESCE(?, corps_color),
                    corps_logo_media_id = COALESCE(?, corps_logo_media_id)
                WHERE league_id = ? AND user_id = ?`,
          args: [
            corpsName,
            data.showTitle ?? null,
            data.color ?? null,
            data.logoMediaId ?? null,
            leagueId,
            actor.userId,
          ],
        });
      } else {
        await db.execute({
          sql: `INSERT INTO fantasy_members
                  (league_id, user_id, role, corps_name, show_title, corps_color, corps_logo_media_id, status, joined_at)
                VALUES (?, ?, 'member', ?, ?, ?, ?, 'active', ?)`,
          args: [
            leagueId,
            actor.userId,
            corpsName,
            data.showTitle ?? null,
            data.color ?? null,
            data.logoMediaId ?? null,
            now,
          ],
        });
      }

      return {
        ok: true as const,
        already: false,
        leagueId,
        slug: str(league.slug),
        needsIdentity: corpsName == null,
      };
    } catch (err) {
      await releaseSeat();
      throw err;
    }
  });

// ---------------------------------------------------------------------------
// corps identity / membership
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const SetIdentityInput = v.object({
  leagueId: v.string(),
  corpsName: v.pipe(v.string(), v.trim(), v.minLength(1, 'Corps name required'), v.maxLength(40)),
  showTitle: v.optional(v.pipe(v.string(), v.maxLength(80)), ''),
  color: v.optional(v.pipe(v.string(), v.regex(HEX_COLOR, 'Use a #rrggbb color'))),
  logoMediaId: v.optional(v.string()),
});

export const setCorpsIdentity = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SetIdentityInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    await requireMember(db, data.leagueId, actor);

    // Corps name must be unique within the league (case-insensitive), excluding self.
    const clash = (
      await db.execute({
        sql: `SELECT 1 FROM fantasy_members
              WHERE league_id = ? AND user_id != ? AND status = 'active'
                AND lower(corps_name) = lower(?) LIMIT 1`,
        args: [data.leagueId, actor.userId, data.corpsName],
      })
    ).rows[0];
    if (clash) throw new Error('CONFLICT:name-taken');

    await db.execute({
      sql: `UPDATE fantasy_members
            SET corps_name = ?, show_title = ?, corps_color = ?, corps_logo_media_id = COALESCE(?, corps_logo_media_id)
            WHERE league_id = ? AND user_id = ?`,
      args: [
        data.corpsName,
        data.showTitle ?? '',
        data.color ?? null,
        data.logoMediaId ?? null,
        data.leagueId,
        actor.userId,
      ],
    });
    return { ok: true as const };
  });

const RemoveMemberInput = v.object({ leagueId: v.string(), userId: v.string() });

export const removeMember = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(RemoveMemberInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    const league = await requireOwner(db, data.leagueId, actor);
    // Pre-draft only (no draft row yet in M1, but guard for forward-compat).
    const draft = (
      await db.execute({
        sql: "SELECT status FROM fantasy_drafts WHERE league_id = ? AND status != 'scheduled'",
        args: [data.leagueId],
      })
    ).rows[0];
    if (draft) throw new Error('CONFLICT:draft-started');
    if (data.userId === str(league.owner_user_id)) throw new Error('CONFLICT:cannot-remove-owner');

    await db.execute({
      sql: "UPDATE fantasy_members SET status = 'removed' WHERE league_id = ? AND user_id = ?",
      args: [data.leagueId, data.userId],
    });
    return { ok: true as const };
  });

// Minimal HTML escape for values interpolated into invite emails.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===========================================================================
// QUIZ — admin bank CRUD (capability manageFantasyQuiz) + member run (M2)
// ===========================================================================

const GRACE_SECONDS = 30;

const auditFantasy = async (
  db: Client,
  actorId: string,
  action: string,
  leagueId: string | null,
  before: unknown,
  after: unknown
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO fantasy_admin_audit (audit_id, actor_user_id, action, league_id, before_json, after_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      actorId,
      action,
      leagueId,
      before == null ? null : JSON.stringify(before),
      after == null ? null : JSON.stringify(after),
      new Date().toISOString(),
    ],
  });
};

// ---- admin: list / upsert / activate questions --------------------------------

export const adminListQuestions = createServerFn({ method: 'GET' }).handler(async () => {
  await requireCapability(getWebRequest(), 'manageFantasyQuiz');
  const db = await getContributionsDb();
  const rows = (
    await db.execute({
      sql: `SELECT question_id, prompt, choices_json, correct_index, explanation, difficulty,
                   tags_json, active, created_at, updated_at
            FROM fantasy_quiz_questions ORDER BY created_at DESC`,
    })
  ).rows.map((q) => ({
    questionId: str(q.question_id),
    prompt: str(q.prompt),
    choices: JSON.parse(str(q.choices_json)) as string[],
    correctIndex: Number(q.correct_index),
    explanation: strOrNull(q.explanation),
    difficulty: str(q.difficulty) as Difficulty,
    tags: JSON.parse(str(q.tags_json)) as string[],
    active: Boolean(q.active),
  }));
  return { questions: rows };
});

const QuestionInput = v.object({
  questionId: v.optional(v.string()),
  prompt: v.pipe(v.string(), v.trim(), v.minLength(1, 'Prompt required'), v.maxLength(500)),
  choices: v.pipe(
    v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
    v.minLength(2, 'At least 2 choices'),
    v.maxLength(6, 'At most 6 choices')
  ),
  correctIndex: v.pipe(v.number(), v.integer(), v.minValue(0)),
  explanation: v.optional(v.pipe(v.string(), v.maxLength(1000)), ''),
  difficulty: v.picklist(['easy', 'medium', 'hard'] as const),
  tags: v.optional(v.array(v.pipe(v.string(), v.trim())), []),
});

export const adminUpsertQuestion = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(QuestionInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyQuiz');
    assertDurable();
    if (data.correctIndex >= data.choices.length) throw new Error('CONFLICT:bad-correct-index');
    const db = await getContributionsDb();
    const now = new Date().toISOString();
    const questionId = data.questionId ?? crypto.randomUUID();
    const choicesJson = JSON.stringify(data.choices);
    const tagsJson = JSON.stringify(data.tags ?? []);

    if (data.questionId) {
      await db.execute({
        sql: `UPDATE fantasy_quiz_questions
              SET prompt = ?, choices_json = ?, correct_index = ?, explanation = ?,
                  difficulty = ?, tags_json = ?, updated_at = ?
              WHERE question_id = ?`,
        args: [
          data.prompt,
          choicesJson,
          data.correctIndex,
          data.explanation ?? '',
          data.difficulty,
          tagsJson,
          now,
          questionId,
        ],
      });
    } else {
      await db.execute({
        sql: `INSERT INTO fantasy_quiz_questions
                (question_id, prompt, choices_json, correct_index, explanation, difficulty,
                 tags_json, active, author_user_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        args: [
          questionId,
          data.prompt,
          choicesJson,
          data.correctIndex,
          data.explanation ?? '',
          data.difficulty,
          tagsJson,
          actor.userId,
          now,
          now,
        ],
      });
    }
    await auditFantasy(
      db,
      actor.userId,
      data.questionId ? 'quiz.update' : 'quiz.create',
      null,
      null,
      {
        questionId,
      }
    );
    return { ok: true as const, questionId };
  });

export const adminSetQuestionActive = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ questionId: v.string(), active: v.boolean() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyQuiz');
    assertDurable();
    const db = await getContributionsDb();
    await db.execute({
      sql: 'UPDATE fantasy_quiz_questions SET active = ?, updated_at = ? WHERE question_id = ?',
      args: [data.active ? 1 : 0, new Date().toISOString(), data.questionId],
    });
    await auditFantasy(db, actor.userId, 'quiz.setActive', null, null, {
      questionId: data.questionId,
      active: data.active,
    });
    return { ok: true as const };
  });

// ---- member: take the quiz (served set has NO correct answers) -----------------

type LeagueQuizConfig = LeagueConfig['quiz'];

export const getQuizForLeague = createServerFn({ method: 'GET' })
  .validator((d: { leagueId: string }) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    const db = await getContributionsDb();
    await requireMember(db, data.leagueId, actor);

    const league = await loadLeagueById(db, data.leagueId);
    const config = JSON.parse(str(league.config_json)) as LeagueConfig;
    const quizCfg: LeagueQuizConfig = config.quiz;
    if (!quizCfg.enabled) return { state: 'disabled' as const };

    // Already completed? (one scored attempt per member, §A9.)
    const done = (
      await db.execute({
        sql: 'SELECT weighted_score FROM fantasy_quiz_attempts WHERE league_id = ? AND user_id = ? AND completed_at IS NOT NULL',
        args: [data.leagueId, actor.userId],
      })
    ).rows[0];
    if (done) return { state: 'done' as const, weightedScore: Number(done.weighted_score) };

    // Resume an in-progress attempt, else create one.
    let attempt = (
      await db.execute({
        sql: 'SELECT * FROM fantasy_quiz_attempts WHERE league_id = ? AND user_id = ? AND completed_at IS NULL',
        args: [data.leagueId, actor.userId],
      })
    ).rows[0];

    let startedAt: string;
    let questionIds: string[];
    if (attempt) {
      startedAt = str(attempt.started_at);
      questionIds = JSON.parse(str(attempt.question_ids_json)) as string[];
    } else {
      // Compose a fresh served set (E.3).
      const active = (
        await db.execute({
          sql: 'SELECT question_id, difficulty FROM fantasy_quiz_questions WHERE active = 1',
        })
      ).rows.map((r) => ({ id: str(r.question_id), difficulty: str(r.difficulty) as Difficulty }));
      if (active.length === 0) return { state: 'unavailable' as const };

      const byDiff = {
        easy: active.filter((q) => q.difficulty === 'easy').map((q) => q.id),
        medium: active.filter((q) => q.difficulty === 'medium').map((q) => q.id),
        hard: active.filter((q) => q.difficulty === 'hard').map((q) => q.id),
      };
      const counts = planQuestionCounts(quizCfg.questionCount, {
        easy: byDiff.easy.length,
        medium: byDiff.medium.length,
        hard: byDiff.hard.length,
      });
      const seed = `${data.leagueId}:${actor.userId}`;
      const pick = (ids: string[], n: number) => seededShuffle(ids, seed).slice(0, n);
      questionIds = seededShuffle(
        [
          ...pick(byDiff.easy, counts.easy),
          ...pick(byDiff.medium, counts.medium),
          ...pick(byDiff.hard, counts.hard),
        ],
        seed
      );

      startedAt = new Date().toISOString();
      const attemptId = crypto.randomUUID();
      await db.execute({
        sql: `INSERT INTO fantasy_quiz_attempts
                (attempt_id, league_id, user_id, question_ids_json, answers_json, started_at)
              VALUES (?, ?, ?, ?, '[]', ?)`,
        args: [attemptId, data.leagueId, actor.userId, JSON.stringify(questionIds), startedAt],
      });
      attempt = (
        await db.execute({
          sql: 'SELECT * FROM fantasy_quiz_attempts WHERE attempt_id = ?',
          args: [attemptId],
        })
      ).rows[0];
    }

    // Hydrate prompts + choices ONLY (never correct_index) in served order.
    const rows = (
      await db.execute({
        sql: `SELECT question_id, prompt, choices_json FROM fantasy_quiz_questions WHERE question_id IN (${questionIds.map(() => '?').join(',')})`,
        args: questionIds,
      })
    ).rows;
    const byId = new Map(rows.map((r) => [str(r.question_id), r]));
    const questions = questionIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => ({
        questionId: str(r.question_id),
        prompt: str(r.prompt),
        choices: JSON.parse(str(r.choices_json)) as string[],
      }));

    const endsAt = new Date(
      new Date(startedAt).getTime() + questionIds.length * quizCfg.perQuestionSeconds * 1000
    ).toISOString();

    return {
      state: 'in_progress' as const,
      attemptId: str(attempt.attempt_id),
      questions,
      startedAt,
      endsAt,
    };
  });

export const submitQuiz = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(v.object({ leagueId: v.string(), answers: v.array(v.number()) }), d)
  )
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    await requireMember(db, data.leagueId, actor);

    const attempt = (
      await db.execute({
        sql: 'SELECT * FROM fantasy_quiz_attempts WHERE league_id = ? AND user_id = ? AND completed_at IS NULL',
        args: [data.leagueId, actor.userId],
      })
    ).rows[0];
    if (!attempt) throw new Error('CONFLICT:no-attempt');

    const league = await loadLeagueById(db, data.leagueId);
    const config = JSON.parse(str(league.config_json)) as LeagueConfig;
    const perQuestionSeconds = config.quiz.perQuestionSeconds;

    const questionIds = JSON.parse(str(attempt.question_ids_json)) as string[];
    const startedAt = str(attempt.started_at);
    const elapsedSec = (Date.now() - new Date(startedAt).getTime()) / 1000;
    if (elapsedSec > questionIds.length * perQuestionSeconds + GRACE_SECONDS) {
      throw new Error('CONFLICT:expired');
    }

    // Load difficulty + correct answers (server-side only) in served order.
    const rows = (
      await db.execute({
        sql: `SELECT question_id, difficulty, correct_index FROM fantasy_quiz_questions WHERE question_id IN (${questionIds.map(() => '?').join(',')})`,
        args: questionIds,
      })
    ).rows;
    const byId = new Map(
      rows.map((r) => [
        str(r.question_id),
        { difficulty: str(r.difficulty) as Difficulty, correctIndex: Number(r.correct_index) },
      ])
    );
    const served: ServedQuestion[] = questionIds.map((id) => {
      const q = byId.get(id);
      return { difficulty: q?.difficulty ?? 'easy', correctIndex: q?.correctIndex ?? -1 };
    });

    const score = scoreQuiz(served, data.answers);
    const now = new Date().toISOString();

    // Race-safe completion: only the FIRST submit (completed_at still NULL) wins,
    // so a member can't re-score the same attempt with different answers. The
    // partial unique index can't catch this (both submits hit the same row).
    const completed = await db.execute({
      sql: `UPDATE fantasy_quiz_attempts
            SET answers_json = ?, raw_score = ?, max_score = ?, weighted_score = ?, completed_at = ?
            WHERE attempt_id = ? AND completed_at IS NULL`,
      args: [
        JSON.stringify(data.answers),
        score.raw,
        score.max,
        score.weighted,
        now,
        str(attempt.attempt_id),
      ],
    });
    if (completed.rowsAffected !== 1) throw new Error('CONFLICT:already-done');

    await db.execute({
      sql: 'UPDATE fantasy_members SET quiz_score = ? WHERE league_id = ? AND user_id = ?',
      args: [score.weighted, data.leagueId, actor.userId],
    });

    return { ok: true as const, weightedScore: score.weighted };
  });

// ===========================================================================
// DRAFT — schedule / start / pick / pause / resume + live state (M3)
// Thin wrappers: authz + validation here, all stateful logic in draft-engine.ts.
// ===========================================================================

export const scheduleDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(
      v.object({ leagueId: v.string(), scheduledAt: v.pipe(v.string(), v.isoTimestamp()) }),
      d
    )
  )
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    const league = await requireOwner(db, data.leagueId, actor);
    requirePaid(league);
    const config = JSON.parse(str(league.config_json)) as LeagueConfig;

    const existing = (
      await db.execute({
        sql: 'SELECT status FROM fantasy_drafts WHERE league_id = ?',
        args: [data.leagueId],
      })
    ).rows[0];
    if (existing && existing.status !== 'scheduled') throw new Error('CONFLICT:already-started');

    await db.execute({
      sql: `INSERT INTO fantasy_drafts
              (draft_id, league_id, status, scheduled_at, draft_type, pick_seconds, total_rounds, current_pick_no)
            VALUES (?, ?, 'scheduled', ?, ?, ?, ?, 0)
            ON CONFLICT(league_id) DO UPDATE SET
              scheduled_at = excluded.scheduled_at, draft_type = excluded.draft_type,
              pick_seconds = excluded.pick_seconds, total_rounds = excluded.total_rounds`,
      args: [
        crypto.randomUUID(),
        data.leagueId,
        data.scheduledAt,
        config.draftType,
        config.pickSeconds,
        totalRounds(config),
      ],
    });
    await db.execute({
      sql: "UPDATE fantasy_leagues SET status = 'scheduled', updated_at = ? WHERE league_id = ?",
      args: [new Date().toISOString(), data.leagueId],
    });
    await enqueueDraftReminders(data.leagueId, data.scheduledAt);
    return { ok: true as const };
  });

export const startDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    requirePaid(await requireOwner(db, data.leagueId, actor));
    const result = await draftEngine.startDraft(data.leagueId);
    return result.ok ? { ok: true as const } : { ok: false as const, reason: result.reason };
  });

export const makePick = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(v.object({ leagueId: v.string(), corpsKey: v.string(), caption: v.string() }), d)
  )
  .handler(async ({ data }) => {
    const actor = await requireActor();
    limitPerUser('pick', actor.userId, 120);
    assertDurable();
    // The engine already rejects anyone who isn't the current picker; this is an
    // explicit membership gate (defense-in-depth + a clear error for non-members).
    await requireMember(await getContributionsDb(), data.leagueId, actor);
    await draftEngine.makePick(data.leagueId, actor.userId, data.corpsKey, data.caption);
    return { ok: true as const };
  });

export const pauseDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    await requireOwner(db, data.leagueId, actor);
    await draftEngine.pauseDraft(data.leagueId);
    return { ok: true as const };
  });

export const resumeDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    await requireOwner(db, data.leagueId, actor);
    await draftEngine.resumeDraft(data.leagueId);
    return { ok: true as const };
  });

/** Members-only live draft state: the snapshot + the draftable corps pool. */
export const getDraftState = createServerFn({ method: 'GET' })
  .validator((d: { leagueId: string }) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    const db = await getContributionsDb();
    await requireMember(db, data.leagueId, actor);
    const [snapshot, pool] = await Promise.all([
      draftEngine.getSnapshot(data.leagueId),
      getDraftPool(),
    ]);
    return { snapshot, pool };
  });

// ===========================================================================
// STANDINGS — recap-style leaderboard read (M4)
// ===========================================================================

/** Public read: a league's standings (one recap-style row per member). */
// Strangler shim (P1): delegates to StandingsService over the Effect path.
export const getStandings = createServerFn({ method: 'GET' })
  .validator((d: { slug: string }) => v.parse(v.object({ slug: v.string() }), d))
  .handler(async ({ data }) => {
    const program = Effect.flatMap(StandingsService, (svc) => svc.getStandings(data.slug)).pipe(
      provideFantasy,
      Effect.catchTag('NotFound', () => Effect.fail(new Error('NOT_FOUND')))
    );
    return Effect.runPromise(program);
  });

// ===========================================================================
// PUSH — web-push subscriptions (M5). VAPID public key + save/delete a sub.
// ===========================================================================

/** The VAPID public key the client needs to subscribe (null when push is off). */
export const getVapidPublicKey = createServerFn({ method: 'GET' }).handler(async () => ({
  publicKey: vapidPublicKey(),
}));

const PushSubInput = v.object({
  endpoint: v.pipe(v.string(), v.url()),
  keys: v.object({ p256dh: v.string(), auth: v.string() }),
});

export const savePushSubscription = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(PushSubInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    await db.execute({
      sql: `INSERT INTO fantasy_push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      args: [
        actor.userId,
        data.endpoint,
        data.keys.p256dh,
        data.keys.auth,
        new Date().toISOString(),
      ],
    });
    return { ok: true as const };
  });

export const deletePushSubscription = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ endpoint: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    await db.execute({
      sql: 'DELETE FROM fantasy_push_subscriptions WHERE user_id = ? AND endpoint = ?',
      args: [actor.userId, data.endpoint],
    });
    return { ok: true as const };
  });

// ===========================================================================
// PAYMENTS — one-time league fee via Stripe Checkout + self-serve refund (M6, §12)
// ===========================================================================

/** Owner starts a Checkout session to unlock a league (create-then-pay, §12.2). */
export const createLeagueCheckout = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    if (!paymentsEnabled()) throw new Error('CONFLICT:payments-disabled');
    const db = await getContributionsDb();
    const league = await requireOwner(db, data.leagueId, actor);
    if (str(league.payment_status) === 'paid') throw new Error('CONFLICT:already-paid');
    const { url } = await createLeagueCheckoutSession({
      leagueId: data.leagueId,
      slug: str(league.slug),
    });
    return { ok: true as const, url };
  });

/**
 * Self-serve full refund BEFORE the draft starts (§12.3). After the draft begins
 * the product is delivered — no refund. Sets the league canceled + revokes invites.
 */
export const requestRefund = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    const league = await requireOwner(db, data.leagueId, actor);
    if (str(league.payment_status) !== 'paid') throw new Error('CONFLICT:not-paid');
    if (!JOINABLE.has(str(league.status))) throw new Error('CONFLICT:draft-started');

    const paymentRef = strOrNull(league.payment_ref);
    if (!paymentRef) throw new Error('CONFLICT:no-payment-ref');
    await refundPaymentIntent(paymentRef);

    const now = new Date().toISOString();
    await db.batch(
      [
        {
          sql: "UPDATE fantasy_leagues SET payment_status = 'refunded', status = 'canceled', updated_at = ? WHERE league_id = ?",
          args: [now, data.leagueId],
        },
        {
          sql: 'UPDATE fantasy_invites SET revoked_at = ? WHERE league_id = ? AND revoked_at IS NULL',
          args: [now, data.leagueId],
        },
      ],
      'write'
    );
    return { ok: true as const };
  });
