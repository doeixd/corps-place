/**
 * Integration test for the P0 Effect path (migration plan P0 acceptance): prove
 * `LeagueService.get` reads `contributions.db` through the `ContributionsSql`
 * `SqlClient` layer and returns the same payload shape the legacy `getLeague`
 * server-fn produced — members joined to `user`, the draft summary, and the
 * viewer flags.
 *
 * Mirrors the harness in `../standings.integration.test.ts`: a temp libsql file
 * pointed at by CONTRIBUTIONS_DB_URL, with the better-auth `user` table stubbed
 * so `getContributionsDb`'s ensureColumns migration succeeds. The fantasy_*
 * tables are created by that same bootstrap.
 */
import { describe, it, expect, beforeAll } from 'vite-plus/test';
import { Effect } from 'effect';
import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLeagueConfig } from '../config';

let LeagueService: typeof import('./league-service').LeagueService;
let LeagueServiceLive: typeof import('./league-service').LeagueServiceLive;
let StandingsService: typeof import('./standings-service').StandingsService;
let StandingsServiceLive: typeof import('./standings-service').StandingsServiceLive;
let db: Client;

const CONFIG = resolveLeagueConfig({});
const NOW = '2026-06-01T00:00:00.000Z';

const runGet = (slug: string, viewerUserId: string | null) =>
  Effect.runPromise(
    Effect.flatMap(LeagueService, (svc) => svc.get({ slug, viewerUserId })).pipe(
      Effect.provide(LeagueServiceLive)
    )
  );

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fantasy-league-it-'));
  process.env.CONTRIBUTIONS_DB_URL = `file:${path.join(dir, 'contrib.db')}`;
  process.env.DCI_RELATIONAL_DB_URL = `file:${path.join(dir, 'score.db')}`;

  // ensureColumns ALTERs the better-auth `user` table — stub it so bootstrap runs.
  const stub = createClient({ url: process.env.CONTRIBUTIONS_DB_URL });
  await stub.execute(
    'CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, image TEXT, role TEXT)'
  );

  // Importing the service after env is set wires ContributionsSql at the temp DB.
  ({ LeagueService, LeagueServiceLive } = await import('./league-service'));
  ({ StandingsService, StandingsServiceLive } = await import('./standings-service'));
  const { getContributionsDb } = await import('@/lib/contributions-db');
  db = await getContributionsDb();

  await db.batch(
    [
      `INSERT INTO "user" (id, name, email, image) VALUES ('u-owner', 'Owner Sam', 'sam@x.test', 'http://img/o.png')`,
      `INSERT INTO "user" (id, name, email, image) VALUES ('u-mem', 'Member Mo', 'mo@x.test', NULL)`,
      `INSERT INTO fantasy_leagues
         (league_id, slug, name, owner_user_id, season, status, config_json, max_members, payment_status, created_at, updated_at)
       VALUES ('lg-1', 'summer-snake', 'Summer Snake', 'u-owner', '2026', 'quiz',
               '${JSON.stringify(CONFIG)}', 12, 'none', '${NOW}', '${NOW}')`,
      // Owner: quiz taken (quiz_score set), with corps identity.
      `INSERT INTO fantasy_members
         (league_id, user_id, role, corps_name, show_title, corps_color, quiz_score, draft_position, status, joined_at)
       VALUES ('lg-1', 'u-owner', 'owner', 'Blue Devils', 'Metamorphosis', '#1d4ed8', 0.8, 1, 'active', '${NOW}')`,
      // Member: no quiz yet, no corps identity.
      `INSERT INTO fantasy_members
         (league_id, user_id, role, status, joined_at)
       VALUES ('lg-1', 'u-mem', 'member', 'active', '2026-06-02T00:00:00.000Z')`,
      // A removed member must NOT appear.
      `INSERT INTO fantasy_members
         (league_id, user_id, role, status, joined_at)
       VALUES ('lg-1', 'u-gone', 'member', 'removed', '${NOW}')`,
      `INSERT INTO fantasy_drafts
         (draft_id, league_id, status, scheduled_at, draft_type, total_rounds, current_pick_no)
       VALUES ('dr-1', 'lg-1', 'scheduled', '2026-07-01T00:00:00.000Z', 'snake', 8, 0)`,
      `INSERT INTO fantasy_standings
         (league_id, user_id, total_score, ge_score, visual_score, music_score, breakdown_json, rank, computed_at, is_final)
       VALUES ('lg-1', 'u-owner', 95.4, 38.6, 28.3, 28.5,
               '${JSON.stringify({ perCaption: { GE1: 19.4 }, contributions: { GE1: [{ corpsKey: 'bd', value: 19.4, weight: 1 }] } })}',
               1, '${NOW}', 0)`,
    ],
    'write'
  );
});

describe('LeagueService.get (Effect path)', () => {
  it('returns the league, active members (joined to user), and draft summary', async () => {
    const res = await runGet('summer-snake', 'u-owner');

    expect(res.league.leagueId).toBe('lg-1');
    expect(res.league.slug).toBe('summer-snake');
    expect(res.league.name).toBe('Summer Snake');
    expect(res.league.season).toBe('2026');
    expect(res.league.status).toBe('quiz');
    expect(res.league.maxMembers).toBe(12);
    expect(res.league.paymentStatus).toBe('none');
    expect(res.league.config).toEqual(CONFIG);

    // Removed member excluded; ordered by joined_at (owner first).
    expect(res.members).toHaveLength(2);
    const [owner, member] = res.members;
    expect(owner.user_id).toBe('u-owner');
    expect(owner.user_name).toBe('Owner Sam');
    expect(owner.user_image).toBe('http://img/o.png');
    expect(owner.corps_name).toBe('Blue Devils');
    expect(owner.show_title).toBe('Metamorphosis');
    expect(owner.draft_position).toBe(1);
    expect(owner.quiz_taken).toBe(true);
    expect(member.user_id).toBe('u-mem');
    expect(member.user_image).toBeNull();
    expect(member.corps_name).toBeNull();
    expect(member.draft_position).toBeNull();
    expect(member.quiz_taken).toBe(false);

    expect(res.draft).toEqual({
      status: 'scheduled',
      scheduled_at: '2026-07-01T00:00:00.000Z',
      draft_type: 'snake',
      total_rounds: 8,
      current_pick_no: 0,
    });
  });

  it('computes viewer flags from the signed-in user', async () => {
    const asOwner = await runGet('summer-snake', 'u-owner');
    expect(asOwner.viewer).toEqual({ userId: 'u-owner', isMember: true, isOwner: true });

    const asMember = await runGet('summer-snake', 'u-mem');
    expect(asMember.viewer).toEqual({ userId: 'u-mem', isMember: true, isOwner: false });

    const asStranger = await runGet('summer-snake', 'u-other');
    expect(asStranger.viewer).toEqual({ userId: 'u-other', isMember: false, isOwner: false });

    const signedOut = await runGet('summer-snake', null);
    expect(signedOut.viewer).toEqual({ userId: null, isMember: false, isOwner: false });
  });

  it('fails with NotFound for an unknown slug', async () => {
    await expect(runGet('does-not-exist', null)).rejects.toThrow();
  });

  it('listMyLeagues returns the active memberships for a user', async () => {
    const res = await Effect.runPromise(
      Effect.flatMap(LeagueService, (svc) => svc.listMyLeagues('u-mem')).pipe(
        Effect.provide(LeagueServiceLive)
      )
    );
    expect(res.leagues).toHaveLength(1);
    expect(res.leagues[0]).toEqual({
      league_id: 'lg-1',
      slug: 'summer-snake',
      name: 'Summer Snake',
      season: '2026',
      status: 'quiz',
      role: 'member',
    });

    // A user with no active membership sees none.
    const none = await Effect.runPromise(
      Effect.flatMap(LeagueService, (svc) => svc.listMyLeagues('u-gone')).pipe(
        Effect.provide(LeagueServiceLive)
      )
    );
    expect(none.leagues).toHaveLength(0);
  });
});

describe('StandingsService.getStandings (Effect path)', () => {
  const run = (slug: string) =>
    Effect.runPromise(
      Effect.flatMap(StandingsService, (svc) => svc.getStandings(slug)).pipe(
        Effect.provide(StandingsServiceLive)
      )
    );

  it('returns the league header and standing rows joined to member + user', async () => {
    const res = await run('summer-snake');
    expect(res.league).toEqual({
      name: 'Summer Snake',
      slug: 'summer-snake',
      status: 'quiz',
      season: '2026',
    });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.userId).toBe('u-owner');
    expect(row.rank).toBe(1);
    expect(row.total).toBe(95.4);
    expect(row.ge).toBe(38.6);
    expect(row.isFinal).toBe(false);
    expect(row.corpsName).toBe('Blue Devils');
    expect(row.userName).toBe('Owner Sam');
    expect(row.perCaption).toEqual({ GE1: 19.4 });
    expect(row.contributions.GE1).toEqual([{ corpsKey: 'bd', value: 19.4, weight: 1 }]);
  });

  it('fails with NotFound for an unknown slug', async () => {
    await expect(run('nope')).rejects.toThrow();
  });
});
