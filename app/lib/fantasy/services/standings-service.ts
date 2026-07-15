/**
 * StandingsService (migration plan §3.3) — the read side of standings on the
 * Effect path. P1 implements `getStandings(slug)`, reproducing the legacy
 * `getStandings` server-fn payload. The recompute side (which calls the pure
 * `buildStandings` + writes `fantasy_standings`) lands in P4.
 *
 * SERVER-ONLY. Mirrors the `Context.Service` shape of `league-service.ts`.
 */
import { Context, Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import { getSeasonBestLookup, getSeasonFinals } from '@/lib/fantasy/score-db';
import {
  buildStandings,
  buildBreakdown,
  seasonBestFrom,
  type MemberPicks,
} from '@/lib/fantasy/standings';
import { type Pick } from '@/lib/fantasy/scoring';
import { type CaptionKey } from '@/lib/fantasy/captions';
import type { LeagueConfig } from '@/lib/fantasy/config';
import { NotFound } from './errors';
import { ContributionsSql, ContributionsSqlLive, requireDurableStorage } from './sql';

const strOrNull = (v: unknown): string | null => (v == null ? null : (v as string));

type CaptionTotals = Record<string, number>;

export type RecomputeSummary = { leagues: number; members: number; finalized: number };

interface LeagueRow {
  league_id: string;
  name: string;
  slug: string;
  status: string;
  season: string;
  config_json: string;
}

interface StandingRow {
  user_id: string;
  total_score: number;
  ge_score: number;
  visual_score: number;
  music_score: number;
  breakdown_json: string;
  rank: unknown;
  is_final: unknown;
  computed_at: unknown;
  corps_name: unknown;
  show_title: unknown;
  corps_color: unknown;
  corps_logo_media_id: unknown;
  user_name: unknown;
}

const makeStandingsService = Effect.gen(function* () {
  const sql = yield* ContributionsSql;

  const getStandings = Effect.fn('StandingsService.getStandings')(function* (
    slug: string,
    viewerId: string | null
  ) {
    const leagues = yield* sql<LeagueRow>`
      SELECT league_id, name, slug, status, season, config_json FROM fantasy_leagues WHERE slug = ${slug}
    `.pipe(Effect.orDie);
    const league = leagues[0];
    if (!league) return yield* Effect.fail(new NotFound({ message: 'league' }));

    // Drives the league nav tabs on the standings page (quiz/draft are member-only;
    // the quiz tab also hides when the league disabled it).
    const quizEnabled = (JSON.parse(league.config_json) as LeagueConfig).quiz.enabled;
    const membership = viewerId
      ? yield* sql<{ one: number }>`
          SELECT 1 AS one FROM fantasy_members
          WHERE league_id = ${league.league_id} AND user_id = ${viewerId}
        `.pipe(Effect.orDie)
      : [];
    const viewerIsMember = membership.length > 0;

    const standingRows = yield* sql<StandingRow>`
      SELECT s.user_id, s.total_score, s.ge_score, s.visual_score, s.music_score,
             s.breakdown_json, s.rank, s.is_final, s.computed_at,
             m.corps_name, m.show_title, m.corps_color, m.corps_logo_media_id,
             u.name AS user_name
      FROM fantasy_standings s
      JOIN fantasy_members m ON m.league_id = s.league_id AND m.user_id = s.user_id
      LEFT JOIN user u ON u.id = s.user_id
      WHERE s.league_id = ${league.league_id} AND m.status = 'active'
      ORDER BY s.rank
    `.pipe(Effect.orDie);

    const rows = standingRows.map((r) => {
      const breakdown = JSON.parse(r.breakdown_json) as {
        perCaption?: CaptionTotals;
        contributions?: Record<string, Array<{ corpsKey: string; value: number; weight: number }>>;
      };
      return {
        userId: r.user_id,
        rank: r.rank == null ? null : Number(r.rank),
        total: Number(r.total_score),
        ge: Number(r.ge_score),
        visual: Number(r.visual_score),
        music: Number(r.music_score),
        perCaption: (breakdown.perCaption ?? {}) as CaptionTotals,
        contributions: breakdown.contributions ?? {},
        isFinal: Boolean(r.is_final),
        computedAt: strOrNull(r.computed_at),
        corpsName: strOrNull(r.corps_name),
        showTitle: strOrNull(r.show_title),
        corpsColor: strOrNull(r.corps_color),
        corpsLogoMediaId: strOrNull(r.corps_logo_media_id),
        userName: strOrNull(r.user_name),
      };
    });

    return {
      league: {
        name: league.name,
        slug: league.slug,
        status: league.status,
        season: league.season,
        quizEnabled,
        viewerIsMember,
      },
      rows,
    };
  });

  /**
   * Recompute standings for every active/complete league in `season`, lock
   * `is_final` once the finals recap has landed (§5.5), and enqueue change
   * notifications. Idempotent — standings are a pure function of (picks,
   * season-best, weights). Ports the legacy `recomputeFantasyStandingsForSeason`.
   */
  const recompute = Effect.fn('StandingsService.recompute')(function* (season: string) {
    yield* requireDurableStorage; // I-7: never write standings to ephemeral storage
    const bestLookup = yield* Effect.promise(() => getSeasonBestLookup(season));
    const finals = yield* Effect.promise(() => getSeasonFinals(season));
    const best = seasonBestFrom(bestLookup);
    const now = new Date().toISOString();
    const isFinal = Boolean(finals && finals.recapPresent && now >= finals.date);
    const through = finals?.recapPresent ? finals.slug : null;

    // Season-progress history point (see fantasy_standings_history): key the
    // going-forward snapshot by the recompute's Eastern-time date so the several
    // recomputes that fire for one show collapse to one point. Recompute only runs
    // when new scores land (auto-ingest posts it guarded by "new scores this run"),
    // so points fall on score-landing days, not idle days. NOTE the x-axis is the
    // INGEST (ET) date, which the backfill approximates with the competition's
    // calendar date; a recap that posts after ET-midnight lands its point one day
    // after the show — same value, slightly shifted x. Only written once at least
    // one show has scored — no flat run of preseason zeroes.
    const asOfDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
      new Date(now)
    );
    const hasScores = bestLookup.size > 0;

    // Test leagues ARE included so their standings compute like any other league
    // (so testers see a populated standings tab); we only suppress their member
    // notifications below.
    const leagues = yield* sql<{ league_id: string; config_json: string; is_test: number }>`
      SELECT league_id, config_json, is_test FROM fantasy_leagues
      WHERE season = ${season} AND status IN ('active', 'complete')
    `.pipe(Effect.orDie);

    let memberTotal = 0;
    let finalized = 0;

    for (const league of leagues) {
      const leagueId = league.league_id;
      const isTest = Boolean(league.is_test);
      const config = JSON.parse(league.config_json) as LeagueConfig;

      const pickRows = yield* sql<{
        user_id: string;
        corps_key: string;
        caption: string;
        caption_slot_index: number;
        weight: number;
      }>`
        SELECT p.user_id, p.corps_key, p.caption, p.caption_slot_index, p.weight
        FROM fantasy_picks p
        JOIN fantasy_members m ON m.league_id = p.league_id AND m.user_id = p.user_id
        WHERE p.league_id = ${leagueId} AND m.status = 'active'
      `.pipe(Effect.orDie);

      const priorRows = yield* sql<{ user_id: string; total_score: number; is_final: number }>`
        SELECT user_id, total_score, is_final FROM fantasy_standings WHERE league_id = ${leagueId}
      `.pipe(Effect.orDie);
      const prior = new Map(
        priorRows.map((r) => [
          r.user_id,
          { total: Number(r.total_score), final: Boolean(r.is_final) },
        ])
      );

      const byUser = new Map<string, Pick[]>();
      for (const r of pickRows) {
        const list = byUser.get(r.user_id) ?? [];
        list.push({
          corpsKey: r.corps_key,
          caption: r.caption as CaptionKey,
          captionSlotIndex: Number(r.caption_slot_index),
          weight: Number(r.weight),
        });
        byUser.set(r.user_id, list);
      }
      if (byUser.size === 0) continue;

      const members: MemberPicks[] = [...byUser.entries()].map(([userId, picks]) => ({
        userId,
        picks,
      }));
      const rows = buildStandings(members, best, config.weights, config.scoringMode);

      // Purge standings rows for users who are no longer active members (removed /
      // left) so a stale row can't linger — getStandings filters them at read, but
      // they shouldn't persist in the table either, and they must not be re-ranked.
      yield* sql`
        DELETE FROM fantasy_standings
        WHERE league_id = ${leagueId}
          AND user_id NOT IN (
            SELECT user_id FROM fantasy_members WHERE league_id = ${leagueId} AND status = 'active'
          )
      `.pipe(Effect.orDie);

      yield* sql
        .withTransaction(
          Effect.forEach(
            rows,
            (row) => {
              const breakdown = buildBreakdown(byUser.get(row.userId) ?? [], best);
              const payload = JSON.stringify({
                perCaption: row.perCaption,
                contributions: breakdown,
              });
              return sql`
                INSERT INTO fantasy_standings
                  (league_id, user_id, through_competition_slug, total_score, ge_score, visual_score,
                   music_score, breakdown_json, rank, computed_at, is_final)
                VALUES (${leagueId}, ${row.userId}, ${through}, ${row.total}, ${row.ge}, ${row.visual},
                        ${row.music}, ${payload}, ${row.rank}, ${now}, ${isFinal ? 1 : 0})
                ON CONFLICT(league_id, user_id) DO UPDATE SET
                  through_competition_slug = excluded.through_competition_slug,
                  total_score = excluded.total_score, ge_score = excluded.ge_score,
                  visual_score = excluded.visual_score, music_score = excluded.music_score,
                  breakdown_json = excluded.breakdown_json, rank = excluded.rank,
                  computed_at = excluded.computed_at, is_final = excluded.is_final
              `;
            },
            { discard: true }
          )
        )
        .pipe(Effect.orDie);

      // Append/refresh today's season-progress history point for each member.
      if (hasScores) {
        yield* sql
          .withTransaction(
            Effect.forEach(
              rows,
              (row) => sql`
                INSERT INTO fantasy_standings_history
                  (league_id, user_id, as_of_date, through_competition_slug, total_score,
                   ge_score, visual_score, music_score, rank, computed_at)
                VALUES (${leagueId}, ${row.userId}, ${asOfDate}, ${through}, ${row.total},
                        ${row.ge}, ${row.visual}, ${row.music}, ${row.rank}, ${now})
                ON CONFLICT(league_id, user_id, as_of_date) DO UPDATE SET
                  through_competition_slug = excluded.through_competition_slug,
                  total_score = excluded.total_score, ge_score = excluded.ge_score,
                  visual_score = excluded.visual_score, music_score = excluded.music_score,
                  rank = excluded.rank, computed_at = excluded.computed_at
              `,
              { discard: true }
            )
          )
          .pipe(Effect.orDie);
      }

      // Notify only members whose total moved, or when the season just finalized.
      const changed = rows
        .filter((r) => {
          const p = prior.get(r.userId);
          if (!p) return true;
          if (Math.abs(p.total - r.total) > 1e-9) return true;
          return isFinal && !p.final;
        })
        .map((r) => r.userId);
      if (changed.length > 0 && !isTest) {
        const kind = isFinal ? 'season_complete' : 'standings';
        yield* sql
          .withTransaction(
            Effect.forEach(
              changed,
              (userId) => sql`
                INSERT INTO fantasy_notifications
                  (notif_id, user_id, league_id, kind, payload_json, created_at)
                VALUES (${randomUUID()}, ${userId}, ${leagueId}, ${kind}, '{}', ${now})
              `,
              { discard: true }
            )
          )
          .pipe(Effect.orDie);
      }

      if (isFinal) {
        yield* sql`
          UPDATE fantasy_leagues SET status = 'complete', updated_at = ${now} WHERE league_id = ${leagueId}
        `.pipe(Effect.orDie);
        finalized++;
      }
      memberTotal += rows.length;
    }

    return { leagues: leagues.length, members: memberTotal, finalized } as RecomputeSummary;
  });

  /**
   * Season-progress time-series for the standings chart: one line per active
   * member, each a list of {date, rank, score} points from fantasy_standings_history
   * (populated by recompute going forward + the one-off backfill). Sorted best→worst
   * by the member's LATEST rank so the chart's top-N cap keeps the leaders.
   */
  const getStandingsHistory = Effect.fn('StandingsService.getStandingsHistory')(function* (
    slug: string
  ) {
    const leagues = yield* sql<{ league_id: string }>`
      SELECT league_id FROM fantasy_leagues WHERE slug = ${slug}
    `.pipe(Effect.orDie);
    const league = leagues[0];
    if (!league) return yield* Effect.fail(new NotFound({ message: 'league' }));

    const rows = yield* sql<{
      user_id: string;
      as_of_date: string;
      rank: number | null;
      total_score: number;
      corps_name: string | null;
      corps_color: string | null;
      user_name: string | null;
    }>`
      SELECT h.user_id, h.as_of_date, h.rank, h.total_score,
             m.corps_name, m.corps_color, u.name AS user_name
      FROM fantasy_standings_history h
      JOIN fantasy_members m ON m.league_id = h.league_id AND m.user_id = h.user_id
      LEFT JOIN user u ON u.id = h.user_id
      WHERE h.league_id = ${league.league_id} AND m.status = 'active'
      ORDER BY h.as_of_date
    `.pipe(Effect.orDie);

    const dateSet = new Set<string>();
    const byUser = new Map<
      string,
      {
        userId: string;
        name: string;
        color: string | null;
        points: Array<{ date: string; rank: number; score: number }>;
      }
    >();
    for (const r of rows) {
      dateSet.add(r.as_of_date);
      let series = byUser.get(r.user_id);
      if (!series) {
        series = {
          userId: r.user_id,
          name: strOrNull(r.corps_name) ?? strOrNull(r.user_name) ?? 'Player',
          color: strOrNull(r.corps_color),
          points: [],
        };
        byUser.set(r.user_id, series);
      }
      series.points.push({
        date: r.as_of_date,
        rank: r.rank == null ? 0 : Number(r.rank),
        score: Number(r.total_score),
      });
    }

    // Latest-rank sort so the chart's top-N cap keeps the current leaders. A
    // missing/0 rank (shouldn't happen — both write paths assign i+1) sorts LAST,
    // never promoted to leader by a falsy value.
    const latestRank = (s: { points: Array<{ rank: number }> }) => {
      const r = s.points[s.points.length - 1]?.rank;
      return r && r > 0 ? r : Infinity;
    };
    const series = [...byUser.values()].sort((a, b) => latestRank(a) - latestRank(b));

    return { dates: [...dateSet].sort(), series };
  });

  return { getStandings, recompute, getStandingsHistory };
});

export class StandingsService extends Context.Service<
  StandingsService,
  Effect.Success<typeof makeStandingsService>
>()('StandingsService') {}

export const StandingsServiceLive = Layer.effect(StandingsService, makeStandingsService).pipe(
  Layer.provide(ContributionsSqlLive)
);
