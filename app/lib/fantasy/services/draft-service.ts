/**
 * DraftService (migration plan §3.4 / P3) — the live draft engine on Effect.
 * Ports `draft-engine.ts` onto the `ContributionsSql` SqlClient + Effect
 * concurrency primitives, keeping the pure `draft.ts` advance math unchanged.
 *
 * Process-global state lives in MODULE-LEVEL maps (not the layer instance) because
 * the fantasy boundary provides the layer per `runPromise` — a per-instance map
 * would reset every call. Each league gets:
 *   - a `Semaphore(1)` (single-writer serialization, replaces the Promise-chain),
 *   - a `PubSub<DraftEvent>` (SSE fan-out, replaces bus.ts's Set<controller>),
 *   - a detached auto-pick `Fiber` (the clock, replaces setTimeout).
 * The DB is the source of truth; timers re-derive from it, so a deploy mid-draft
 * self-heals (H.3). Single-process assumption (A8/V1) — unchanged from legacy.
 *
 * SERVER-ONLY.
 */
import { Context, Duration, Effect, Fiber, Layer, PubSub, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import { getDraftPool, getPriorSeasonRanking, rankingKey } from '@/lib/fantasy/score-db';
import { sendPushToUser } from '@/lib/fantasy/push';
import { sendEmail } from '@/lib/email';
import { isCaptionKey, CAPTION_KEYS, type CaptionKey } from '@/lib/fantasy/captions';
import { resolveDraftOrder, type DraftMember } from '@/lib/fantasy/draft-order';
import type { LeagueConfig } from '@/lib/fantasy/config';
import {
  userAt,
  pickWeight,
  isDraftComplete,
  legalityError,
  type DraftType,
} from '@/lib/fantasy/draft';
import { chooseAutoPick } from '@/lib/fantasy/auto-pick';
import { DraftConflict, Forbidden, NotFound } from './errors';
import {
  draftReducer,
  type DraftMachineState,
  type DraftReducerError,
  type DraftStatus,
} from '../machines/draft';
import { leagueReducer, type LeagueStatus } from '../machines/league';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

export type DraftEvent = { event: string; data: unknown };

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const APP_URL = (process.env.BETTER_AUTH_URL ?? 'https://drumcorps.app').replace(/\/$/, '');

export type DraftSnapshot = {
  draft: {
    status: string;
    draftType: DraftType;
    pickSeconds: number;
    totalRounds: number;
    currentPickNo: number;
    currentUserId: string | null;
    pickDeadlineAt: string | null;
    scheduledAt: string | null;
    autoStart: boolean;
    order: string[];
  } | null;
  picks: Array<{
    userId: string;
    corpsKey: string;
    caption: CaptionKey;
    round: number;
    pickNo: number;
    weight: number;
    autoPicked: boolean;
  }>;
};

export type StartFeasibility = { ok: true } | { ok: false; reason: string };

// --- module-global per-league primitives (survive per-call layer rebuilds) ----

const locks = new Map<string, Semaphore.Semaphore>();
const lockFor = (leagueId: string): Semaphore.Semaphore => {
  let s = locks.get(leagueId);
  if (!s) {
    s = Semaphore.makeUnsafe(1);
    locks.set(leagueId, s);
  }
  return s;
};

const buses = new Map<string, PubSub.PubSub<DraftEvent>>();
const busFor = (leagueId: string): PubSub.PubSub<DraftEvent> => {
  let b = buses.get(leagueId);
  if (!b) {
    b = Effect.runSync(PubSub.unbounded<DraftEvent>());
    buses.set(leagueId, b);
  }
  return b;
};

/** Subscribe to a league's draft events as a Stream source (used by the SSE route). */
export const draftPubSub = busFor;

const timerFibers = new Map<string, Fiber.Fiber<void>>();
let selfHealed = false;

// Grace window past the displayed deadline. A pick clicked right at 0:00 still has to
// travel the network and wait for the per-league lock, so a hard millisecond cutoff
// rejects timely picks and hands the slot to the auto-picker. The auto-pick fiber waits
// this long PAST the deadline before firing, and makePick accepts picks until the same
// moment — so the two agree and near-deadline picks land instead of being short-circuited.
const PICK_GRACE_MS = 2000;

// --- mapping helpers ----------------------------------------------------------

interface DraftRow {
  status: string;
  draft_type: string;
  pick_seconds: number;
  total_rounds: number;
  current_pick_no: number;
  current_user_id: string | null;
  pick_deadline_at: string | null;
  scheduled_at: string | null;
  auto_start: number | null;
  order_json: string | null;
}

const mapDraft = (d: DraftRow): NonNullable<DraftSnapshot['draft']> => ({
  status: d.status,
  draftType: d.draft_type as DraftType,
  pickSeconds: Number(d.pick_seconds),
  totalRounds: Number(d.total_rounds),
  currentPickNo: Number(d.current_pick_no),
  currentUserId: d.current_user_id ?? null,
  pickDeadlineAt: d.pick_deadline_at ?? null,
  scheduledAt: d.scheduled_at ?? null,
  autoStart: Number(d.auto_start ?? 1) !== 0,
  order: d.order_json ? (JSON.parse(d.order_json) as string[]) : [],
});

// The draft lifecycle (status transitions) is delegated to the pure reducer in
// ../machines/draft (UI/UX plan §13): the service validates each move through it so
// an illegal transition is impossible by construction. Reducer reasons map back to
// the existing typed errors — out-of-turn → Forbidden, everything else → DraftConflict.
const toMachineState = (d: NonNullable<DraftSnapshot['draft']>): DraftMachineState => ({
  status: d.status as DraftStatus,
  draftType: d.draftType,
  order: d.order,
  totalRounds: d.totalRounds,
  currentPickNo: d.currentPickNo,
});
const reducerError = (reason: DraftReducerError) =>
  reason === 'out-of-turn' ? new Forbidden() : new DraftConflict({ reason });

const divisionKey = (name: string | null): 'world' | 'open' | null => {
  const d = (name ?? '').toLowerCase();
  if (d.includes('open')) return 'open';
  if (d.includes('world')) return 'world';
  return null;
};

const makeDraftService = Effect.gen(function* () {
  const sql = yield* ContributionsSql;

  const loadDraft = (leagueId: string) =>
    sql<DraftRow>`SELECT * FROM fantasy_drafts WHERE league_id = ${leagueId}`.pipe(Effect.orDie);

  const loadConfig = (leagueId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ config_json: string }>`
        SELECT config_json FROM fantasy_leagues WHERE league_id = ${leagueId}
      `.pipe(Effect.orDie);
      if (!rows[0]) return yield* Effect.fail(new NotFound({ message: 'league' }));
      return JSON.parse(rows[0].config_json) as LeagueConfig;
    });

  const loadPicks = (leagueId: string) =>
    sql<{
      user_id: string;
      corps_key: string;
      caption: string;
      round: number;
      pick_no: number;
      weight: number;
      auto_picked: number;
    }>`
      SELECT user_id, corps_key, caption, round, pick_no, weight, auto_picked
      FROM fantasy_picks WHERE league_id = ${leagueId} ORDER BY pick_no
    `.pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows.map((p) => ({
          userId: p.user_id,
          corpsKey: p.corps_key,
          caption: p.caption as CaptionKey,
          round: Number(p.round),
          pickNo: Number(p.pick_no),
          weight: Number(p.weight),
          autoPicked: Boolean(p.auto_picked),
        }))
      )
    );

  const snapshot = (leagueId: string): Effect.Effect<DraftSnapshot> =>
    Effect.gen(function* () {
      const rows = yield* loadDraft(leagueId);
      const picks = yield* loadPicks(leagueId);
      return { draft: rows[0] ? mapDraft(rows[0]) : null, picks };
    });

  const poolKeysForLeague = (config: LeagueConfig) =>
    Effect.promise(() => getDraftPool()).pipe(
      Effect.map((pool) => {
        const allowed = new Set<string>(config.allowedDivisions);
        return new Set(
          pool
            .filter((c) => {
              const key = divisionKey(c.divisionName);
              return key != null && allowed.has(key);
            })
            .map((c) => c.corpsKey)
        );
      })
    );

  const legalityState = (leagueId: string, userId: string) =>
    Effect.gen(function* () {
      const picks = yield* sql<{ user_id: string; corps_key: string; caption: string }>`
        SELECT user_id, corps_key, caption FROM fantasy_picks WHERE league_id = ${leagueId}
      `.pipe(Effect.orDie);
      const takenPairs = new Set<string>();
      const myCorps = new Set<string>();
      const myCaptionCount = new Map<CaptionKey, number>();
      for (const p of picks) {
        const caption = p.caption as CaptionKey;
        takenPairs.add(`${p.corps_key}|${caption}`);
        if (p.user_id === userId) {
          myCorps.add(p.corps_key);
          myCaptionCount.set(caption, (myCaptionCount.get(caption) ?? 0) + 1);
        }
      }
      return { takenPairs, myCorps, myCaptionCount };
    });

  // --- timer (detached auto-pick fiber; re-armed from the DB) ----------------

  const clearTimer = (leagueId: string): void => {
    const f = timerFibers.get(leagueId);
    if (f) {
      Effect.runFork(Fiber.interrupt(f));
      timerFibers.delete(leagueId);
    }
  };

  const armTimer = (leagueId: string, deadlineIso: string): void => {
    clearTimer(leagueId);
    const ms = Math.max(0, new Date(deadlineIso).getTime() - Date.now()) + PICK_GRACE_MS;
    const fiber = Effect.runFork(
      Effect.sleep(Duration.millis(ms)).pipe(
        Effect.andThen(runAutoPickIfDue(leagueId, deadlineIso)),
        Effect.ignore
      )
    );
    timerFibers.set(leagueId, fiber);
  };

  const broadcast = (leagueId: string, event: DraftEvent) =>
    PubSub.publish(busFor(leagueId), event).pipe(Effect.asVoid);

  // Push to specific league members, skipping anyone who muted push for THIS
  // league (per-user prefs). Each send is fire-and-forget (no-op without a push
  // subscription) so it never blocks the draft lock; the helper itself is an Effect
  // only so it can read the mute set from `sql` (§12.4 notification matrix).
  const pushToLeagueUsers = (
    leagueId: string,
    userIds: readonly string[],
    title: string,
    body: string
  ) =>
    Effect.gen(function* () {
      const targets = [...new Set(userIds.filter(Boolean))];
      if (targets.length === 0) return;
      const muted = yield* sql<{ user_id: string }>`
        SELECT user_id FROM fantasy_members WHERE league_id = ${leagueId} AND notify_push = 0
      `.pipe(Effect.orDie);
      const mutedSet = new Set(muted.map((r) => r.user_id));
      for (const id of targets)
        if (!mutedSet.has(id))
          void sendPushToUser(id, { title, body, url: '/fantasy' }).catch(() => {});
    });

  // The member who picks immediately AFTER the current on-clock pick (the "on deck"
  // heads-up). null at the final pick, or when it's the same member (a snake turn
  // boundary where one member picks twice — no point pinging them as on-deck).
  const onDeckUser = (
    order: readonly string[],
    currentPickNo: number,
    type: DraftType,
    totalRounds: number
  ): string | null => {
    const nextPickNo = currentPickNo + 1;
    if (isDraftComplete(nextPickNo, order.length, totalRounds)) return null;
    const next = userAt(order, nextPickNo, type);
    return next === userAt(order, currentPickNo, type) ? null : next;
  };

  // Email parity for the *big* lifecycle moments (draft opens / completes) so a
  // member without a push subscription still hears about it (§12.4 notification
  // matrix). Per-pick events (on-the-clock, auto-pick) stay push-only — an email
  // per pick would be spam. Gated by the league's `notify.email` pref. Returns an
  // Effect so callers `forkDaemon` it — it must never block or fail the draft lock.
  const LIFECYCLE_EMAIL = {
    draft_live: {
      subject: (n: string) => `Your ${n} draft is live`,
      html: (n: string) =>
        `<p>The draft room for <strong>${n}</strong> is open — come make your picks before your timer runs out.</p>`,
    },
    draft_complete: {
      subject: (n: string) => `Your ${n} draft is complete`,
      html: (n: string) =>
        `<p>Every pick is in for <strong>${n}</strong>. See the final rosters and follow the standings as the season scores.</p>`,
    },
  } as const;

  const emailMembers = (leagueId: string, kind: keyof typeof LIFECYCLE_EMAIL) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ name: string; config_json: string }>`
        SELECT name, config_json FROM fantasy_leagues WHERE league_id = ${leagueId}
      `.pipe(Effect.orDie);
      const league = rows[0];
      if (!league) return;
      const config = JSON.parse(league.config_json) as LeagueConfig;
      if (!config.notify?.email) return;

      const members = yield* sql<{ email: string }>`
        SELECT u.email FROM fantasy_members m
        JOIN user u ON u.id = m.user_id
        WHERE m.league_id = ${leagueId} AND m.status = 'active' AND u.email IS NOT NULL
          AND m.notify_email = 1 AND u.contactConsent = 1
      `.pipe(Effect.orDie);
      if (members.length === 0) return;

      const tpl = LIFECYCLE_EMAIL[kind];
      yield* Effect.promise(() =>
        Promise.all(
          members.map((m) =>
            sendEmail({
              to: m.email,
              subject: tpl.subject(league.name),
              html: tpl.html(escapeHtml(league.name)),
              tag: 'fantasy_draft_lifecycle',
            })
          )
        )
      );
    }).pipe(Effect.catchCause(() => Effect.void));

  // Email parity for the auto-pick (§12.4). Unlike on-clock/on-deck — which target an
  // engaged member who'll see the push/app — an auto-pick happens precisely BECAUSE the
  // member wasn't watching, so an email is the channel most likely to reach them. Sent
  // only to that one member, gated by their email pref + the league's notify.email.
  const emailAutoPick = (leagueId: string, userId: string, caption: CaptionKey) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ name: string; slug: string; config_json: string }>`
        SELECT name, slug, config_json FROM fantasy_leagues WHERE league_id = ${leagueId}
      `.pipe(Effect.orDie);
      const league = rows[0];
      if (!league) return;
      const config = JSON.parse(league.config_json) as LeagueConfig;
      if (!config.notify?.email) return;

      const recipients = yield* sql<{ email: string }>`
        SELECT u.email FROM fantasy_members m
        JOIN user u ON u.id = m.user_id
        WHERE m.league_id = ${leagueId} AND m.user_id = ${userId} AND m.status = 'active'
          AND u.email IS NOT NULL AND m.notify_email = 1 AND u.contactConsent = 1
      `.pipe(Effect.orDie);
      const to = recipients[0]?.email;
      if (!to) return;

      const safeName = escapeHtml(league.name);
      const url = `${APP_URL}/fantasy/${league.slug}/draft`;
      yield* Effect.promise(() =>
        sendEmail({
          to,
          subject: `We made your ${league.name} pick`,
          html:
            `<p>Your timer ran out in <strong>${safeName}</strong>, so we auto-picked your ` +
            `<strong>${caption}</strong> corps for you.</p>` +
            `<p><a href="${url}">Open the draft room</a> to see it and get ready for your next turn.</p>`,
          tag: 'fantasy_auto_pick',
        })
      );
    }).pipe(Effect.catchCause(() => Effect.void));

  // --- self-heal: re-arm timers for drafts left live by a prior process -------

  const ensureSelfHeal = Effect.suspend(() => {
    if (selfHealed) return Effect.void;
    return sql<{ league_id: string; pick_deadline_at: string | null }>`
      SELECT league_id, pick_deadline_at FROM fantasy_drafts WHERE status = 'live'
    `.pipe(
      Effect.orDie,
      Effect.map((rows) => {
        for (const r of rows) if (r.pick_deadline_at) armTimer(r.league_id, r.pick_deadline_at);
        // Set the flag only AFTER a successful scan — a transient DB failure must
        // not permanently disable self-heal. A concurrent double-scan is harmless
        // (re-arming a timer is idempotent).
        selfHealed = true;
      })
    );
  });

  // --- commit a pick + advance the clock (or finalize) -----------------------

  const commitPickAndAdvance = (
    leagueId: string,
    draft: NonNullable<DraftSnapshot['draft']>,
    pick: {
      userId: string;
      corpsKey: string;
      caption: CaptionKey;
      autoPicked: boolean;
      config: LeagueConfig;
    } | null
  ) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();

      if (pick) {
        const priorByMember = yield* sql<{ caption: string }>`
          SELECT caption FROM fantasy_picks WHERE league_id = ${leagueId} AND user_id = ${pick.userId}
        `.pipe(Effect.orDie);
        const round = priorByMember.length + 1;
        const captionSlotIndex = priorByMember.filter((r) => r.caption === pick.caption).length + 1;
        // Weight is tied to the SLOT within the caption (increasing per slot), not the
        // global draft round — so every player's Nth corps in a caption weighs the same
        // and the draft board's rows are uniform weight tiers.
        const captionCap = pick.config.captionCaps[pick.caption];
        const weight = pickWeight(captionSlotIndex, captionCap, pick.config.reverseWeighting);
        yield* sql`
          INSERT INTO fantasy_picks
            (pick_id, league_id, user_id, corps_key, caption, round, pick_no, caption_slot_index, weight, auto_picked, created_at)
          VALUES (${randomUUID()}, ${leagueId}, ${pick.userId}, ${pick.corpsKey}, ${pick.caption},
                  ${round}, ${draft.currentPickNo}, ${captionSlotIndex}, ${weight},
                  ${pick.autoPicked ? 1 : 0}, ${now})
        `.pipe(Effect.orDie);
      }

      const memberCount = draft.order.length;
      const nextPickNo = draft.currentPickNo + 1;

      if (isDraftComplete(nextPickNo, memberCount, draft.totalRounds)) {
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
              UPDATE fantasy_drafts SET status = 'complete', current_user_id = NULL,
                pick_deadline_at = NULL, completed_at = ${now} WHERE league_id = ${leagueId}
            `;
              yield* sql`
              UPDATE fantasy_leagues SET status = 'active', updated_at = ${now} WHERE league_id = ${leagueId}
            `;
            })
          )
          .pipe(Effect.orDie);
        yield* Effect.sync(() => clearTimer(leagueId));
        yield* pushToLeagueUsers(
          leagueId,
          draft.order,
          'Draft complete',
          'Every pick is in — see the final rosters and the standings.'
        );
        yield* Effect.sync(() => Effect.runFork(emailMembers(leagueId, 'draft_complete')));
        yield* broadcast(leagueId, { event: 'state', data: { status: 'complete' } });
        // The draft is over — drop the per-league lock/timer/bus so they don't
        // accumulate for the process lifetime (a league drafts once). The bus is
        // only deleted from the map (not shutdown): any still-connected SSE fiber
        // keeps its reference and the PubSub is GC'd once it disconnects; a fresh
        // connect to a completed draft just gets the snapshot (no more publishes).
        yield* Effect.sync(() => {
          locks.delete(leagueId);
          timerFibers.delete(leagueId);
          buses.delete(leagueId);
        });
        return;
      }

      const nextUser = userAt(draft.order, nextPickNo, draft.draftType);
      const deadline = new Date(Date.now() + draft.pickSeconds * 1000).toISOString();
      yield* sql`
        UPDATE fantasy_drafts SET current_pick_no = ${nextPickNo}, current_user_id = ${nextUser},
          pick_deadline_at = ${deadline} WHERE league_id = ${leagueId}
      `.pipe(Effect.orDie);
      yield* Effect.sync(() => armTimer(leagueId, deadline));
      yield* pushToLeagueUsers(
        leagueId,
        [nextUser],
        "You're on the clock",
        'Make your fantasy draft pick before the timer runs out.'
      );
      const deck = onDeckUser(draft.order, nextPickNo, draft.draftType, draft.totalRounds);
      if (deck)
        yield* pushToLeagueUsers(
          leagueId,
          [deck],
          "You're on deck",
          "You're up right after the current pick — get your corps ready."
        );
    });

  // --- auto-pick --------------------------------------------------------------

  const rankedOptions = (prevSeason: string, poolKeys: Set<string>) =>
    Effect.promise(() => getPriorSeasonRanking(prevSeason)).pipe(
      Effect.map((ranking) => {
        const options: Array<{ corpsKey: string; caption: CaptionKey; score: number }> = [];
        for (const corpsKey of poolKeys)
          for (const caption of CAPTION_KEYS)
            options.push({
              corpsKey,
              caption,
              score: ranking.get(rankingKey(corpsKey, caption)) ?? -Infinity,
            });
        options.sort((a, b) => b.score - a.score);
        return options;
      })
    );

  const leagueSeason = (leagueId: string) =>
    sql<{ season: string }>`SELECT season FROM fantasy_leagues WHERE league_id = ${leagueId}`.pipe(
      Effect.orDie,
      Effect.map((rows) => rows[0]?.season ?? '2026')
    );

  function runAutoPickIfDue(
    leagueId: string,
    expectedDeadline?: string
  ): Effect.Effect<void, NotFound> {
    return lockFor(leagueId).withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* loadDraft(leagueId);
        if (!rows[0]) return;
        const draft = mapDraft(rows[0]);
        if (draft.status !== 'live' || !draft.currentUserId) return;
        const onClockUser = draft.currentUserId;
        if (expectedDeadline && draft.pickDeadlineAt !== expectedDeadline) return;

        const config = yield* loadConfig(leagueId);
        const prevSeason = String(Number(yield* leagueSeason(leagueId)) - 1);
        const pool = yield* poolKeysForLeague(config);
        const { takenPairs, myCorps, myCaptionCount } = yield* legalityState(
          leagueId,
          draft.currentUserId
        );
        const options = yield* rankedOptions(prevSeason, pool);

        const isLegal = (o: { corpsKey: string; caption: CaptionKey }) =>
          legalityError({
            caption: o.caption,
            captionCaps: config.captionCaps,
            oneCaptionPerCorps: config.oneCaptionPerCorps,
            memberCaptionCount: myCaptionCount.get(o.caption) ?? 0,
            memberHasCorps: myCorps.has(o.corpsKey),
            pairTakenInLeague: takenPairs.has(`${o.corpsKey}|${o.caption}`),
            inPool: pool.has(o.corpsKey),
          }) === null;

        // The member's pre-ranked queue + which captions they still must fill drive
        // the layered auto-pick policy (queue → roster-need → best-ranked rank).
        const queueRows = yield* sql<{ corps_key: string; caption: string | null }>`
          SELECT corps_key, caption FROM fantasy_draft_queue
          WHERE league_id = ${leagueId} AND user_id = ${draft.currentUserId}
          ORDER BY seq ASC
        `.pipe(Effect.orDie);
        const neededCaptions = new Set(
          CAPTION_KEYS.filter((c) => (myCaptionCount.get(c) ?? 0) < config.captionCaps[c])
        );
        const choice = chooseAutoPick({
          queue: queueRows.map((r) => ({
            corpsKey: r.corps_key,
            caption: (r.caption as CaptionKey | null) ?? null,
          })),
          ranked: options,
          neededCaptions,
          isLegal,
        });

        yield* commitPickAndAdvance(
          leagueId,
          draft,
          choice
            ? {
                userId: draft.currentUserId,
                corpsKey: choice.corpsKey,
                caption: choice.caption,
                autoPicked: true,
                config,
              }
            : null
        );
        // Tell the member what we picked for them when their timer ran out (§12.4) —
        // push for immediacy, and email since they clearly weren't watching.
        if (choice) {
          yield* pushToLeagueUsers(
            leagueId,
            [onClockUser],
            'We made your pick',
            `Your timer ran out — we auto-picked ${choice.caption} for you.`
          );
          yield* Effect.sync(() =>
            Effect.runFork(emailAutoPick(leagueId, onClockUser, choice.caption))
          );
        }
        yield* broadcast(leagueId, { event: 'pick', data: yield* snapshot(leagueId) });
      })
    );
  }

  // --- lifecycle --------------------------------------------------------------

  const checkFeasibility = (
    memberCount: number,
    totalRounds: number,
    poolSize: number,
    config: LeagueConfig
  ): StartFeasibility => {
    if (config.oneCaptionPerCorps && poolSize < totalRounds)
      return {
        ok: false,
        reason: `Pool of ${poolSize} corps can't fill ${totalRounds} roster slots per member.`,
      };
    if (memberCount * totalRounds > poolSize * CAPTION_KEYS.length)
      return {
        ok: false,
        reason: `Not enough unique corps/caption combinations for ${memberCount} members.`,
      };
    return { ok: true };
  };

  const start = Effect.fn('DraftService.start')(function* (leagueId: string) {
    yield* ensureSelfHeal;
    return yield* lockFor(leagueId).withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* loadDraft(leagueId);
        if (!rows[0]) return yield* Effect.fail(new DraftConflict({ reason: 'not-scheduled' }));
        if (rows[0].status !== 'scheduled')
          return yield* Effect.fail(new DraftConflict({ reason: 'already-started' }));

        const config = yield* loadConfig(leagueId);
        const memberRows = yield* sql<{
          user_id: string;
          quiz_score: number | null;
          corps_name: string | null;
          completed_at: string | null;
        }>`
          SELECT m.user_id, m.quiz_score, m.corps_name, a.completed_at
          FROM fantasy_members m
          LEFT JOIN fantasy_quiz_attempts a
            ON a.league_id = m.league_id AND a.user_id = m.user_id AND a.completed_at IS NOT NULL
          WHERE m.league_id = ${leagueId} AND m.status = 'active'
        `.pipe(Effect.orDie);

        if (memberRows.length < 2)
          return yield* Effect.fail(new DraftConflict({ reason: 'need-two-members' }));
        if (memberRows.some((m) => !m.corps_name))
          return yield* Effect.fail(new DraftConflict({ reason: 'identities-incomplete' }));

        const totalRounds = Number(rows[0].total_rounds);
        const poolSize = (yield* poolKeysForLeague(config)).size;
        const feasible = checkFeasibility(memberRows.length, totalRounds, poolSize, config);
        if (!feasible.ok) return feasible;

        // The league lifecycle machine authorizes setup/quiz/scheduled → drafting,
        // so a canceled/finished league can't be resurrected by starting its draft.
        const leagueRows = yield* sql<{ status: string }>`
          SELECT status FROM fantasy_leagues WHERE league_id = ${leagueId}
        `.pipe(Effect.orDie);
        const leagueMove = leagueReducer((leagueRows[0]?.status ?? 'setup') as LeagueStatus, {
          type: 'START_DRAFT',
        });
        if (!leagueMove.ok)
          return yield* Effect.fail(new DraftConflict({ reason: 'league-not-startable' }));

        const members: DraftMember[] = memberRows.map((m) => ({
          userId: m.user_id,
          quizScore: m.quiz_score == null ? null : Number(m.quiz_score),
          completedAt: m.completed_at ?? null,
        }));
        const order = resolveDraftOrder(members, config.quizOrderDir, leagueId);

        const now = new Date().toISOString();
        const deadline = new Date(Date.now() + Number(rows[0].pick_seconds) * 1000).toISOString();
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
              UPDATE fantasy_drafts SET status = 'live', order_json = ${JSON.stringify(order)},
                current_pick_no = 0, current_user_id = ${order[0]}, pick_deadline_at = ${deadline},
                started_at = ${now} WHERE league_id = ${leagueId}
            `;
              yield* sql`
              UPDATE fantasy_leagues SET status = ${leagueMove.next}, updated_at = ${now} WHERE league_id = ${leagueId}
            `;
            })
          )
          .pipe(Effect.orDie);
        yield* Effect.sync(() => armTimer(leagueId, deadline));
        yield* pushToLeagueUsers(
          leagueId,
          [order[0]],
          "You're on the clock",
          'Make your fantasy draft pick before the timer runs out.'
        );
        const firstDeck = onDeckUser(order, 0, config.draftType, totalRounds);
        if (firstDeck)
          yield* pushToLeagueUsers(
            leagueId,
            [firstDeck],
            "You're on deck",
            "You're up right after the first pick — get your corps ready."
          );
        // Tell everyone else the room is open (the on-clock member already got
        // their own, more urgent "you're on the clock" push).
        yield* pushToLeagueUsers(
          leagueId,
          order.filter((u) => u !== order[0]),
          'Your draft is live',
          'The draft room is open — come watch and make your picks.'
        );
        yield* Effect.sync(() => Effect.runFork(emailMembers(leagueId, 'draft_live')));
        yield* broadcast(leagueId, { event: 'snapshot', data: yield* snapshot(leagueId) });
        return { ok: true } as StartFeasibility;
      })
    );
  });

  const makePick = Effect.fn('DraftService.makePick')(function* (input: {
    leagueId: string;
    userId: string;
    corpsKey: string;
    caption: string;
  }) {
    yield* ensureSelfHeal;
    yield* lockFor(input.leagueId).withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* loadDraft(input.leagueId);
        if (!rows[0]) return yield* Effect.fail(new NotFound({ message: 'draft' }));
        const draft = mapDraft(rows[0]);

        const move = draftReducer(toMachineState(draft), {
          type: 'PICK',
          userId: input.userId,
        });
        if (!move.ok) return yield* Effect.fail(reducerError(move.reason));
        // Accept until the deadline + the same grace the auto-pick fiber waits. The turn
        // check above + the per-league lock keep this correct: if the auto-pick already
        // fired, it's no longer this user's turn and `move.ok` is false; otherwise this
        // pick wins the lock and the stale auto-pick fiber no-ops (deadline guard).
        if (
          draft.pickDeadlineAt &&
          new Date(draft.pickDeadlineAt).getTime() + PICK_GRACE_MS < Date.now()
        )
          return yield* Effect.fail(new DraftConflict({ reason: 'expired' }));
        if (!isCaptionKey(input.caption))
          return yield* Effect.fail(new DraftConflict({ reason: 'bad-caption' }));

        const config = yield* loadConfig(input.leagueId);
        const pool = yield* poolKeysForLeague(config);
        const { takenPairs, myCorps, myCaptionCount } = yield* legalityState(
          input.leagueId,
          input.userId
        );
        const reason = legalityError({
          caption: input.caption,
          captionCaps: config.captionCaps,
          oneCaptionPerCorps: config.oneCaptionPerCorps,
          memberCaptionCount: myCaptionCount.get(input.caption) ?? 0,
          memberHasCorps: myCorps.has(input.corpsKey),
          pairTakenInLeague: takenPairs.has(`${input.corpsKey}|${input.caption}`),
          inPool: pool.has(input.corpsKey),
        });
        if (reason) return yield* Effect.fail(new DraftConflict({ reason }));

        yield* commitPickAndAdvance(input.leagueId, draft, {
          userId: input.userId,
          corpsKey: input.corpsKey,
          caption: input.caption,
          autoPicked: false,
          config,
        });
        yield* broadcast(input.leagueId, { event: 'pick', data: yield* snapshot(input.leagueId) });
      })
    );
  });

  const pause = Effect.fn('DraftService.pause')(function* (leagueId: string) {
    yield* lockFor(leagueId).withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* loadDraft(leagueId);
        if (!rows[0]) return yield* Effect.fail(new DraftConflict({ reason: 'not-live' }));
        const move = draftReducer(toMachineState(mapDraft(rows[0])), { type: 'PAUSE' });
        if (!move.ok) return yield* Effect.fail(reducerError(move.reason));
        yield* Effect.sync(() => clearTimer(leagueId));
        yield* sql`
          UPDATE fantasy_drafts SET status = 'paused', pick_deadline_at = NULL WHERE league_id = ${leagueId}
        `.pipe(Effect.orDie);
        yield* broadcast(leagueId, { event: 'state', data: { status: 'paused' } });
      })
    );
  });

  const resume = Effect.fn('DraftService.resume')(function* (leagueId: string) {
    yield* lockFor(leagueId).withPermits(1)(
      Effect.gen(function* () {
        const rows = yield* loadDraft(leagueId);
        if (!rows[0]) return yield* Effect.fail(new DraftConflict({ reason: 'not-paused' }));
        const move = draftReducer(toMachineState(mapDraft(rows[0])), { type: 'RESUME' });
        if (!move.ok) return yield* Effect.fail(reducerError(move.reason));
        const deadline = new Date(Date.now() + Number(rows[0].pick_seconds) * 1000).toISOString();
        yield* sql`
          UPDATE fantasy_drafts SET status = 'live', pick_deadline_at = ${deadline} WHERE league_id = ${leagueId}
        `.pipe(Effect.orDie);
        yield* Effect.sync(() => armTimer(leagueId, deadline));
        yield* broadcast(leagueId, { event: 'snapshot', data: yield* snapshot(leagueId) });
      })
    );
  });

  const getSnapshot = Effect.fn('DraftService.getSnapshot')(function* (leagueId: string) {
    yield* ensureSelfHeal;
    return yield* snapshot(leagueId);
  });

  const autoPick = Effect.fn('DraftService.runAutoPickIfDue')(function* (
    leagueId: string,
    expectedDeadline?: string
  ) {
    yield* runAutoPickIfDue(leagueId, expectedDeadline);
  });

  // A member's auto-pick queue (§12.5). Authz (active membership) is enforced at
  // the boundary; userId is always the acting member's own id.
  const getQueue = Effect.fn('DraftService.getQueue')(function* (input: {
    leagueId: string;
    userId: string;
  }) {
    const rows = yield* sql<{ corps_key: string; caption: string | null }>`
      SELECT corps_key, caption FROM fantasy_draft_queue
      WHERE league_id = ${input.leagueId} AND user_id = ${input.userId}
      ORDER BY seq ASC
    `.pipe(Effect.orDie);
    return {
      entries: rows.map((r) => ({
        corpsKey: r.corps_key,
        caption: (r.caption as CaptionKey | null) ?? null,
      })),
    };
  });

  const setQueue = Effect.fn('DraftService.setQueue')(function* (input: {
    leagueId: string;
    userId: string;
    entries: ReadonlyArray<{ corpsKey: string; caption: CaptionKey | null }>;
  }) {
    yield* requireDurableStorage;
    // Replace the whole queue atomically (re-sequenced 0..n by array order).
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM fantasy_draft_queue WHERE league_id = ${input.leagueId} AND user_id = ${input.userId}`;
          for (let seq = 0; seq < input.entries.length; seq++) {
            const e = input.entries[seq];
            yield* sql`
              INSERT INTO fantasy_draft_queue (league_id, user_id, seq, corps_key, caption)
              VALUES (${input.leagueId}, ${input.userId}, ${seq}, ${e.corpsKey}, ${e.caption})
            `;
          }
        })
      )
      .pipe(Effect.orDie);
    return { ok: true as const };
  });

  // Auto-start any scheduled draft whose time has arrived — the cron dispatcher calls
  // this every minute. Per-draft `auto_start` opt-in. A draft that isn't feasible yet
  // (e.g. <2 members) just stays scheduled for the owner; we never poison-loop on it.
  const startDueScheduledDrafts = Effect.fn('DraftService.startDueScheduledDrafts')(function* () {
    const now = new Date().toISOString();
    const due = yield* sql<{ league_id: string }>`
      SELECT league_id FROM fantasy_drafts
      WHERE status = 'scheduled' AND auto_start = 1
        AND scheduled_at IS NOT NULL AND scheduled_at <= ${now}
    `.pipe(Effect.orDie);
    let started = 0;
    for (const r of due) {
      const res = yield* start(r.league_id).pipe(
        Effect.catchAll(() => Effect.succeed({ ok: false as const }))
      );
      if (res.ok) started++;
    }
    return { started };
  });

  return {
    start,
    startDueScheduledDrafts,
    makePick,
    pause,
    resume,
    getSnapshot,
    runAutoPickIfDue: autoPick,
    getQueue,
    setQueue,
  };
});

export class DraftService extends Context.Service<
  DraftService,
  Effect.Success<typeof makeDraftService>
>()('DraftService') {}

export const DraftServiceLive = Layer.effect(DraftService, makeDraftService).pipe(
  Layer.provide(ContributionsSqlLive)
);
