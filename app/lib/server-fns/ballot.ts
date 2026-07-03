// Prediction Ballot server-fns (PREDICTION_BALLOT_PLAN §5). Locking is the ONLY
// write and it is append-only: a locked ballot is immutable by design — a new
// take is a new ballot. Reads are public (shared links).
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb, durableStorageStatus } from '@/lib/contributions-db';
import { getActor } from '@/lib/authz';
import { rateLimit } from '@/lib/rate-limit';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import { readLatestPredictionSummary } from '@sdk/src/readModel/readers.js';
import { getDraftPool } from '@/lib/fantasy/score-db';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRESETS = ['finals', 'semis', 'world', 'open', 'all', 'custom'] as const;

// Strip control characters and clamp — these strings land on shared pages and
// the OG image, so keep them plain text.
const cleanText = (s: string, max: number): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

const EntrySchema = v.object({
  slug: v.pipe(v.string(), v.regex(SLUG_RE)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
});

export type BallotEntry = v.InferOutput<typeof EntrySchema>;

export interface BallotRecord {
  ballotId: string;
  season: string;
  preset: string;
  title: string | null;
  displayName: string | null;
  overall: BallotEntry[];
  lockedAt: string;
}

/** Lock a ballot: append-only, immutable snapshot. Returns the share id. */
export const lockBallot = createServerFn({ method: 'POST' })
  .validator((d: unknown) =>
    v.parse(
      v.object({
        season: v.pipe(v.string(), v.regex(/^\d{4}$/)),
        preset: v.picklist(PRESETS),
        title: v.optional(v.pipe(v.string(), v.maxLength(80))),
        displayName: v.optional(v.pipe(v.string(), v.maxLength(60))),
        overall: v.pipe(v.array(EntrySchema), v.minLength(2), v.maxLength(40)),
      }),
      d
    )
  )
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    if (!durableStorageStatus().ready) throw new Error('STORAGE_UNAVAILABLE');
    if (!rateLimit(`ballot-lock:${actor.userId}`, 10, 60_000))
      throw new Error('CONFLICT:rate-limited');

    // A permutation, not a multiset — duplicate corps would corrupt the ranking.
    const slugs = data.overall.map((e) => e.slug);
    if (new Set(slugs).size !== slugs.length) throw new Error('VALIDATION:duplicate-corps');

    const db = await getContributionsDb();
    const now = new Date().toISOString();
    const ballotId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await db.execute({
      sql: `INSERT INTO prediction_ballots
              (ballot_id, user_id, season, preset, title, display_name, orders_json, locked_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ballotId,
        actor.userId,
        data.season,
        data.preset,
        data.title ? cleanText(data.title, 80) || null : null,
        data.displayName ? cleanText(data.displayName, 60) || null : null,
        JSON.stringify({
          overall: data.overall.map((e) => ({ slug: e.slug, name: cleanText(e.name, 80) })),
        }),
        now,
        now,
      ],
    });
    return { ballotId };
  });

const rowToRecord = (r: Record<string, unknown>): BallotRecord => ({
  ballotId: r.ballot_id as string,
  season: r.season as string,
  preset: r.preset as string,
  title: (r.title as string | null) ?? null,
  displayName: (r.display_name as string | null) ?? null,
  overall: (JSON.parse(r.orders_json as string) as { overall: BallotEntry[] }).overall ?? [],
  lockedAt: r.locked_at as string,
});

/** Public read for the share page + OG image. */
export const getBallot = createServerFn({ method: 'GET' })
  .validator((id: string) => {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('VALIDATION:bad-id');
    return id;
  })
  .handler(async ({ data }): Promise<BallotRecord | null> => {
    const db = await getContributionsDb();
    const row = (
      await db.execute({
        sql: 'SELECT * FROM prediction_ballots WHERE ballot_id = ?',
        args: [data],
      })
    ).rows[0];
    return row ? rowToRecord(row as unknown as Record<string, unknown>) : null;
  });

// ── Prediction pool ───────────────────────────────────────────────────────────

export interface PredictionPoolCorps {
  corpsSlug: string; // corps page slug when known, else the corps key
  corpsName: string;
  division: string;
  corpsLogo: string | null;
  corpsLogoDark: number | null;
  corpsLogoDarkUrl: string | null;
  /** Model-predicted championship-prelims total (the default ordering), if predicted. */
  predictedTotal: number | null;
}

/** Recursively find the recap rows inside the prediction summary payload. */
const findRecapRows = (o: unknown, depth = 0): Array<Record<string, unknown>> | null => {
  if (depth > 5 || o == null) return null;
  if (Array.isArray(o))
    return o.length > 0 && typeof o[0] === 'object' && o[0] !== null && 'total' in (o[0] as object)
      ? (o as Array<Record<string, unknown>>)
      : null;
  if (typeof o === 'object') {
    for (const v2 of Object.values(o as Record<string, unknown>)) {
      const r = findRecapRows(v2, depth + 1);
      if (r) return r;
    }
  }
  return null;
};

/**
 * EVERY corps performing this season (the fantasy draft pool — event lineups,
 * not scores, so pre-debut corps are included), ordered by the model's PREDICTED
 * finals ranking (championship-prelims totals — the widest predicted field).
 * Corps without a prediction sort after, alphabetically.
 */
export const getPredictionPool = createServerFn({ method: 'GET' })
  .validator((season: string) => {
    if (!/^\d{4}$/.test(season)) throw new Error('VALIDATION:bad-season');
    return season;
  })
  .handler(async ({ data: season }): Promise<PredictionPoolCorps[]> => {
    const pool = await getDraftPool(season).catch(() => []);
    let predictedByName = new Map<string, number>();
    try {
      if (readModelEnabled()) {
        const summary = await readLatestPredictionSummary(
          getReadModelClient(),
          `${season}-dci-world-championship-prelims`
        );
        const rows = summary ? findRecapRows(summary.summary) : null;
        if (rows)
          predictedByName = new Map(
            rows
              .filter((r) => typeof r.corps === 'string' && typeof r.total === 'number')
              .map((r) => [String(r.corps).toLowerCase(), Number(r.total)])
          );
      }
    } catch {
      /* prediction unavailable — pool still returns, ordered alphabetically */
    }
    return pool
      .map((c) => ({
        corpsSlug: c.slug ?? c.corpsKey,
        corpsName: c.name,
        division: c.divisionName ?? 'World Class',
        corpsLogo: c.corpsLogo,
        corpsLogoDark: c.corpsLogoDark,
        corpsLogoDarkUrl: c.corpsLogoDarkUrl,
        predictedTotal: predictedByName.get(c.name.toLowerCase()) ?? null,
      }))
      .sort(
        (a, b) =>
          (b.predictedTotal ?? -1) - (a.predictedTotal ?? -1) ||
          a.corpsName.localeCompare(b.corpsName)
      );
  });

/** The signed-in user's locked ballots (the "my predictions" dropdown), newest first. */
export const myBallots = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<Pick<BallotRecord, 'ballotId' | 'title' | 'preset' | 'lockedAt' | 'season'>>> => {
    const actor = await getActor(getWebRequest());
    if (!actor) return [];
    const db = await getContributionsDb();
    const res = await db.execute({
      sql: `SELECT ballot_id, title, preset, locked_at, season FROM prediction_ballots
            WHERE user_id = ? ORDER BY locked_at DESC LIMIT 50`,
      args: [actor.userId],
    });
    return res.rows.map((r) => ({
      ballotId: r.ballot_id as string,
      title: (r.title as string | null) ?? null,
      preset: r.preset as string,
      lockedAt: r.locked_at as string,
      season: r.season as string,
    }));
  }
);
