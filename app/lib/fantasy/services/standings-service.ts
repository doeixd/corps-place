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

  const getStandings = Effect.fn('StandingsService.getStandings')(function* (slug: string) {
    const leagues = yield* sql<LeagueRow>`
      SELECT league_id, name, slug, status, season FROM fantasy_leagues WHERE slug = ${slug}
    `.pipe(Effect.orDie);
    const league = leagues[0];
    if (!league) return yield* Effect.fail(new NotFound({ message: 'league' }));

    const standingRows = yield* sql<StandingRow>`
      SELECT s.user_id, s.total_score, s.ge_score, s.visual_score, s.music_score,
             s.breakdown_json, s.rank, s.is_final, s.computed_at,
             m.corps_name, m.show_title, m.corps_color, m.corps_logo_media_id,
             u.name AS user_name
      FROM fantasy_standings s
      JOIN fantasy_members m ON m.league_id = s.league_id AND m.user_id = s.user_id
      LEFT JOIN user u ON u.id = s.user_id
      WHERE s.league_id = ${league.league_id}
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

    const leagues = yield* sql<{ league_id: string; config_json: string }>`
      SELECT league_id, config_json FROM fantasy_leagues
      WHERE season = ${season} AND status IN ('active', 'complete')
    `.pipe(Effect.orDie);

    let memberTotal = 0;
    let finalized = 0;

    for (const league of leagues) {
      const leagueId = league.league_id;
      const config = JSON.parse(league.config_json) as LeagueConfig;

      const pickRows = yield* sql<{
        user_id: string;
        corps_key: string;
        caption: string;
        caption_slot_index: number;
        weight: number;
      }>`
        SELECT user_id, corps_key, caption, caption_slot_index, weight
        FROM fantasy_picks WHERE league_id = ${leagueId}
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

      // Notify only members whose total moved, or when the season just finalized.
      const changed = rows
        .filter((r) => {
          const p = prior.get(r.userId);
          if (!p) return true;
          if (Math.abs(p.total - r.total) > 1e-9) return true;
          return isFinal && !p.final;
        })
        .map((r) => r.userId);
      if (changed.length > 0) {
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

  return { getStandings, recompute };
});

export class StandingsService extends Context.Service<
  StandingsService,
  Effect.Success<typeof makeStandingsService>
>()('StandingsService') {}

export const StandingsServiceLive = Layer.effect(StandingsService, makeStandingsService).pipe(
  Layer.provide(ContributionsSqlLive)
);
