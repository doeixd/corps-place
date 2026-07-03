// Prediction Ballot server-fns (PREDICTION_BALLOT_PLAN §5). Locking is the ONLY
// write and it is append-only: a locked ballot is immutable by design — a new
// take is a new ballot. Reads are public (shared links).
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
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
  /** Optional per-caption orders (only the captions the user actually arranged). */
  captions: Partial<Record<string, BallotEntry[]>>;
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
        captions: v.optional(
          v.record(
            v.picklist(BALLOT_CAPTIONS),
            v.pipe(v.array(EntrySchema), v.minLength(2), v.maxLength(40))
          )
        ),
      }),
      d
    )
  )
  .handler(async ({ data }) => {
    const actor = await getActor(getRequest());
    if (!actor) throw new Error('UNAUTHENTICATED');
    if (!durableStorageStatus().ready) throw new Error('STORAGE_UNAVAILABLE');
    if (!rateLimit(`ballot-lock:${actor.userId}`, 10, 60_000))
      throw new Error('CONFLICT:rate-limited');

    // A permutation, not a multiset — duplicate corps would corrupt the ranking.
    const slugs = data.overall.map((e) => e.slug);
    if (new Set(slugs).size !== slugs.length) throw new Error('VALIDATION:duplicate-corps');
    for (const entries of Object.values(data.captions ?? {})) {
      const s = entries.map((e) => e.slug);
      if (new Set(s).size !== s.length) throw new Error('VALIDATION:duplicate-corps');
    }

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
          ...Object.fromEntries(
            Object.entries(data.captions ?? {}).map(([cap, entries]) => [
              cap,
              entries.map((e) => ({ slug: e.slug, name: cleanText(e.name, 80) })),
            ])
          ),
        }),
        now,
        now,
      ],
    });
    return { ballotId };
  });

const rowToRecord = (r: Record<string, unknown>): BallotRecord => {
  const orders = JSON.parse(r.orders_json as string) as Record<string, BallotEntry[]>;
  const { overall, ...captions } = orders;
  return {
    ballotId: r.ballot_id as string,
    season: r.season as string,
    preset: r.preset as string,
    title: (r.title as string | null) ?? null,
    displayName: (r.display_name as string | null) ?? null,
    overall: overall ?? [],
    captions,
    lockedAt: r.locked_at as string,
  };
};

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

export const BALLOT_CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
export type BallotCaption = (typeof BALLOT_CAPTIONS)[number];

const CAPTION_NAME_TO_KEY: Record<string, BallotCaption> = {
  'General Effect 1': 'GE1',
  'General Effect 2': 'GE2',
  'Visual Proficiency': 'VP',
  'Visual - Analysis': 'VA',
  'Color Guard': 'CG',
  'Music - Brass': 'MB',
  'Music - Analysis': 'MA',
  'Music - Percussion': 'MP',
};

export interface PredictionPoolCorps {
  corpsSlug: string; // corps page slug when known, else the corps key
  corpsName: string;
  division: string;
  corpsLogo: string | null;
  corpsLogoDark: number | null;
  corpsLogoDarkUrl: string | null;
  /** Model-predicted championship-prelims total (the default ordering), if predicted. */
  predictedTotal: number | null;
  /** Model-predicted caption scores (per-caption card default order). */
  predictedCaptions: Partial<Record<BallotCaption, number>> | null;
  /** PRIOR-season championship placement — the ▲▼ baseline for the Overall card. */
  priorRank: number | null;
  /** PRIOR-season championship caption ranks — the ▲▼ baselines per caption card. */
  priorCaptionRanks: Partial<Record<BallotCaption, number>> | null;
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

    // Model prediction (championship prelims — the widest predicted field):
    // totals + per-caption scores + the model's own prior_season_rank, keyed by
    // corps_key with a name fallback.
    type Pred = {
      total: number;
      captions: Partial<Record<BallotCaption, number>>;
      priorRank: number | null;
    };
    const predByKey = new Map<string, Pred>();
    const predByName = new Map<string, Pred>();
    try {
      if (readModelEnabled()) {
        const summary = await readLatestPredictionSummary(
          getReadModelClient(),
          `${season}-dci-world-championship-prelims`
        );
        const rows = summary ? findRecapRows(summary.summary) : null;
        for (const r of rows ?? []) {
          if (typeof r.corps !== 'string' || typeof r.total !== 'number') continue;
          const captions: Partial<Record<BallotCaption, number>> = {};
          for (const cap of BALLOT_CAPTIONS)
            if (typeof r[cap] === 'number') captions[cap] = Number(r[cap]);
          const pred: Pred = {
            total: Number(r.total),
            captions,
            priorRank: typeof r.prior_season_rank === 'number' ? Number(r.prior_season_rank) : null,
          };
          if (typeof r.corps_key === 'string') predByKey.set(String(r.corps_key), pred);
          predByName.set(String(r.corps).toLowerCase(), pred);
        }
      }
    } catch {
      /* prediction unavailable — pool still returns, ordered alphabetically */
    }

    // PRIOR-season championship caption scores → per-caption prior ranks (the
    // ▲▼ baselines the user compares against). Keyed by corps_key.
    const priorCaptionRanksByKey = new Map<string, Partial<Record<BallotCaption, number>>>();
    const priorTotalRankByKey = new Map<string, number>();
    try {
      if (readModelEnabled()) {
        const priorSeason = String(Number(season) - 1);
        const r = await getReadModelClient().execute({
          sql: `SELECT corps_key, caption_name, score FROM rm_fantasy_prior_finals WHERE season = ?`,
          args: [priorSeason],
        });
        const scores = new Map<string, Partial<Record<BallotCaption, number>>>();
        for (const row of r.rows as unknown as {
          corps_key: string;
          caption_name: string;
          score: number;
        }[]) {
          const cap = CAPTION_NAME_TO_KEY[row.caption_name];
          if (!cap) continue;
          const m = scores.get(row.corps_key) ?? {};
          m[cap] = Number(row.score);
          scores.set(row.corps_key, m);
        }
        // Rank per caption (score desc), and overall by the DCI total formula.
        for (const cap of BALLOT_CAPTIONS) {
          const ranked = [...scores.entries()]
            .filter(([, m]) => typeof m[cap] === 'number')
            .sort((a, b) => (b[1][cap] ?? 0) - (a[1][cap] ?? 0));
          ranked.forEach(([key], i) => {
            const m = priorCaptionRanksByKey.get(key) ?? {};
            m[cap] = i + 1;
            priorCaptionRanksByKey.set(key, m);
          });
        }
        const totalOf = (m: Partial<Record<BallotCaption, number>>) =>
          (m.GE1 ?? 0) + (m.GE2 ?? 0) + ((m.VP ?? 0) + (m.VA ?? 0) + (m.CG ?? 0)) / 2 +
          ((m.MB ?? 0) + (m.MA ?? 0) + (m.MP ?? 0)) / 2;
        [...scores.entries()]
          .sort((a, b) => totalOf(b[1]) - totalOf(a[1]))
          .forEach(([key], i) => priorTotalRankByKey.set(key, i + 1));
      }
    } catch {
      /* prior-season data unavailable — arrows simply don't render */
    }

    return pool
      .map((c) => {
        const pred = predByKey.get(c.corpsKey) ?? predByName.get(c.name.toLowerCase()) ?? null;
        return {
          corpsSlug: c.slug ?? c.corpsKey,
          corpsName: c.name,
          division: c.divisionName ?? 'World Class',
          corpsLogo: c.corpsLogo,
          corpsLogoDark: c.corpsLogoDark,
          corpsLogoDarkUrl: c.corpsLogoDarkUrl,
          predictedTotal: pred?.total ?? null,
          predictedCaptions: pred && Object.keys(pred.captions).length ? pred.captions : null,
          // Prefer the prior-finals table's rank (championship placement); the
          // model's prior_season_rank is the fallback for corps outside it.
          priorRank: priorTotalRankByKey.get(c.corpsKey) ?? pred?.priorRank ?? null,
          priorCaptionRanks: priorCaptionRanksByKey.get(c.corpsKey) ?? null,
        };
      })
      .sort(
        (a, b) =>
          (b.predictedTotal ?? -1) - (a.predictedTotal ?? -1) ||
          a.corpsName.localeCompare(b.corpsName)
      );
  });

/** The signed-in user's locked ballots (the "my predictions" dropdown), newest first. */
export const myBallots = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<Pick<BallotRecord, 'ballotId' | 'title' | 'preset' | 'lockedAt' | 'season'>>> => {
    const actor = await getActor(getRequest());
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
