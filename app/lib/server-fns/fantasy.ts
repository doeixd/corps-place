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
import { Effect, Match } from 'effect';
import * as v from 'valibot';
import { LeagueService } from '@/lib/fantasy/services/league-service';
import { StandingsService } from '@/lib/fantasy/services/standings-service';
import { InviteService } from '@/lib/fantasy/services/invite-service';
import { MembershipService } from '@/lib/fantasy/services/membership-service';
import { QuizService } from '@/lib/fantasy/services/quiz-service';
import { DraftService } from '@/lib/fantasy/services/draft-service';
import { effectDraftEnabled } from '@/lib/fantasy/flag';
import { provideFantasy } from '@/rpc';
import { getContributionsDb, durableStorageStatus } from '@/lib/contributions-db';
import { getActor, requireCapability, type Actor } from '@/lib/authz';
import { totalRounds, type LeagueConfig } from '@/lib/fantasy/config';
import { getDraftPool } from '@/lib/fantasy/score-db';
import * as draftEngine from '@/lib/fantasy/draft-engine';
import { NotificationService } from '@/lib/fantasy/services/notification-service';
import { vapidPublicKey } from '@/lib/fantasy/push';
import { paymentsEnabled } from '@/lib/fantasy/payments';
import { PaymentService } from '@/lib/fantasy/services/payment-service';
import { rateLimit } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// Effect boundary (strangler): map the fantasy typed domain errors back to the
// legacy `Error` messages routes/components still branch on, and run the program.
// `runPromise` lives ONLY here, at the server-fn boundary (AGENTS.md).
// ---------------------------------------------------------------------------

const legacyFantasyMessage = (e: { _tag: string; reason?: string }): string =>
  Match.value(e._tag).pipe(
    Match.when('Unauthenticated', () => 'UNAUTHENTICATED'),
    Match.when('Forbidden', () => 'FORBIDDEN'),
    Match.when('NotFound', () => 'NOT_FOUND'),
    Match.when('StorageUnavailable', () => `STORAGE_UNAVAILABLE: ${e.reason ?? ''}`),
    Match.when('RateLimited', () => 'CONFLICT:rate-limited'),
    Match.when('LeagueConflict', () => `CONFLICT:${e.reason}`),
    Match.when('DraftConflict', () => `CONFLICT:${e.reason}`),
    Match.when('QuizConflict', () => `CONFLICT:${e.reason}`),
    Match.when('PaymentDisabled', () => 'CONFLICT:payments-disabled'),
    Match.orElse(() => 'CONFLICT:unknown')
  );

/** Run a fully-provided fantasy program, rethrowing typed errors as legacy strings. */
const runFantasy = <A, E extends { _tag: string; reason?: string }>(
  program: Effect.Effect<A, E, never>
): Promise<A> =>
  Effect.runPromise(
    program.pipe(Effect.catch((e) => Effect.fail(new Error(legacyFantasyMessage(e)))))
  );

/** Throw a uniform CONFLICT when a per-user action exceeds its rate budget (§13). */
const limitPerUser = (action: string, userId: string, max: number, windowMs = 60_000): void => {
  if (!rateLimit(`${action}:${userId}`, max, windowMs)) throw new Error('CONFLICT:rate-limited');
};

// libsql Row cells are typed `Value` (string|number|bigint|ArrayBuffer|null),
// which isn't JSON-serializable for a server-fn return. These casts read a cell
// as a known primitive (our columns only ever hold text/int/null) and keep the
// `no-base-to-string` lint quiet (no String()/template coercion of a wide type).
const str = (v: unknown): string => v as string;

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

// ---------------------------------------------------------------------------
// leagues
// ---------------------------------------------------------------------------

const CreateLeagueInput = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Name required'), v.maxLength(60)),
  season: v.pipe(v.string(), v.regex(/^\d{4}$/, 'Season must be a 4-digit year')),
  config: v.optional(v.unknown()),
});

// Strangler shim (P2): delegates to LeagueService.create (durable-guard +
// rate-limit + atomic insert run inside the service); actor resolved here.
export const createLeague = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreateLeagueInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(LeagueService, (svc) =>
        svc.create({ actor, name: data.name, season: data.season, config: data.config })
      ).pipe(provideFantasy)
    );
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

// Strangler shim (P2): delegates to LeagueService.updateConfig (owner guard +
// draft-shape/weights freeze checks run inside the service).
export const updateLeagueConfig = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UpdateConfigInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(LeagueService, (svc) =>
        svc.updateConfig({ actor, leagueId: data.leagueId, config: data.config })
      ).pipe(provideFantasy)
    );
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

// Strangler shim (P2): delegates to InviteService.create.
export const createInvite = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreateInviteInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(InviteService, (svc) =>
        svc.create({
          actor,
          leagueId: data.leagueId,
          email: data.email,
          maxUses: data.maxUses,
          expiresInDays: data.expiresInDays,
        })
      ).pipe(provideFantasy)
    );
  });

// Strangler shim (P2): delegates to InviteService.revoke.
export const revokeInvite = createServerFn({ method: 'POST' })
  .validator((d: { inviteId: string }) => v.parse(v.object({ inviteId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(InviteService, (svc) => svc.revoke({ actor, inviteId: data.inviteId })).pipe(
        provideFantasy
      )
    );
  });

/** Public loader read: validate a token and describe the invite (no token echoed back). */
// Strangler shim (P2): delegates to InviteService.getInvite.
export const getInvite = createServerFn({ method: 'GET' })
  .validator((d: { token: string }) => v.parse(v.object({ token: v.string() }), d))
  .handler(async ({ data }) => {
    return runFantasy(
      Effect.flatMap(InviteService, (svc) => svc.getInvite(data.token)).pipe(provideFantasy)
    );
  });

const AcceptInviteInput = v.object({
  token: v.string(),
  // Same bounds as setCorpsIdentity — the accept path writes straight to the member row.
  corpsName: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(40))),
  showTitle: v.optional(v.pipe(v.string(), v.maxLength(80))),
  color: v.optional(v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb color'))),
  logoMediaId: v.optional(v.pipe(v.string(), v.maxLength(64))),
});

// Strangler shim (P2): delegates to InviteService.accept (race-safe CAS + seat
// release live in the service).
export const acceptInvite = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(AcceptInviteInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(InviteService, (svc) =>
        svc.accept({
          actor,
          token: data.token,
          corpsName: data.corpsName,
          showTitle: data.showTitle,
          color: data.color,
          logoMediaId: data.logoMediaId,
        })
      ).pipe(provideFantasy)
    );
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

// Strangler shim (P2): delegates to MembershipService.setCorpsIdentity.
export const setCorpsIdentity = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SetIdentityInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(MembershipService, (svc) =>
        svc.setCorpsIdentity({
          actor,
          leagueId: data.leagueId,
          corpsName: data.corpsName,
          showTitle: data.showTitle,
          color: data.color,
          logoMediaId: data.logoMediaId,
        })
      ).pipe(provideFantasy)
    );
  });

const RemoveMemberInput = v.object({ leagueId: v.string(), userId: v.string() });

// Strangler shim (P2): delegates to MembershipService.removeMember.
export const removeMember = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(RemoveMemberInput, d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(MembershipService, (svc) =>
        svc.removeMember({ actor, leagueId: data.leagueId, userId: data.userId })
      ).pipe(provideFantasy)
    );
  });

// ===========================================================================
// QUIZ — admin bank CRUD (capability manageFantasyQuiz) + member run (M2)
// ===========================================================================

// ---- admin: list / upsert / activate questions --------------------------------

// Strangler shim (P2): capability-gated at the boundary, then QuizService.
export const adminListQuestions = createServerFn({ method: 'GET' }).handler(async () => {
  await requireCapability(getWebRequest(), 'manageFantasyQuiz');
  return runFantasy(
    Effect.flatMap(QuizService, (svc) => svc.adminListQuestions()).pipe(provideFantasy)
  );
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

// Strangler shim (P2): delegates to QuizService.adminUpsertQuestion.
export const adminUpsertQuestion = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(QuestionInput, d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyQuiz');
    return runFantasy(
      Effect.flatMap(QuizService, (svc) =>
        svc.adminUpsertQuestion({
          actor,
          questionId: data.questionId,
          prompt: data.prompt,
          choices: data.choices,
          correctIndex: data.correctIndex,
          explanation: data.explanation,
          difficulty: data.difficulty,
          tags: data.tags,
        })
      ).pipe(provideFantasy)
    );
  });

// Strangler shim (P2): delegates to QuizService.adminSetQuestionActive.
export const adminSetQuestionActive = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ questionId: v.string(), active: v.boolean() }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageFantasyQuiz');
    return runFantasy(
      Effect.flatMap(QuizService, (svc) =>
        svc.adminSetQuestionActive({ actor, questionId: data.questionId, active: data.active })
      ).pipe(provideFantasy)
    );
  });

// ---- member: take the quiz (served set has NO correct answers) -----------------

// Strangler shim (P2): delegates to QuizService.getQuizForLeague.
export const getQuizForLeague = createServerFn({ method: 'GET' })
  .validator((d: { leagueId: string }) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(QuizService, (svc) =>
        svc.getQuizForLeague({ actor, leagueId: data.leagueId })
      ).pipe(provideFantasy)
    );
  });

// Strangler shim (P2): delegates to QuizService.submitQuiz (race-safe completion).
export const submitQuiz = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(v.object({ leagueId: v.string(), answers: v.array(v.number()) }), d)
  )
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(QuizService, (svc) =>
        svc.submitQuiz({ actor, leagueId: data.leagueId, answers: data.answers })
      ).pipe(provideFantasy)
    );
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
    await runFantasy(
      Effect.flatMap(NotificationService, (s) =>
        s.enqueueDraftReminders(data.leagueId, data.scheduledAt)
      ).pipe(provideFantasy)
    );
    return { ok: true as const };
  });

// Draft shims (P3): authz/rate-limit stay at the boundary; the engine is selected
// by the FANTASY_EFFECT_DRAFT sub-flag (Effect DraftService vs legacy draft-engine).
export const startDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    requirePaid(await requireOwner(db, data.leagueId, actor));
    const result = effectDraftEnabled()
      ? await runFantasy(
          Effect.flatMap(DraftService, (s) => s.start(data.leagueId)).pipe(provideFantasy)
        )
      : await draftEngine.startDraft(data.leagueId);
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
    if (effectDraftEnabled()) {
      await runFantasy(
        Effect.flatMap(DraftService, (s) =>
          s.makePick({
            leagueId: data.leagueId,
            userId: actor.userId,
            corpsKey: data.corpsKey,
            caption: data.caption,
          })
        ).pipe(provideFantasy)
      );
    } else {
      await draftEngine.makePick(data.leagueId, actor.userId, data.corpsKey, data.caption);
    }
    return { ok: true as const };
  });

export const pauseDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    await requireOwner(db, data.leagueId, actor);
    if (effectDraftEnabled()) {
      await runFantasy(
        Effect.flatMap(DraftService, (s) => s.pause(data.leagueId)).pipe(provideFantasy)
      );
    } else {
      await draftEngine.pauseDraft(data.leagueId);
    }
    return { ok: true as const };
  });

export const resumeDraft = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    assertDurable();
    const db = await getContributionsDb();
    await requireOwner(db, data.leagueId, actor);
    if (effectDraftEnabled()) {
      await runFantasy(
        Effect.flatMap(DraftService, (s) => s.resume(data.leagueId)).pipe(provideFantasy)
      );
    } else {
      await draftEngine.resumeDraft(data.leagueId);
    }
    return { ok: true as const };
  });

/** Members-only live draft state: the snapshot + the draftable corps pool. */
export const getDraftState = createServerFn({ method: 'GET' })
  .validator((d: { leagueId: string }) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    const db = await getContributionsDb();
    await requireMember(db, data.leagueId, actor);
    const snapshotP = effectDraftEnabled()
      ? runFantasy(
          Effect.flatMap(DraftService, (s) => s.getSnapshot(data.leagueId)).pipe(provideFantasy)
        )
      : draftEngine.getSnapshot(data.leagueId);
    const [snapshot, pool] = await Promise.all([snapshotP, getDraftPool()]);
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
// Strangler shim (P4): delegates to PaymentService.createCheckout.
export const createLeagueCheckout = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(PaymentService, (s) =>
        s.createCheckout({ actor, leagueId: data.leagueId })
      ).pipe(provideFantasy)
    );
  });

/**
 * Self-serve full refund BEFORE the draft starts (§12.3). After the draft begins
 * the product is delivered — no refund. Sets the league canceled + revokes invites.
 */
// Strangler shim (P4): delegates to PaymentService.requestRefund.
export const requestRefund = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ leagueId: v.string() }), d))
  .handler(async ({ data }) => {
    const actor = await requireActor();
    return runFantasy(
      Effect.flatMap(PaymentService, (s) =>
        s.requestRefund({ actor, leagueId: data.leagueId })
      ).pipe(provideFantasy)
    );
  });
