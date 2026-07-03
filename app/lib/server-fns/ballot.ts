// Prediction Ballot server-fns (PREDICTION_BALLOT_PLAN §5). Locking is the ONLY
// write and it is append-only: a locked ballot is immutable by design — a new
// take is a new ballot. Reads are public (shared links).
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb, durableStorageStatus } from '@/lib/contributions-db';
import { getActor } from '@/lib/authz';
import { rateLimit } from '@/lib/rate-limit';

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
