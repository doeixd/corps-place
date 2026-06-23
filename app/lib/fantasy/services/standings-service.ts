/**
 * StandingsService (migration plan §3.3) — the read side of standings on the
 * Effect path. P1 implements `getStandings(slug)`, reproducing the legacy
 * `getStandings` server-fn payload. The recompute side (which calls the pure
 * `buildStandings` + writes `fantasy_standings`) lands in P4.
 *
 * SERVER-ONLY. Mirrors the `Context.Service` shape of `league-service.ts`.
 */
import { Context, Effect, Layer } from 'effect';
import { NotFound } from './errors';
import { ContributionsSql, ContributionsSqlLive } from './sql';

const strOrNull = (v: unknown): string | null => (v == null ? null : (v as string));

type CaptionTotals = Record<string, number>;

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

  return { getStandings };
});

export class StandingsService extends Context.Service<
  StandingsService,
  Effect.Success<typeof makeStandingsService>
>()('StandingsService') {}

export const StandingsServiceLive = Layer.effect(StandingsService, makeStandingsService).pipe(
  Layer.provide(ContributionsSqlLive)
);
