/**
 * Integration test for the live draft engine against real temp libsql DBs.
 * Exercises the paths the pure unit tests can't: startDraft → makePick advance
 * (snake order, round/weight/slot, completion), legality under the unique
 * indexes, and runAutoPickIfDue. Uses throwaway file DBs (no app server).
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLeagueConfig, totalRounds } from './config';

type Engine = typeof import('./draft-engine');
let engine: Engine;
let contribDb: Client;

const CONFIG = resolveLeagueConfig({
  draftType: 'snake',
  captionCaps: { GE1: 1, GE2: 1, VP: 0, VA: 0, CG: 0, MB: 0, MA: 0, MP: 0 }, // 2 rounds
  reverseWeighting: { enabled: true, minWeight: 1.0, maxWeight: 2.0 },
});
const ROUNDS = totalRounds(CONFIG); // 2

let leagueSeq = 0;

/** Seed a fresh league (status active) with two identity-complete members + a scheduled snake draft. */
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

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-it-'));
  process.env.CONTRIBUTIONS_DB_URL = `file:${path.join(dir, 'contrib.db')}`;
  process.env.DCI_RELATIONAL_DB_URL = `file:${path.join(dir, 'score.db')}`;

  // Minimal score DB: a corps pool + a prior-season finals ranking for auto-pick.
  const score = createClient({ url: process.env.DCI_RELATIONAL_DB_URL });
  await score.batch(
    [
      `CREATE TABLE corps (corps_key TEXT PRIMARY KEY, name TEXT, slug TEXT, division_name TEXT, display_city TEXT, corps_logo TEXT)`,
      `CREATE TABLE competitions (slug TEXT PRIMARY KEY, season TEXT, date TEXT)`,
      `CREATE TABLE corps_scores (competition_slug TEXT, corps_key TEXT, division_name TEXT)`,
      `CREATE TABLE caption_scores (competition_slug TEXT, corps_key TEXT, caption_name TEXT, score REAL)`,
      ...['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(
        (k) =>
          `INSERT INTO corps VALUES ('${k}', '${k.toUpperCase()}', '${k}', 'World Class', 'City', NULL)`
      ),
      `INSERT INTO competitions VALUES ('2025-world-championship-finals', '2025', '2025-08-09')`,
      // c1 has the best prior-season GE1, then c2 — auto-pick should prefer c1|GE1.
      `INSERT INTO corps_scores VALUES ('2025-world-championship-finals', 'c1', 'World Class')`,
      `INSERT INTO corps_scores VALUES ('2025-world-championship-finals', 'c2', 'World Class')`,
      `INSERT INTO caption_scores VALUES ('2025-world-championship-finals', 'c1', 'General Effect 1', 19.5)`,
      `INSERT INTO caption_scores VALUES ('2025-world-championship-finals', 'c2', 'General Effect 1', 18.0)`,
    ],
    'write'
  );

  engine = await import('./draft-engine');
  const { getContributionsDb } = await import('@/lib/contributions-db');
  contribDb = await getContributionsDb();
});

describe('draft engine — startDraft + makePick advance', () => {
  it('runs a full 2×2 snake draft with correct order, weights, and completion', async () => {
    const { leagueId } = await seedLeague();
    // Leagues are 'setup'; recompute looks for active/complete, but startDraft only
    // needs the scheduled draft + ≥2 identity-complete members.
    const started = await engine.startDraft(leagueId);
    expect(started.ok).toBe(true);

    let snap = await engine.getSnapshot(leagueId);
    expect(snap.draft?.status).toBe('live');
    const order = snap.draft!.order;
    expect(order).toHaveLength(2);
    const [A, B] = order;
    expect(snap.draft!.currentUserId).toBe(A);

    // Snake pick sequence for M=2,R=2 is A,B,B,A.
    const plan: Array<[string, string, 'GE1' | 'GE2']> = [
      [A, 'c1', 'GE1'],
      [B, 'c2', 'GE1'],
      [B, 'c3', 'GE2'],
      [A, 'c4', 'GE2'],
    ];
    for (const [user, corps, caption] of plan) {
      snap = await engine.getSnapshot(leagueId);
      expect(snap.draft!.currentUserId).toBe(user); // turn order is correct
      await engine.makePick(leagueId, user, corps, caption);
    }

    snap = await engine.getSnapshot(leagueId);
    expect(snap.draft!.status).toBe('complete');

    // League flipped active; picks recorded with right rounds + reverse weights.
    const league = (
      await contribDb.execute({
        sql: 'SELECT status FROM fantasy_leagues WHERE league_id = ?',
        args: [leagueId],
      })
    ).rows[0];
    expect(league.status).toBe('active');

    const picks = snap.picks;
    expect(picks).toHaveLength(4);
    // round 1 picks weight 1.0, round 2 picks weight 2.0
    const byRound = Object.fromEntries(picks.map((p) => [`${p.userId}:${p.round}`, p]));
    expect(byRound[`${A}:1`].weight).toBeCloseTo(1.0, 5);
    expect(byRound[`${A}:2`].weight).toBeCloseTo(2.0, 5);
    expect(byRound[`${B}:1`].weight).toBeCloseTo(1.0, 5);
    expect(byRound[`${B}:2`].weight).toBeCloseTo(2.0, 5);
  });

  it('rejects a pick out of turn and a duplicate (corps,caption)', async () => {
    const { leagueId, userA, userB } = await seedLeague();
    await engine.startDraft(leagueId);
    const snap = await engine.getSnapshot(leagueId);
    const onClock = snap.draft!.currentUserId!;
    const offClock = onClock === userA ? userB : userA;

    await expect(engine.makePick(leagueId, offClock, 'c1', 'GE1')).rejects.toThrow('FORBIDDEN');

    await engine.makePick(leagueId, onClock, 'c1', 'GE1'); // legal
    const next = (await engine.getSnapshot(leagueId)).draft!.currentUserId!;
    // The same (corps,caption) is now taken — U1 rejects it for the next picker.
    await expect(engine.makePick(leagueId, next, 'c1', 'GE1')).rejects.toThrow(
      'CONFLICT:pair-taken'
    );

    await engine.pauseDraft(leagueId); // clear the live timer
  });
});

describe('draft engine — auto-pick', () => {
  it('auto-picks the best legal corps by prior-season rank', async () => {
    const { leagueId } = await seedLeague();
    await engine.startDraft(leagueId);

    await engine.runAutoPickIfDue(leagueId); // no expectedDeadline → not stale

    const picks = (await engine.getSnapshot(leagueId)).picks;
    expect(picks).toHaveLength(1);
    expect(picks[0].autoPicked).toBe(true);
    // c1 has the highest prior-season GE1 (19.5) → preferred option.
    expect(picks[0].corpsKey).toBe('c1');
    expect(picks[0].caption).toBe('GE1');

    await engine.pauseDraft(leagueId);
  });
});
