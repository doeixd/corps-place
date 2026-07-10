/**
 * Live draft engine (Fantasy DCI plan §9, Appendix H.3 + E.2). SERVER-ONLY.
 *
 * Owns the stateful parts the pure `draft.ts` math can't: per-league
 * serialization, the authoritative pick clock + auto-picker, persistence to
 * `contributions.db`, and fan-out via the in-memory bus. The DB is the source of
 * truth; timers are re-derived from it so a deploy mid-draft self-heals (H.3).
 *
 * Single-process assumption (A8/V1): the lock + timers are in-memory.
 */
import type { Client, Row } from '@libsql/client';
import { getContributionsDb } from '@/lib/contributions-db';
import { broadcast } from './bus';
import { sendPushToUser } from './push';
import { getDraftPool, getPriorSeasonRanking, rankingKey } from './score-db';
import { isCaptionKey, CAPTION_KEYS, type CaptionKey } from './captions';
import { resolveDraftOrder, type DraftMember } from './draft-order';
import type { LeagueConfig } from './config';
import {
  userAt,
  pickWeight,
  isDraftComplete,
  legalityError,
  selectAutoPick,
  type DraftType,
} from './draft';

// --- per-league serialization (single writer per draft, §9.3) ----------------

const chains = new Map<string, Promise<unknown>>();

/** Run `fn` after any in-flight operation for this league has settled. */
function withLock<T>(leagueId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(leagueId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    leagueId,
    next.catch(() => {})
  );
  return next;
}

// --- auto-pick timers (re-armed from DB; self-healing) -----------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();

// Grace past the displayed deadline. A pick clicked at 0:00 still has to cross the
// network and wait for the per-league lock, so a hard millisecond cutoff rejects timely
// picks and hands the slot to the auto-picker (the rejected pick never advances, so the
// clock keeps running and the auto-pick fires — the "doesn't move on / auto-picked me"
// bug). The auto-pick fiber waits this long past the deadline and makePick accepts until
// the same moment, so the two agree.
const PICK_GRACE_MS = 2000;

function clearTimer(leagueId: string): void {
  const t = timers.get(leagueId);
  if (t) {
    clearTimeout(t);
    timers.delete(leagueId);
  }
}

function armTimer(leagueId: string, deadlineIso: string): void {
  clearTimer(leagueId);
  const ms = Math.max(0, new Date(deadlineIso).getTime() - Date.now()) + PICK_GRACE_MS;
  timers.set(
    leagueId,
    // Bind the callback to the exact deadline it was armed for, so a callback that
    // fires after a newer pick re-armed the clock can detect it's stale.
    setTimeout(() => {
      void runAutoPickIfDue(leagueId, deadlineIso);
    }, ms)
  );
}

let selfHealed = false;
/** Re-arm timers for any draft left `live` by a previous process (H.3). */
async function ensureSelfHeal(): Promise<void> {
  if (selfHealed) return;
  selfHealed = true;
  const db = await getContributionsDb();
  const live = await db.execute(
    "SELECT league_id, pick_deadline_at FROM fantasy_drafts WHERE status = 'live'"
  );
  for (const row of live.rows) {
    const leagueId = row.league_id as string;
    const deadline = row.pick_deadline_at as string | null;
    if (deadline) armTimer(leagueId, deadline);
  }
}

// --- snapshot ----------------------------------------------------------------

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

const loadDraftRow = async (db: Client, leagueId: string): Promise<Row | undefined> =>
  (await db.execute({ sql: 'SELECT * FROM fantasy_drafts WHERE league_id = ?', args: [leagueId] }))
    .rows[0];

const mapDraft = (d: Row): NonNullable<DraftSnapshot['draft']> => ({
  status: d.status as string,
  draftType: d.draft_type as DraftType,
  pickSeconds: Number(d.pick_seconds),
  totalRounds: Number(d.total_rounds),
  currentPickNo: Number(d.current_pick_no),
  currentUserId: (d.current_user_id as string | null) ?? null,
  pickDeadlineAt: (d.pick_deadline_at as string | null) ?? null,
  scheduledAt: (d.scheduled_at as string | null) ?? null,
  autoStart: Number(d.auto_start ?? 1) !== 0,
  order: d.order_json ? (JSON.parse(d.order_json as string) as string[]) : [],
});

const loadPicks = async (db: Client, leagueId: string): Promise<DraftSnapshot['picks']> =>
  (
    await db.execute({
      sql: 'SELECT user_id, corps_key, caption, round, pick_no, weight, auto_picked FROM fantasy_picks WHERE league_id = ? ORDER BY pick_no',
      args: [leagueId],
    })
  ).rows.map((p) => ({
    userId: p.user_id as string,
    corpsKey: p.corps_key as string,
    caption: p.caption as CaptionKey,
    round: Number(p.round),
    pickNo: Number(p.pick_no),
    weight: Number(p.weight),
    autoPicked: Boolean(p.auto_picked),
  }));

export async function getSnapshot(leagueId: string): Promise<DraftSnapshot> {
  await ensureSelfHeal();
  const db = await getContributionsDb();
  const draftRow = await loadDraftRow(db, leagueId);
  return {
    draft: draftRow ? mapDraft(draftRow) : null,
    picks: await loadPicks(db, leagueId),
  };
}

// --- shared helpers ----------------------------------------------------------

const loadConfig = async (db: Client, leagueId: string): Promise<LeagueConfig> => {
  const row = (
    await db.execute({
      sql: 'SELECT config_json FROM fantasy_leagues WHERE league_id = ?',
      args: [leagueId],
    })
  ).rows[0];
  if (!row) throw new Error('NOT_FOUND');
  return JSON.parse(row.config_json as string) as LeagueConfig;
};

const divisionKey = (name: string | null): 'world' | 'open' | null => {
  const d = (name ?? '').toLowerCase();
  if (d.includes('open')) return 'open';
  if (d.includes('world')) return 'world';
  return null;
};

/**
 * Draftable corps keys restricted to the league's allowed divisions (config).
 * `season` is the league's OWN season — the corps performing that season (a 2026
 * league drafts the 2026 field) — see getDraftPool.
 */
async function poolKeysForLeague(config: LeagueConfig, season: string): Promise<Set<string>> {
  const allowed = new Set<string>(config.allowedDivisions);
  const pool = await getDraftPool(season);
  return new Set(
    pool
      .filter((c) => {
        const key = divisionKey(c.divisionName);
        return key != null && allowed.has(key);
      })
      .map((c) => c.corpsKey)
  );
}

/** Live league pick state used for legality checks (U1/U2/U3). */
async function legalityState(db: Client, leagueId: string, userId: string) {
  const picks = (
    await db.execute({
      sql: 'SELECT user_id, corps_key, caption FROM fantasy_picks WHERE league_id = ?',
      args: [leagueId],
    })
  ).rows;
  const takenPairs = new Set<string>(); // `${corpsKey}|${caption}` (U1)
  const myCorps = new Set<string>(); // U2
  const myCaptionCount = new Map<CaptionKey, number>(); // U3
  for (const p of picks) {
    const corpsKey = p.corps_key as string;
    const caption = p.caption as CaptionKey;
    takenPairs.add(`${corpsKey}|${caption}`);
    if ((p.user_id as string) === userId) {
      myCorps.add(corpsKey);
      myCaptionCount.set(caption, (myCaptionCount.get(caption) ?? 0) + 1);
    }
  }
  return { takenPairs, myCorps, myCaptionCount };
}

/** Persist the pick at the current slot and advance the clock (or finalize). */
async function commitPickAndAdvance(
  db: Client,
  leagueId: string,
  draft: NonNullable<DraftSnapshot['draft']>,
  pick: {
    userId: string;
    corpsKey: string;
    caption: CaptionKey;
    autoPicked: boolean;
    config: LeagueConfig;
  } | null
): Promise<void> {
  const now = new Date().toISOString();

  if (pick) {
    const priorByMember = (
      await db.execute({
        sql: 'SELECT caption FROM fantasy_picks WHERE league_id = ? AND user_id = ?',
        args: [leagueId, pick.userId],
      })
    ).rows;
    const round = priorByMember.length + 1; // member's pick ordinal == draft round
    const captionSlotIndex =
      priorByMember.filter((r) => (r.caption as string) === pick.caption).length + 1;
    // Weight by the slot WITHIN the caption (increasing per slot), not the global
    // draft round — every player's Nth corps in a caption weighs the same.
    const captionCap = pick.config.captionCaps[pick.caption];
    const weight = pickWeight(captionSlotIndex, captionCap, pick.config.reverseWeighting);
    await db.execute({
      sql: `INSERT INTO fantasy_picks
              (pick_id, league_id, user_id, corps_key, caption, round, pick_no, caption_slot_index, weight, auto_picked, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        leagueId,
        pick.userId,
        pick.corpsKey,
        pick.caption,
        round,
        draft.currentPickNo,
        captionSlotIndex,
        weight,
        pick.autoPicked ? 1 : 0,
        now,
      ],
    });
  }

  const memberCount = draft.order.length;
  const nextPickNo = draft.currentPickNo + 1;

  if (isDraftComplete(nextPickNo, memberCount, draft.totalRounds)) {
    await db.batch(
      [
        {
          sql: `UPDATE fantasy_drafts SET status = 'complete', current_user_id = NULL,
                  pick_deadline_at = NULL, completed_at = ? WHERE league_id = ?`,
          args: [now, leagueId],
        },
        {
          sql: "UPDATE fantasy_leagues SET status = 'active', updated_at = ? WHERE league_id = ?",
          args: [now, leagueId],
        },
      ],
      'write'
    );
    clearTimer(leagueId);
    broadcast(leagueId, { event: 'state', data: { status: 'complete' } });
    // Seed standings immediately: scoring is season-best (§5.2), so a league
    // drafted MID-SEASON already has real points from every prior show — but
    // the recompute otherwise only runs after the NEXT score ingest, leaving
    // the fresh league's standings empty for potentially days. Fire-and-forget:
    // on failure, standings simply appear on the next ingest cycle as before.
    void (async () => {
      const { recomputeFantasyStandingsForSeason } = await import('./standings');
      const season = await leagueSeason(db, leagueId);
      await recomputeFantasyStandingsForSeason(season);
    })().catch(() => {});
    return;
  }

  const nextUser = userAt(draft.order, nextPickNo, draft.draftType);
  const deadline = new Date(Date.now() + draft.pickSeconds * 1000).toISOString();
  await db.execute({
    sql: `UPDATE fantasy_drafts SET current_pick_no = ?, current_user_id = ?, pick_deadline_at = ? WHERE league_id = ?`,
    args: [nextPickNo, nextUser, deadline, leagueId],
  });
  armTimer(leagueId, deadline);
  notifyOnClock(nextUser);
}

/** Fire-and-forget "you're on the clock" push (M5); never blocks the draft lock. */
function notifyOnClock(userId: string): void {
  void sendPushToUser(userId, {
    title: "You're on the clock",
    body: 'Make your fantasy draft pick before the timer runs out.',
    url: '/fantasy',
  }).catch(() => {});
}

// --- lifecycle: start --------------------------------------------------------

export type StartFeasibility = { ok: true } | { ok: false; reason: string };

/**
 * Resolve order (E.1), set the draft live, arm the clock, broadcast. Caller has
 * already verified ownership/preconditions. Returns a feasibility failure
 * (R4) instead of starting when the pool can't fill every roster.
 */
export async function startDraft(leagueId: string): Promise<StartFeasibility> {
  await ensureSelfHeal();
  return withLock(leagueId, async () => {
    const db = await getContributionsDb();
    const draftRow = await loadDraftRow(db, leagueId);
    if (!draftRow) throw new Error('CONFLICT:not-scheduled');
    if ((draftRow.status as string) !== 'scheduled') throw new Error('CONFLICT:already-started');

    const config = await loadConfig(db, leagueId);
    const memberRows = (
      await db.execute({
        sql: `SELECT m.user_id, m.quiz_score, m.corps_name, a.completed_at
              FROM fantasy_members m
              LEFT JOIN fantasy_quiz_attempts a
                ON a.league_id = m.league_id AND a.user_id = m.user_id AND a.completed_at IS NOT NULL
              WHERE m.league_id = ? AND m.status = 'active'`,
        args: [leagueId],
      })
    ).rows;

    // Solo leagues can draft (a 1-member draft is just picking your roster) —
    // only an EMPTY league can't start. 'need-two-members' copy retired with it.
    if (memberRows.length < 1) throw new Error('CONFLICT:need-two-members');
    if (memberRows.some((m) => !m.corps_name)) throw new Error('CONFLICT:identities-incomplete');

    const totalRounds = Number(draftRow.total_rounds);
    const season = await leagueSeason(db, leagueId);
    const poolSize = (await poolKeysForLeague(config, season)).size;
    const feasible = checkFeasibility(memberRows.length, totalRounds, poolSize, config);
    if (!feasible.ok) return feasible;

    const members: DraftMember[] = memberRows.map((m) => ({
      userId: m.user_id as string,
      quizScore: m.quiz_score == null ? null : Number(m.quiz_score),
      completedAt: (m.completed_at as string | null) ?? null,
    }));
    const order = resolveDraftOrder(members, config.quizOrderDir, leagueId);

    const now = new Date().toISOString();
    const deadline = new Date(Date.now() + Number(draftRow.pick_seconds) * 1000).toISOString();
    await db.batch(
      [
        {
          sql: `UPDATE fantasy_drafts
                SET status = 'live', order_json = ?, current_pick_no = 0,
                    current_user_id = ?, pick_deadline_at = ?, started_at = ?
                WHERE league_id = ?`,
          args: [JSON.stringify(order), order[0], deadline, now, leagueId],
        },
        {
          sql: "UPDATE fantasy_leagues SET status = 'drafting', updated_at = ? WHERE league_id = ?",
          args: [now, leagueId],
        },
      ],
      'write'
    );
    armTimer(leagueId, deadline);
    notifyOnClock(order[0]);
    broadcast(leagueId, { event: 'snapshot', data: await getSnapshot(leagueId) });
    return { ok: true };
  });
}

/**
 * Start every due auto-start scheduled draft — the LEGACY engine's cron hook,
 * mirroring DraftService.startDueScheduledDrafts. Without this, prod (which runs
 * the legacy engine — FANTASY_EFFECT_DRAFT unset) never honored "start the draft
 * automatically at the scheduled time": the dispatch cron only ran the Effect
 * implementation. A draft that isn't startable yet (<2 members, identities
 * incomplete, infeasible pool) simply stays scheduled for the owner — failures
 * are swallowed per league so one bad draft can't poison the loop.
 */
export async function startDueScheduledDrafts(): Promise<{ started: number }> {
  const db = await getContributionsDb();
  const due = await db.execute({
    sql: `SELECT league_id FROM fantasy_drafts
          WHERE status = 'scheduled' AND auto_start = 1
            AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
    args: [new Date().toISOString()],
  });
  let started = 0;
  for (const row of due.rows) {
    try {
      const res = await startDraft(String(row.league_id));
      if (res.ok) started++;
    } catch {
      /* not startable yet — stays scheduled; never abort the sweep */
    }
  }
  return { started };
}

/**
 * Cheap necessary-condition feasibility (R4): every member needs `totalRounds`
 * distinct corps (when oneCaptionPerCorps), and the league needs M*R unique
 * (corps,caption) pairs overall. Not a full matching proof, but it catches the
 * obviously-unfillable cases before the draft starts.
 */
function checkFeasibility(
  memberCount: number,
  totalRounds: number,
  poolSize: number,
  config: LeagueConfig
): StartFeasibility {
  if (config.oneCaptionPerCorps && poolSize < totalRounds) {
    return {
      ok: false,
      reason: `Pool of ${poolSize} corps can't fill ${totalRounds} roster slots per member.`,
    };
  }
  const totalPairsNeeded = memberCount * totalRounds;
  const pairsAvailable = poolSize * CAPTION_KEYS.length;
  if (totalPairsNeeded > pairsAvailable) {
    return {
      ok: false,
      reason: `Not enough unique corps/caption combinations for ${memberCount} members.`,
    };
  }
  return { ok: true };
}

// --- makePick ----------------------------------------------------------------

export async function makePick(
  leagueId: string,
  userId: string,
  corpsKey: string,
  caption: string
): Promise<void> {
  await ensureSelfHeal();
  return withLock(leagueId, async () => {
    const db = await getContributionsDb();
    const draftRow = await loadDraftRow(db, leagueId);
    if (!draftRow) throw new Error('NOT_FOUND');
    const draft = mapDraft(draftRow);

    if (draft.status !== 'live') throw new Error('CONFLICT:not-live');
    if (draft.currentUserId !== userId) throw new Error('FORBIDDEN');
    // Accept until deadline + the same grace the auto-pick timer waits; the turn check
    // above + the per-league lock keep it correct (if the auto-pick already fired it's no
    // longer your turn → FORBIDDEN above; otherwise this pick wins the lock).
    if (draft.pickDeadlineAt && new Date(draft.pickDeadlineAt).getTime() + PICK_GRACE_MS < Date.now()) {
      throw new Error('CONFLICT:expired');
    }
    if (!isCaptionKey(caption)) throw new Error('CONFLICT:bad-caption');

    const config = await loadConfig(db, leagueId);
    const season = await leagueSeason(db, leagueId);
    const pool = await poolKeysForLeague(config, season);
    const { takenPairs, myCorps, myCaptionCount } = await legalityState(db, leagueId, userId);

    const reason = legalityError({
      caption,
      captionCaps: config.captionCaps,
      oneCaptionPerCorps: config.oneCaptionPerCorps,
      memberCaptionCount: myCaptionCount.get(caption) ?? 0,
      memberHasCorps: myCorps.has(corpsKey),
      pairTakenInLeague: takenPairs.has(`${corpsKey}|${caption}`),
      inPool: pool.has(corpsKey),
    });
    if (reason) throw new Error(`CONFLICT:${reason}`);

    await commitPickAndAdvance(db, leagueId, draft, {
      userId,
      corpsKey,
      caption,
      autoPicked: false,
      config,
    });
    broadcast(leagueId, { event: 'pick', data: await getSnapshot(leagueId) });
  });
}

// --- auto-pick ---------------------------------------------------------------

/** A flat, prior-season-ranked list of every (corps, caption) option in the pool. */
async function rankedOptions(
  prevSeason: string,
  poolKeys: Set<string>
): Promise<Array<{ corpsKey: string; caption: CaptionKey; score: number }>> {
  const ranking = await getPriorSeasonRanking(prevSeason);
  const options: Array<{ corpsKey: string; caption: CaptionKey; score: number }> = [];
  for (const corpsKey of poolKeys) {
    for (const caption of CAPTION_KEYS) {
      options.push({
        corpsKey,
        caption,
        score: ranking.get(rankingKey(corpsKey, caption)) ?? -Infinity,
      });
    }
  }
  // Highest prior-season score first; -Infinity (no finals row) sinks to the bottom.
  options.sort((a, b) => b.score - a.score);
  return options;
}

export async function runAutoPickIfDue(leagueId: string, expectedDeadline?: string): Promise<void> {
  return withLock(leagueId, async () => {
    const db = await getContributionsDb();
    const draftRow = await loadDraftRow(db, leagueId);
    if (!draftRow) return;
    const draft = mapDraft(draftRow);
    if (draft.status !== 'live' || !draft.currentUserId) return;
    // Stale timer: a newer pick re-armed the clock to a different deadline, so this
    // fired callback is for a slot that's already been handled — exact-match bail.
    if (expectedDeadline && draft.pickDeadlineAt !== expectedDeadline) return;

    const config = await loadConfig(db, leagueId);
    const season = await leagueSeason(db, leagueId);
    const prevSeason = String(Number(season) - 1);
    const pool = await poolKeysForLeague(config, season);
    const { takenPairs, myCorps, myCaptionCount } = await legalityState(
      db,
      leagueId,
      draft.currentUserId
    );
    const options = await rankedOptions(prevSeason, pool);

    const choice = selectAutoPick(
      options,
      (o) =>
        legalityError({
          caption: o.caption,
          captionCaps: config.captionCaps,
          oneCaptionPerCorps: config.oneCaptionPerCorps,
          memberCaptionCount: myCaptionCount.get(o.caption) ?? 0,
          memberHasCorps: myCorps.has(o.corpsKey),
          pairTakenInLeague: takenPairs.has(`${o.corpsKey}|${o.caption}`),
          inPool: pool.has(o.corpsKey),
        }) === null
    );

    // R4 fallback: if no legal pick exists, skip the slot (it scores 0).
    await commitPickAndAdvance(
      db,
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
    broadcast(leagueId, { event: 'pick', data: await getSnapshot(leagueId) });
  });
}

const leagueSeason = async (db: Client, leagueId: string): Promise<string> => {
  const row = (
    await db.execute({
      sql: 'SELECT season FROM fantasy_leagues WHERE league_id = ?',
      args: [leagueId],
    })
  ).rows[0];
  return (row?.season as string) ?? '2026';
};

// --- pause / resume ----------------------------------------------------------

export async function pauseDraft(leagueId: string): Promise<void> {
  return withLock(leagueId, async () => {
    const db = await getContributionsDb();
    const draftRow = await loadDraftRow(db, leagueId);
    if (!draftRow || (draftRow.status as string) !== 'live') throw new Error('CONFLICT:not-live');
    clearTimer(leagueId);
    // Freeze remaining time by storing it in pick_deadline_at as a duration marker:
    // simplest correct approach is to drop the deadline and resume with a fresh clock.
    await db.execute({
      sql: "UPDATE fantasy_drafts SET status = 'paused', pick_deadline_at = NULL WHERE league_id = ?",
      args: [leagueId],
    });
    broadcast(leagueId, { event: 'state', data: { status: 'paused' } });
  });
}

export async function resumeDraft(leagueId: string): Promise<void> {
  return withLock(leagueId, async () => {
    const db = await getContributionsDb();
    const draftRow = await loadDraftRow(db, leagueId);
    if (!draftRow || (draftRow.status as string) !== 'paused')
      throw new Error('CONFLICT:not-paused');
    const deadline = new Date(Date.now() + Number(draftRow.pick_seconds) * 1000).toISOString();
    await db.execute({
      sql: "UPDATE fantasy_drafts SET status = 'live', pick_deadline_at = ? WHERE league_id = ?",
      args: [deadline, leagueId],
    });
    armTimer(leagueId, deadline);
    broadcast(leagueId, { event: 'snapshot', data: await getSnapshot(leagueId) });
  });
}
