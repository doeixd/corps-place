/**
 * Integration test for the standings recompute against real temp libsql DBs.
 * Covers the M4 acceptance the unit tests can't: the full pipeline (season-best
 * lookup → buildStandings → DCI category math → fantasy_standings rows)
 * reproduces hand-computed values, is idempotent, and locks `is_final` once a
 * finals recap is present (§5.5/§5.6).
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLeagueConfig } from './config';
import { Effect } from 'effect';
import { CAPTION_KEYS, KEY_TO_CAPTION_NAME, type CaptionKey } from './captions';

// P4: the recompute orchestrator now lives in StandingsService; drive it via runPromise.
let recompute: (season: string) => Promise<{ leagues: number; members: number; finalized: number }>;
let getStandings: (slug: string, viewerId: string | null) => Promise<{ rows: { userId: string }[] }>;
let contribDb: Client;

const CONFIG = resolveLeagueConfig({}); // default weights 40/30/30, recap mode

// Appendix D worked example: one corps per caption, these season-best values.
const BEST: Record<CaptionKey, number> = {
  GE1: 19.4,
  GE2: 19.2,
  VP: 19.0,
  VA: 18.8,
  CG: 18.5,
  MB: 19.3,
  MA: 19.1,
  MP: 18.9,
};

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-standings-it-'));
  process.env.CONTRIBUTIONS_DB_URL = `file:${path.join(dir, 'contrib.db')}`;
  process.env.DCI_RELATIONAL_DB_URL = `file:${path.join(dir, 'score.db')}`;

  const score = createClient({ url: process.env.DCI_RELATIONAL_DB_URL });
  const captionRows = CAPTION_KEYS.map((key, i) => {
    const corps = `c${i + 1}`;
    return {
      corps,
      name: KEY_TO_CAPTION_NAME[key],
      score: BEST[key],
    };
  });
  await score.batch(
    [
      `CREATE TABLE competitions (slug TEXT PRIMARY KEY, season TEXT, date TEXT)`,
      `CREATE TABLE corps_scores (competition_slug TEXT, corps_key TEXT, division_name TEXT)`,
      `CREATE TABLE caption_scores (competition_slug TEXT, corps_key TEXT, caption_name TEXT, score REAL)`,
      // 2026 regular show: one corps per caption with the worked-example scores.
      `INSERT INTO competitions VALUES ('reg-1', '2026', '2026-07-01')`,
      ...captionRows.map(
        (r) => `INSERT INTO corps_scores VALUES ('reg-1', '${r.corps}', 'World Class')`
      ),
      ...captionRows.map(
        (r) => `INSERT INTO caption_scores VALUES ('reg-1', '${r.corps}', '${r.name}', ${r.score})`
      ),
      // 2024 finals (in the past) for the finals-lock test.
      `INSERT INTO competitions VALUES ('2024-world-championship-finals', '2024', '2024-08-10')`,
      `INSERT INTO corps_scores VALUES ('2024-world-championship-finals', 'c1', 'World Class')`,
      `INSERT INTO caption_scores VALUES ('2024-world-championship-finals', 'c1', 'General Effect 1', 18.0)`,
    ],
    'write'
  );

  // getContributionsDb runs an ensureColumns migration that ALTERs the better-auth
  // `user` table (added by the admin console). Stub it so the migration succeeds.
  const stub = createClient({ url: process.env.CONTRIBUTIONS_DB_URL });
  await stub.execute(
    'CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, image TEXT, role TEXT)'
  );

  const { StandingsService, StandingsServiceLive } = await import('./services/standings-service');
  recompute = (season: string) =>
    Effect.runPromise(
      Effect.flatMap(StandingsService, (s) => s.recompute(season)).pipe(
        Effect.provide(StandingsServiceLive)
      )
    );
  getStandings = (slug: string, viewerId: string | null) =>
    Effect.runPromise(
      Effect.flatMap(StandingsService, (s) => s.getStandings(slug, viewerId)).pipe(
        Effect.provide(StandingsServiceLive)
      )
    );
  const { getContributionsDb } = await import('@/lib/contributions-db');
  contribDb = await getContributionsDb();

  const now = new Date().toISOString();
  // League A (2026): one member with one pick per caption on distinct corps.
  await contribDb.batch(
    [
      {
        sql: `INSERT INTO fantasy_leagues (league_id, slug, name, owner_user_id, season, status, config_json, max_members, payment_status, created_at, updated_at)
              VALUES ('LG-A', 'lg-a', 'A', 'uA', '2026', 'active', ?, 12, 'none', ?, ?)`,
        args: [JSON.stringify(CONFIG), now, now],
      },
      {
        sql: `INSERT INTO fantasy_members (league_id, user_id, role, corps_name, status, joined_at) VALUES ('LG-A', 'uA', 'owner', 'Alpha', 'active', ?)`,
        args: [now],
      },
      ...CAPTION_KEYS.map((caption, i) => ({
        sql: `INSERT INTO fantasy_picks (pick_id, league_id, user_id, corps_key, caption, round, pick_no, caption_slot_index, weight, auto_picked, created_at)
              VALUES (?, 'LG-A', 'uA', ?, ?, ?, ?, 1, 1.0, 0, ?)`,
        args: [`pk-${i}`, `c${i + 1}`, caption, i + 1, i, now],
      })),
      // League F (2024): one member, one pick — to exercise the finals lock.
      {
        sql: `INSERT INTO fantasy_leagues (league_id, slug, name, owner_user_id, season, status, config_json, max_members, payment_status, created_at, updated_at)
              VALUES ('LG-F', 'lg-f', 'F', 'uF', '2024', 'active', ?, 12, 'none', ?, ?)`,
        args: [JSON.stringify(CONFIG), now, now],
      },
      {
        sql: `INSERT INTO fantasy_members (league_id, user_id, role, corps_name, status, joined_at) VALUES ('LG-F', 'uF', 'owner', 'Foxtrot', 'active', ?)`,
        args: [now],
      },
      {
        sql: `INSERT INTO fantasy_picks (pick_id, league_id, user_id, corps_key, caption, round, pick_no, caption_slot_index, weight, auto_picked, created_at)
              VALUES ('pk-f', 'LG-F', 'uF', 'c1', 'GE1', 1, 0, 1, 1.0, 0, ?)`,
        args: [now],
      },
    ],
    'write'
  );
});

const standingFor = async (leagueId: string, userId: string) =>
  (
    await contribDb.execute({
      sql: 'SELECT total_score, ge_score, visual_score, music_score, is_final FROM fantasy_standings WHERE league_id = ? AND user_id = ?',
      args: [leagueId, userId],
    })
  ).rows[0];

describe('recomputeFantasyStandingsForSeason', () => {
  it('reproduces the Appendix-D hand-computed recap (total 95.40)', async () => {
    await recompute('2026');
    const row = await standingFor('LG-A', 'uA');
    expect(Number(row.ge_score)).toBeCloseTo(38.6, 3);
    expect(Number(row.visual_score)).toBeCloseTo(28.15, 3);
    expect(Number(row.music_score)).toBeCloseTo(28.65, 3);
    expect(Number(row.total_score)).toBeCloseTo(95.4, 3);
    expect(Number(row.is_final)).toBe(0); // no 2026 finals seeded
  });

  it('is idempotent — re-running yields identical totals', async () => {
    const before = await standingFor('LG-A', 'uA');
    await recompute('2026');
    const after = await standingFor('LG-A', 'uA');
    expect(Number(after.total_score)).toBeCloseTo(Number(before.total_score), 9);
    expect(Number(after.ge_score)).toBeCloseTo(Number(before.ge_score), 9);
  });

  it('locks is_final and completes the league once the finals recap is present', async () => {
    const summary = await recompute('2024');
    expect(summary.finalized).toBe(1);
    const row = await standingFor('LG-F', 'uF');
    expect(Number(row.is_final)).toBe(1);
    const league = (
      await contribDb.execute({
        sql: "SELECT status FROM fantasy_leagues WHERE league_id = 'LG-F'",
      })
    ).rows[0];
    expect(league.status).toBe('complete');
  });

  it('excludes removed members from getStandings even with a stale standing row', async () => {
    const now = new Date().toISOString();
    // A member who was removed but still carries a standings row must not surface.
    await contribDb.batch(
      [
        {
          sql: `INSERT INTO fantasy_members (league_id, user_id, role, corps_name, status, joined_at)
                VALUES ('LG-A', 'uRemoved', 'member', 'Gone', 'removed', ?)`,
          args: [now],
        },
        {
          sql: `INSERT INTO fantasy_standings
                  (league_id, user_id, through_competition_slug, total_score, ge_score, visual_score,
                   music_score, breakdown_json, rank, computed_at, is_final)
                VALUES ('LG-A', 'uRemoved', NULL, 50, 20, 15, 15, '{}', 2, ?, 0)`,
          args: [now],
        },
      ],
      'write'
    );
    const { rows } = await getStandings('lg-a', null);
    expect(rows.map((r) => r.userId)).toContain('uA');
    expect(rows.map((r) => r.userId)).not.toContain('uRemoved');
  });
});
