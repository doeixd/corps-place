/**
 * Integration test for DraftService (migration plan P3 acceptance) — the Effect
 * port of the live draft engine, against real temp libsql DBs. Mirrors
 * `../draft-engine.integration.test.ts` but drives the service via runPromise:
 * full snake draft (order/weights/completion), legality under the unique indexes
 * (out-of-turn → Forbidden, duplicate pair → DraftConflict 'pair-taken'), and
 * auto-pick by prior-season rank.
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { Effect } from 'effect';
import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLeagueConfig, totalRounds } from '../config';

let DraftService: typeof import('./draft-service').DraftService;
let DraftServiceLive: typeof import('./draft-service').DraftServiceLive;
let contribDb: Client;

const CONFIG = resolveLeagueConfig({
  draftType: 'snake',
  captionCaps: { GE1: 1, GE2: 1, VP: 0, VA: 0, CG: 0, MB: 0, MA: 0, MP: 0 }, // 2 rounds
  reverseWeighting: { enabled: true, minWeight: 1.0, maxWeight: 2.0 },
});
const ROUNDS = totalRounds(CONFIG);

let leagueSeq = 0;

async function seedLeague(): Promise<{ leagueId: string; userA: string; userB: string }> {
  const n = ++leagueSeq;
  const leagueId = `lg-${n}`;
  const userA = `uA-${n}`;
  const userB = `uB-${n}`;
  const now = new Date().toISOString();
  await contribDb.batch(
    [
      {
        sql: `INSERT INTO fantasy_leagues (league_id, slug, name, owner_user_id, season, status, config_json, max_members, payment_status, created_at, updated_at)
              VALUES (?, ?, 'L', ?, '2026', 'setup', ?, 12, 'none', ?, ?)`,
        args: [leagueId, `slug-${n}`, userA, JSON.stringify(CONFIG), now, now],
      },
      {
        sql: `INSERT INTO fantasy_members (league_id, user_id, role, corps_name, status, joined_at) VALUES (?, ?, 'owner', 'Alpha', 'active', ?)`,
        args: [leagueId, userA, now],
      },
      {
        sql: `INSERT INTO fantasy_members (league_id, user_id, role, corps_name, status, joined_at) VALUES (?, ?, 'member', 'Bravo', 'active', ?)`,
        args: [leagueId, userB, now],
      },
      {
        sql: `INSERT INTO fantasy_drafts (draft_id, league_id, status, draft_type, pick_seconds, total_rounds, current_pick_no)
              VALUES (?, ?, 'scheduled', 'snake', 600, ?, 0)`,
        args: [`dr-${n}`, leagueId, ROUNDS],
      },
    ],
    'write'
  );
  return { leagueId, userA, userB };
}

const run = <A, E>(eff: Effect.Effect<A, E, import('./draft-service').DraftService>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provide(DraftServiceLive)));

const start = (leagueId: string) => run(Effect.flatMap(DraftService, (s) => s.start(leagueId)));
const snapshot = (leagueId: string) =>
  run(Effect.flatMap(DraftService, (s) => s.getSnapshot(leagueId)));
const makePick = (leagueId: string, userId: string, corpsKey: string, caption: string) =>
  run(Effect.flatMap(DraftService, (s) => s.makePick({ leagueId, userId, corpsKey, caption })));
const pause = (leagueId: string) => run(Effect.flatMap(DraftService, (s) => s.pause(leagueId)));
const autoPick = (leagueId: string) =>
  run(Effect.flatMap(DraftService, (s) => s.runAutoPickIfDue(leagueId)));

/** Run an effect expecting rejection; return the rejected (typed) error. */
async function rejection(p: Promise<unknown>): Promise<{ _tag?: string; reason?: string }> {
  try {
    await p;
    throw new Error('expected a rejection');
  } catch (e) {
    return e as { _tag?: string; reason?: string };
  }
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-draftsvc-it-'));
  process.env.CONTRIBUTIONS_DB_URL = `file:${path.join(dir, 'contrib.db')}`;
  process.env.DCI_RELATIONAL_DB_URL = `file:${path.join(dir, 'score.db')}`;

  const score = createClient({ url: process.env.DCI_RELATIONAL_DB_URL });
  await score.batch(
    [
      `CREATE TABLE corps (corps_key TEXT PRIMARY KEY, name TEXT, slug TEXT, division_name TEXT, display_city TEXT, corps_logo TEXT, corps_logo_dark INTEGER, corps_logo_dark_url TEXT)`,
      `CREATE TABLE competitions (slug TEXT PRIMARY KEY, season TEXT, date TEXT)`,
      `CREATE TABLE corps_scores (competition_slug TEXT, corps_key TEXT, division_name TEXT)`,
      `CREATE TABLE caption_scores (competition_slug TEXT, corps_key TEXT, caption_name TEXT, score REAL)`,
      `CREATE TABLE events (slug TEXT PRIMARY KEY, season TEXT)`,
      `CREATE TABLE event_participants (event_slug TEXT, participant_id TEXT, corps_key TEXT)`,
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(
        (k) =>
          `INSERT INTO corps VALUES ('${k}', '${k.toUpperCase()}', '${k}', 'World Class', 'City', NULL, NULL, NULL)`
      ),
      // Pool = corps PERFORMING the league's season (2026), from the season's event
      // lineups — all six corps are in a 2026 show.
      `INSERT INTO events VALUES ('2026-show', '2026')`,
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(
        (k) => `INSERT INTO event_participants VALUES ('2026-show', 'p${k}', '${k}')`
      ),
      // Prior-season (2025) finals scores feed auto-pick ranking only, not the pool.
      `INSERT INTO competitions VALUES ('2025-world-championship-finals', '2025', '2025-08-09')`,
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(
        (k) =>
          `INSERT INTO corps_scores VALUES ('2025-world-championship-finals', '${k}', 'World Class')`
      ),
      `INSERT INTO caption_scores VALUES ('2025-world-championship-finals', 'c1', 'General Effect 1', 19.5)`,
      `INSERT INTO caption_scores VALUES ('2025-world-championship-finals', 'c2', 'General Effect 1', 18.0)`,
    ],
    'write'
  );

  const stub = createClient({ url: process.env.CONTRIBUTIONS_DB_URL });
  await stub.execute(
    'CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, image TEXT, role TEXT)'
  );

  ({ DraftService, DraftServiceLive } = await import('./draft-service'));
  const { getContributionsDb } = await import('@/lib/contributions-db');
  contribDb = await getContributionsDb();
});

describe('DraftService — startDraft + makePick advance (Effect path)', () => {
  it('runs a full 2×2 snake draft with correct order, weights, and completion', async () => {
    const { leagueId } = await seedLeague();
    const started = await start(leagueId);
    expect(started).toEqual({ ok: true });

    let snap = await snapshot(leagueId);
    expect(snap.draft?.status).toBe('live');
    const order = snap.draft!.order;
    expect(order).toHaveLength(2);
    const [A, B] = order;
    expect(snap.draft!.currentUserId).toBe(A);

    const plan: Array<[string, string, 'GE1' | 'GE2']> = [
      [A, 'c1', 'GE1'],
      [B, 'c2', 'GE1'],
      [B, 'c3', 'GE2'],
      [A, 'c4', 'GE2'],
    ];
    for (const [user, corps, caption] of plan) {
      snap = await snapshot(leagueId);
      expect(snap.draft!.currentUserId).toBe(user);
      await makePick(leagueId, user, corps, caption);
    }

    snap = await snapshot(leagueId);
    expect(snap.draft!.status).toBe('complete');

    const league = (
      await contribDb.execute({
        sql: 'SELECT status FROM fantasy_leagues WHERE league_id = ?',
        args: [leagueId],
      })
    ).rows[0];
    expect(league.status).toBe('active');

    const picks = snap.picks;
    expect(picks).toHaveLength(4);
    // Weight is by SLOT within the caption: every pick here is slot 1 of a cap-1
    // caption (GE1 then GE2), so all weigh minWeight (1.0). The per-slot ramp is
    // covered directly by the pickWeight unit tests.
    const byRound = Object.fromEntries(picks.map((p) => [`${p.userId}:${p.round}`, p]));
    expect(byRound[`${A}:1`].weight).toBeCloseTo(1.0, 5);
    expect(byRound[`${A}:2`].weight).toBeCloseTo(1.0, 5);
    expect(byRound[`${B}:1`].weight).toBeCloseTo(1.0, 5);
    expect(byRound[`${B}:2`].weight).toBeCloseTo(1.0, 5);
  });

  it('rejects a pick out of turn (Forbidden) and a duplicate pair (DraftConflict)', async () => {
    const { leagueId, userA, userB } = await seedLeague();
    await start(leagueId);
    const snap = await snapshot(leagueId);
    const onClock = snap.draft!.currentUserId!;
    const offClock = onClock === userA ? userB : userA;

    const offTurn = await rejection(makePick(leagueId, offClock, 'c1', 'GE1'));
    expect(offTurn._tag).toBe('Forbidden');

    await makePick(leagueId, onClock, 'c1', 'GE1'); // legal
    const next = (await snapshot(leagueId)).draft!.currentUserId!;
    const dup = await rejection(makePick(leagueId, next, 'c1', 'GE1'));
    expect(dup._tag).toBe('DraftConflict');
    expect(dup.reason).toBe('pair-taken');

    await pause(leagueId);
  });
});

describe('DraftService — auto-pick (Effect path)', () => {
  it('auto-picks the best legal corps by prior-season rank', async () => {
    const { leagueId } = await seedLeague();
    await start(leagueId);

    await autoPick(leagueId);

    const picks = (await snapshot(leagueId)).picks;
    expect(picks).toHaveLength(1);
    expect(picks[0].autoPicked).toBe(true);
    expect(picks[0].corpsKey).toBe('c1');
    expect(picks[0].caption).toBe('GE1');

    await pause(leagueId);
  });

  it('auto-picks from the member queue ahead of prior-season rank', async () => {
    const { leagueId } = await seedLeague();
    await start(leagueId);
    const onClock = (await snapshot(leagueId)).draft!.currentUserId!;
    // Queue prefers c4|GE2 even though c1|GE1 is the higher-ranked option.
    await run(
      Effect.flatMap(DraftService, (s) =>
        s.setQueue({ leagueId, userId: onClock, entries: [{ corpsKey: 'c4', caption: 'GE2' }] })
      )
    );

    await autoPick(leagueId);

    const pick = (await snapshot(leagueId)).picks.find((p) => p.userId === onClock);
    expect(pick?.corpsKey).toBe('c4');
    expect(pick?.caption).toBe('GE2');
    expect(pick?.autoPicked).toBe(true);

    await pause(leagueId);
  });
});
