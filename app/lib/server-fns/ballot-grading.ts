// Post-finals ballot grading + community consensus (M5). Read-only; grading is
// computed on demand from the read-model's championships-week caption scores —
// ballots are immutable and the actuals are fixed once ingested, so nothing is
// persisted. Gated on rm_fantasy_season_finals.recap_present so partial
// championship weeks (prelims scored, finals pending) don't grade early.
import { createServerFn } from '@tanstack/react-start/client';
import { getContributionsDb } from '@/lib/contributions-db';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import {
  buildActualStandings,
  buildConsensus,
  gradeOrdering,
  type ActualStandings,
  type ConsensusRow,
  type OrderingGrade,
  type PriorFinalsRow,
} from '@/lib/ballot-grading';
import { BALLOT_CAPTIONS, type BallotCaption, type BallotEntry } from '@/lib/server-fns/ballot';

const SEASON_RE = /^\d{4}$/;

/**
 * Championship standings for a season, or null while the season's finals recap
 * hasn't landed (pre-finals, or mid-championships-week).
 */
async function loadSeasonActuals(season: string): Promise<ActualStandings | null> {
  if (!readModelEnabled()) return null;
  const rm = getReadModelClient();

  const gate = await rm.execute({
    sql: `SELECT recap_present FROM rm_fantasy_season_finals WHERE season = ? LIMIT 1`,
    args: [season],
  });
  if (!Number(gate.rows[0]?.recap_present)) return null;

  const [captionRows, poolRows] = await Promise.all([
    rm.execute({
      sql: `SELECT corps_key, caption_name, score FROM rm_fantasy_prior_finals WHERE season = ?`,
      args: [season],
    }),
    rm.execute({
      sql: `SELECT corps_key, slug FROM rm_fantasy_draft_pool WHERE season = ?`,
      args: [season],
    }),
  ]);
  if (captionRows.rows.length === 0) return null;

  const keyToSlug = new Map<string, string>();
  for (const r of poolRows.rows as unknown as { corps_key: string; slug: string | null }[])
    if (r.slug) keyToSlug.set(r.corps_key, r.slug);

  return buildActualStandings(captionRows.rows as unknown as PriorFinalsRow[], keyToSlug);
}

export interface BallotGrade {
  available: boolean;
  season: string;
  overall: OrderingGrade | null;
  /** Grades only for captions the user actually arranged. */
  captions: Partial<Record<BallotCaption, OrderingGrade>>;
  fieldSize: number;
}

/** Grade one locked ballot against its season's championship results. Public, like getBallot. */
export const getBallotGrade = createServerFn({ method: 'GET' })
  .validator((id: string) => {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('VALIDATION:bad-id');
    return id;
  })
  .handler(async ({ data }): Promise<BallotGrade | null> => {
    const db = await getContributionsDb();
    const row = (
      await db.execute({
        sql: 'SELECT season, orders_json FROM prediction_ballots WHERE ballot_id = ?',
        args: [data],
      })
    ).rows[0];
    if (!row) return null;

    const season = row.season as string;
    const unavailable: BallotGrade = {
      available: false,
      season,
      overall: null,
      captions: {},
      fieldSize: 0,
    };
    const actuals = await loadSeasonActuals(season).catch(() => null);
    if (!actuals) return unavailable;

    const orders = JSON.parse(row.orders_json as string) as Record<string, BallotEntry[]>;
    const captions: Partial<Record<BallotCaption, OrderingGrade>> = {};
    for (const cap of BALLOT_CAPTIONS) {
      const entries = orders[cap];
      if (entries?.length)
        captions[cap] = gradeOrdering(
          entries.map((e) => e.slug),
          actuals.captions[cap]
        );
    }
    return {
      available: true,
      season,
      overall: gradeOrdering(
        (orders.overall ?? []).map((e) => e.slug),
        actuals.overall
      ),
      captions,
      fieldSize: actuals.fieldSize,
    };
  });

export interface SeasonResults {
  available: boolean;
  season: string;
  ballotCount: number;
  consensus: ConsensusRow[];
  /** Graded ballots, best first. */
  leaderboard: Array<{
    ballotId: string;
    title: string | null;
    displayName: string | null;
    preset: string;
    picks: number;
    earned: number;
    pct: number;
    exact: number;
  }>;
}

/**
 * Season-wide results: community consensus (median predicted position per corps
 * across every locked ballot) and a leaderboard of graded ballots.
 */
export const getSeasonResults = createServerFn({ method: 'GET' })
  .validator((season: string) => {
    if (!SEASON_RE.test(season)) throw new Error('VALIDATION:bad-season');
    return season;
  })
  .handler(async ({ data: season }): Promise<SeasonResults> => {
    const empty: SeasonResults = {
      available: false,
      season,
      ballotCount: 0,
      consensus: [],
      leaderboard: [],
    };
    const actuals = await loadSeasonActuals(season).catch(() => null);
    if (!actuals) return empty;

    const db = await getContributionsDb();
    const res = await db.execute({
      sql: `SELECT ballot_id, title, display_name, preset, orders_json
            FROM prediction_ballots WHERE season = ? ORDER BY locked_at ASC LIMIT 2000`,
      args: [season],
    });

    const parsed = res.rows.flatMap((r) => {
      try {
        const orders = JSON.parse(r.orders_json as string) as Record<string, BallotEntry[]>;
        return [{ row: r as unknown as Record<string, unknown>, overall: orders.overall ?? [] }];
      } catch {
        return [];
      }
    });

    const leaderboard = parsed
      .map(({ row, overall }) => {
        const g = gradeOrdering(
          overall.map((e) => e.slug),
          actuals.overall
        );
        return {
          ballotId: row.ballot_id as string,
          title: (row.title as string | null) ?? null,
          displayName: (row.display_name as string | null) ?? null,
          preset: row.preset as string,
          picks: g.picks.length,
          earned: g.earned,
          pct: g.pct,
          exact: g.exact,
        };
      })
      .sort((a, b) => b.pct - a.pct || b.picks - a.picks || b.exact - a.exact);

    return {
      available: true,
      season,
      ballotCount: parsed.length,
      consensus: buildConsensus(
        parsed.map((p) => ({ overall: p.overall })),
        actuals.overall
      ),
      leaderboard: leaderboard.slice(0, 100),
    };
  });
