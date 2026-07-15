/**
 * One-off backfill of `fantasy_standings_history` from the dated underlying
 * scores, so the season-progress graph has points for shows that landed BEFORE
 * the going-forward recompute write shipped.
 *
 * Runs ON THE BOX — it needs the raw `sdk/dci-relational.db` (the ~5 GB relational
 * DB), which prod/app containers don't ship (they carry only the read-model). It
 * reconstructs "member score as of date D" by running the same season-best MAX
 * with an `AND c.date <= D` bound, then the SAME `computeRosterScore` the live
 * path uses — so reconstructed points match live standings exactly. Weights are
 * deterministic (set at draft, never mutated), so this is faithful; the only
 * unfaithfulness is if a member's ROSTER changed mid-season (trades/waivers).
 *
 * Idempotent: upserts on (league_id, user_id, as_of_date). Safe to re-run. Prefer a
 * quiet window — it writes to contributions.db, which the live 3-min auto-ingest
 * recompute also writes (SQLite is single-writer; a clash just needs a re-run).
 *
 * x-axis note: points are keyed by the competition's calendar date (UTC midnight
 * stem), while the live recompute keys by its ET ingest date — so a show whose
 * recap posts after ET-midnight sits one day apart between backfilled and live
 * points. Same values, slightly shifted x near the seam.
 *
 *   cd /root/corps-place && vp exec tsx scripts/backfill-fantasy-history.ts --season 2026 [--dry-run]
 */
import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  computeRosterScore,
  type Pick,
  type ScoringMode,
  type Weights,
  type SeasonBest,
} from '../app/lib/fantasy/scoring';
import { CAPTION_NAME_TO_KEY, isCaptionKey } from '../app/lib/fantasy/captions';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const seasonIdx = argv.indexOf('--season');
const season = seasonIdx >= 0 ? argv[seasonIdx + 1]! : String(new Date().getFullYear());

const DRAFT_DIVISIONS = ['World Class', 'Open Class'];

const rawUrl =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${path.resolve(process.cwd(), 'sdk', 'dci-relational.db')}`;
const contribUrl = process.env.CONTRIBUTIONS_DB_URL ?? 'file:/data/corps-place/contributions.db';

const raw = createClient({ url: rawUrl });
const contrib = createClient({ url: contribUrl });

type Member = { userId: string; picks: Pick[] };
type League = { leagueId: string; weights: Weights; mode: ScoringMode; members: Member[] };

/** Corps' season-best per caption using only competitions on or before `date`. */
async function bestAsOf(date: string): Promise<Map<string, number>> {
  const res = await raw.execute({
    sql: `SELECT cap.corps_key, cap.caption_name, MAX(cap.score) AS best
          FROM caption_scores cap
          JOIN competitions c  ON c.slug = cap.competition_slug
          JOIN corps_scores cs ON cs.competition_slug = cap.competition_slug AND cs.corps_key = cap.corps_key
          WHERE c.season = ? AND c.date <= ?
            AND cs.division_name IN (?, ?)
            AND cap.score IS NOT NULL
          GROUP BY cap.corps_key, cap.caption_name`,
    args: [season, date, ...DRAFT_DIVISIONS],
  });
  const m = new Map<string, number>();
  for (const r of res.rows) {
    const key = CAPTION_NAME_TO_KEY[r.caption_name as string];
    if (!key) continue;
    m.set(`${r.corps_key as string}|${key}`, Number(r.best));
  }
  return m;
}

async function loadLeagues(): Promise<League[]> {
  const res = await contrib.execute({
    sql: `SELECT league_id, config_json FROM fantasy_leagues
          WHERE season = ? AND status IN ('active', 'complete')`,
    args: [season],
  });
  const leagues: League[] = [];
  for (const lr of res.rows) {
    const leagueId = lr.league_id as string;
    const config = JSON.parse(lr.config_json as string) as {
      weights: Weights;
      scoringMode: ScoringMode;
    };
    const pickRes = await contrib.execute({
      sql: `SELECT p.user_id, p.corps_key, p.caption, p.caption_slot_index, p.weight
            FROM fantasy_picks p
            JOIN fantasy_members m ON m.league_id = p.league_id AND m.user_id = p.user_id
            WHERE p.league_id = ? AND m.status = 'active'`,
      args: [leagueId],
    });
    const byUser = new Map<string, Pick[]>();
    for (const r of pickRes.rows) {
      const caption = r.caption as string;
      if (!isCaptionKey(caption)) continue;
      const list = byUser.get(r.user_id as string) ?? [];
      list.push({
        corpsKey: r.corps_key as string,
        caption,
        captionSlotIndex: Number(r.caption_slot_index),
        weight: Number(r.weight),
      });
      byUser.set(r.user_id as string, list);
    }
    if (byUser.size === 0) continue; // no picks yet — nothing to reconstruct
    leagues.push({
      leagueId,
      weights: config.weights,
      mode: config.scoringMode,
      members: [...byUser.entries()].map(([userId, picks]) => ({ userId, picks })),
    });
  }
  return leagues;
}

function rankMembers(league: League, best: SeasonBest) {
  const scored = league.members.map((m) => {
    const s = computeRosterScore(m.picks, best, league.weights, league.mode);
    return { userId: m.userId, total: s.total, ge: s.ge, visual: s.visual, music: s.music, rank: 0 };
  });
  // Tiebreakers MUST match buildStandings (standings.ts) exactly, incl. the
  // locale-aware userId compare, or a reconstructed rank could differ on an exact
  // total/ge/music tie.
  scored.sort(
    (a, b) =>
      b.total - a.total || b.ge - a.ge || b.music - a.music || a.userId.localeCompare(b.userId)
  );
  scored.forEach((s, i) => (s.rank = i + 1));
  return scored;
}

async function main() {
  const datesRes = await raw.execute({
    sql: `SELECT c.date AS date, MAX(c.slug) AS slug
          FROM competitions c
          JOIN caption_scores cap ON cap.competition_slug = c.slug
          WHERE c.season = ?
          GROUP BY c.date
          ORDER BY c.date`,
    args: [season],
  });
  // `competitions.date` is a full ISO timestamp (midnight UTC); `date` keeps it for
  // the `c.date <= ?` as-of bound, `asOf` (YYYY-MM-DD) is the history x-axis key —
  // the same format the going-forward recompute write uses, so points align.
  const dates = datesRes.rows.map((r) => ({
    date: r.date as string,
    asOf: (r.date as string).slice(0, 10),
    slug: r.slug as string,
  }));
  const leagues = await loadLeagues();

  console.log(
    `[backfill] season ${season}: ${dates.length} scored competition date(s), ` +
      `${leagues.length} league(s) with picks${dryRun ? ' — DRY RUN' : ''}`
  );
  if (dates.length === 0 || leagues.length === 0) {
    console.log('[backfill] nothing to do');
    return;
  }

  // The app creates this table on init/deploy; create it here too so the backfill
  // is self-sufficient on the box even before the schema change ships (idempotent).
  if (!dryRun) {
    await contrib.execute(`CREATE TABLE IF NOT EXISTS fantasy_standings_history (
       league_id                TEXT NOT NULL,
       user_id                  TEXT NOT NULL,
       as_of_date               TEXT NOT NULL,
       through_competition_slug TEXT,
       total_score              REAL NOT NULL DEFAULT 0,
       ge_score                 REAL NOT NULL DEFAULT 0,
       visual_score             REAL NOT NULL DEFAULT 0,
       music_score              REAL NOT NULL DEFAULT 0,
       rank                     INTEGER,
       computed_at              TEXT NOT NULL,
       PRIMARY KEY (league_id, user_id, as_of_date)
     )`);
    await contrib.execute(`CREATE INDEX IF NOT EXISTS idx_fantasy_standings_history_league_date
       ON fantasy_standings_history (league_id, as_of_date)`);
  }

  const now = new Date().toISOString();
  let written = 0;

  for (const { date, asOf, slug } of dates) {
    const bestMap = await bestAsOf(date);
    const best = (ck: string, cap: string) => bestMap.get(`${ck}|${cap}`) ?? 0;
    for (const league of leagues) {
      const scored = rankMembers(league, best);
      if (!dryRun) {
        await contrib.batch(
          scored.map((s) => ({
            sql: `INSERT INTO fantasy_standings_history
                    (league_id, user_id, as_of_date, through_competition_slug,
                     total_score, ge_score, visual_score, music_score, rank, computed_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(league_id, user_id, as_of_date) DO UPDATE SET
                    through_competition_slug = excluded.through_competition_slug,
                    total_score = excluded.total_score, ge_score = excluded.ge_score,
                    visual_score = excluded.visual_score, music_score = excluded.music_score,
                    rank = excluded.rank, computed_at = excluded.computed_at`,
            args: [league.leagueId, s.userId, asOf, slug, s.total, s.ge, s.visual, s.music, s.rank, now],
          })),
          'write'
        );
      }
      written += scored.length;
    }
  }

  // Show the final (latest-date) standings for the first league so it can be
  // eyeballed against the live fantasy_standings snapshot (they should match).
  const last = dates[dates.length - 1]!;
  const bestMap = await bestAsOf(last.date);
  const finalStandings = rankMembers(leagues[0]!, (ck, cap) => bestMap.get(`${ck}|${cap}`) ?? 0);
  console.log(`[backfill] latest date ${last.asOf} — league ${leagues[0]!.leagueId} reconstructed:`);
  for (const s of finalStandings)
    console.log(`  #${s.rank}  ${s.userId}  total ${s.total.toFixed(3)}`);

  console.log(`[backfill] ${dryRun ? 'would write' : 'wrote'} ${written} history point(s)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[backfill] failed:', e);
    process.exit(1);
  });
