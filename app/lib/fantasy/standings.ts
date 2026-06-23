/**
 * Fantasy standings recompute (Fantasy DCI plan §5.4/§5.5, Appendix C.2 + D).
 * SERVER-ONLY. Reads the score DB, writes `fantasy_standings` in contributions.db.
 *
 * Idempotent: standings are a pure function of (picks, season-best lookup, current
 * weights), so a re-run — or a corrected/late recap — simply recomputes correct
 * numbers. The pure `buildStandings` is unit-tested; the orchestrator does I/O.
 */
import { getContributionsDb } from '@/lib/contributions-db';
import { getSeasonBestLookup, getSeasonFinals, type RankingLookup } from './score-db';
import {
  computeRosterScore,
  type Pick,
  type SeasonBest,
  type Weights,
  type ScoringMode,
} from './scoring';
import { CAPTION_KEYS, type CaptionKey } from './captions';
import type { LeagueConfig } from './config';

/** Adapt a `${corpsKey}|${caption}` lookup into the SeasonBest function shape. */
export const seasonBestFrom =
  (lookup: RankingLookup): SeasonBest =>
  (corpsKey, caption) =>
    lookup.get(`${corpsKey}|${caption}`) ?? 0;

export type MemberPicks = { userId: string; picks: Pick[] };
export type StandingRow = {
  userId: string;
  total: number;
  ge: number;
  visual: number;
  music: number;
  perCaption: Record<CaptionKey, number>;
  rank: number;
};

/**
 * Score every member and rank them (pure). Tie-break by GE subtotal, then Music,
 * then user_id (§10) — draft position would be the next tiebreak but isn't needed
 * here since user_id is already stable.
 */
export function buildStandings(
  members: readonly MemberPicks[],
  best: SeasonBest,
  weights: Weights,
  mode: ScoringMode
): StandingRow[] {
  const scored = members.map((m) => ({
    userId: m.userId,
    ...computeRosterScore(m.picks, best, weights, mode),
  }));
  scored.sort(
    (a, b) =>
      b.total - a.total || b.ge - a.ge || b.music - a.music || a.userId.localeCompare(b.userId)
  );
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

/** Per-caption list of which picks contributed (drives the expandable UI). */
export function buildBreakdown(
  picks: readonly Pick[],
  best: SeasonBest
): Record<CaptionKey, Array<{ corpsKey: string; value: number; weight: number }>> {
  const out = Object.fromEntries(
    CAPTION_KEYS.map((k) => [k, [] as Array<{ corpsKey: string; value: number; weight: number }>])
  ) as Record<CaptionKey, Array<{ corpsKey: string; value: number; weight: number }>>;
  for (const p of picks) {
    out[p.caption].push({
      corpsKey: p.corpsKey,
      value: best(p.corpsKey, p.caption),
      weight: p.weight,
    });
  }
  return out;
}

export type RecomputeSummary = { leagues: number; members: number; finalized: number };

/**
 * Recompute standings for every active/complete league in `season` and lock
 * `is_final` once the finals recap has landed (§5.5). Call this after a scrape
 * ingests the season's recaps.
 */
export async function recomputeFantasyStandingsForSeason(
  season: string
): Promise<RecomputeSummary> {
  const [bestLookup, finals] = await Promise.all([
    getSeasonBestLookup(season),
    getSeasonFinals(season),
  ]);
  const best = seasonBestFrom(bestLookup);
  const now = new Date().toISOString();
  const isFinal = Boolean(finals && finals.recapPresent && now >= finals.date);
  const through = finals?.recapPresent ? finals.slug : null;

  const db = await getContributionsDb();
  const leagues = (
    await db.execute({
      sql: "SELECT league_id, config_json FROM fantasy_leagues WHERE season = ? AND status IN ('active', 'complete')",
      args: [season],
    })
  ).rows;

  let memberTotal = 0;
  let finalized = 0;

  for (const league of leagues) {
    const leagueId = league.league_id as string;
    const config = JSON.parse(league.config_json as string) as LeagueConfig;

    const pickRows = (
      await db.execute({
        sql: 'SELECT user_id, corps_key, caption, caption_slot_index, weight FROM fantasy_picks WHERE league_id = ?',
        args: [leagueId],
      })
    ).rows;

    // Prior standings, to notify only when something actually changed (avoids
    // emailing "standings updated" on every idempotent recompute cycle).
    const prior = new Map<string, { total: number; final: boolean }>(
      (
        await db.execute({
          sql: 'SELECT user_id, total_score, is_final FROM fantasy_standings WHERE league_id = ?',
          args: [leagueId],
        })
      ).rows.map((r) => [
        r.user_id as string,
        { total: Number(r.total_score), final: Boolean(r.is_final) },
      ])
    );

    const byUser = new Map<string, Pick[]>();
    for (const r of pickRows) {
      const userId = r.user_id as string;
      const list = byUser.get(userId) ?? [];
      list.push({
        corpsKey: r.corps_key as string,
        caption: r.caption as CaptionKey,
        captionSlotIndex: Number(r.caption_slot_index),
        weight: Number(r.weight),
      });
      byUser.set(userId, list);
    }
    if (byUser.size === 0) continue;

    const members: MemberPicks[] = [...byUser.entries()].map(([userId, picks]) => ({
      userId,
      picks,
    }));
    const rows = buildStandings(members, best, config.weights, config.scoringMode);

    const statements = rows.map((row) => {
      const breakdown = buildBreakdown(byUser.get(row.userId) ?? [], best);
      return {
        sql: `INSERT INTO fantasy_standings
                (league_id, user_id, through_competition_slug, total_score, ge_score, visual_score, music_score,
                 breakdown_json, rank, computed_at, is_final)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(league_id, user_id) DO UPDATE SET
                through_competition_slug = excluded.through_competition_slug,
                total_score = excluded.total_score, ge_score = excluded.ge_score,
                visual_score = excluded.visual_score, music_score = excluded.music_score,
                breakdown_json = excluded.breakdown_json, rank = excluded.rank,
                computed_at = excluded.computed_at, is_final = excluded.is_final`,
        args: [
          leagueId,
          row.userId,
          through,
          row.total,
          row.ge,
          row.visual,
          row.music,
          JSON.stringify({ perCaption: row.perCaption, contributions: breakdown }),
          row.rank,
          now,
          isFinal ? 1 : 0,
        ],
      };
    });
    await db.batch(statements, 'write');

    // Notify only members whose total moved, or when the season just finalized.
    const changed = rows
      .filter((r) => {
        const p = prior.get(r.userId);
        if (!p) return true;
        if (Math.abs(p.total - r.total) > 1e-9) return true;
        return isFinal && !p.final;
      })
      .map((r) => r.userId);
    if (changed.length > 0) await enqueueStandingsNotifications(leagueId, changed, isFinal, now);

    if (isFinal) {
      await db.execute({
        sql: "UPDATE fantasy_leagues SET status = 'complete', updated_at = ? WHERE league_id = ?",
        args: [now, leagueId],
      });
      finalized++;
    }
    memberTotal += rows.length;
  }

  return { leagues: leagues.length, members: memberTotal, finalized };
}

async function enqueueStandingsNotifications(
  leagueId: string,
  userIds: readonly string[],
  isFinal: boolean,
  now: string
): Promise<void> {
  const db = await getContributionsDb();
  const kind = isFinal ? 'season_complete' : 'standings';
  await db.batch(
    userIds.map((userId) => ({
      sql: `INSERT INTO fantasy_notifications (notif_id, user_id, league_id, kind, payload_json, created_at)
            VALUES (?, ?, ?, ?, '{}', ?)`,
      args: [crypto.randomUUID(), userId, leagueId, kind, now],
    })),
    'write'
  );
}
