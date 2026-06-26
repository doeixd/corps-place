import type { Client, Transaction } from '@libsql/client';
import { durableStorageStatus } from '@/lib/contributions-db';

/**
 * Contributions write/read core for the show-detail wiki (M3 data layer).
 *
 * Every write is `{row upsert + revision insert}` in ONE transaction (invariant
 * I-6); revisions are append-only (I-5). Pages are created lazily on first write
 * (I-10). Writes fail closed when the durable volume is missing (I-7). Optimistic
 * concurrency via an `expectedUpdatedAt` precondition (plan §12) turns a
 * lost-update race into a surfaced 409 instead of a silent clobber.
 *
 * This layer is auth-agnostic: callers pass `authorId` + `actorRole`. The M2
 * server-fn layer resolves those from the better-auth session and runs the
 * `authorize()` check before calling in.
 */

export type OverrideState = 'edited' | 'added' | 'hidden';
export type ShowPageLock = 'none' | 'trusted' | 'mod';

export interface WriteContext {
  authorId: string;
  actorRole: string;
  /** ISO timestamp for this write (caller-supplied so a batch shares one stamp). */
  now: string;
}

export class StaleWriteError extends Error {
  readonly _tag = 'StaleWriteError';
  constructor(public readonly current: string | null) {
    super('The row changed since you loaded it — refresh and retry.');
  }
}

export class DurableStorageUnavailableError extends Error {
  readonly _tag = 'DurableStorageUnavailableError';
  constructor(reason: string) {
    super(`Contributions storage is not writable: ${reason}`);
  }
}

const assertWritable = () => {
  const status = durableStorageStatus();
  if (!status.ready) throw new DurableStorageUnavailableError(status.reason);
};

const newId = () => crypto.randomUUID();

// ── Reads ────────────────────────────────────────────────────────────────────

export interface PageRow {
  page_id: string;
  corps_key: string;
  season: string;
  show_id: string | null;
  status: string;
  lock_level: string;
  created_at: string;
  updated_at: string;
}
export interface OverrideRow {
  override_id: string;
  pinned_key: string;
  natural_key: string;
  state: OverrideState;
  content_json: string | null;
  source_hash: string | null;
  scrape_diverged: number;
  position: number | null;
  updated_at: string;
  updated_by: string;
}
export interface BlockRow {
  block_id: string;
  kind: string;
  pinned_key: string | null;
  position: number;
  content_json: string;
  updated_at: string;
  updated_by: string;
}

export interface PageContributions {
  page: PageRow | null;
  overrides: OverrideRow[];
  blocks: BlockRow[];
}

/** All contributed rows for a show, by its stable (corps_key, season) key. */
export const readShowPageContributions = async (
  db: Client,
  corpsKey: string,
  season: string
): Promise<PageContributions> => {
  const pageRes = await db.execute({
    sql: 'SELECT * FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
    args: [corpsKey, season],
  });
  const page = (pageRes.rows[0] as unknown as PageRow) ?? null;
  if (!page) return { page: null, overrides: [], blocks: [] };

  const [ov, bl] = await Promise.all([
    db.execute({
      sql: 'SELECT * FROM show_block_overrides WHERE page_id = ? ORDER BY pinned_key, position, natural_key',
      args: [page.page_id],
    }),
    db.execute({
      sql: 'SELECT * FROM show_blocks WHERE page_id = ? ORDER BY position',
      args: [page.page_id],
    }),
  ]);
  return {
    page,
    overrides: ov.rows as unknown as OverrideRow[],
    blocks: bl.rows as unknown as BlockRow[],
  };
};

export const listRevisions = async (db: Client, pageId: string, limit = 200) => {
  const r = await db.execute({
    sql: 'SELECT * FROM show_revisions WHERE page_id = ? ORDER BY created_at DESC, revision_id DESC LIMIT ?',
    args: [pageId, limit],
  });
  return r.rows;
};

export interface StewardSummary {
  stewardCount: number;
  mySteward: boolean;
  stewards: {
    userId: string;
    name: string | null;
    createdAt: string;
  }[];
}

/** Stewards (page watchers) for a page + whether the viewer is one (M9 governance). */
export const readStewardSummary = async (
  db: Client,
  pageId: string | null,
  userId: string | null
): Promise<StewardSummary> => {
  if (!pageId) return { stewardCount: 0, mySteward: false, stewards: [] };
  const [count, mine, stewards] = await Promise.all([
    db.execute({
      sql: 'SELECT COUNT(*) AS n FROM show_stewards WHERE page_id = ?',
      args: [pageId],
    }),
    userId
      ? db.execute({
          sql: 'SELECT 1 FROM show_stewards WHERE page_id = ? AND user_id = ? LIMIT 1',
          args: [pageId, userId],
        })
      : Promise.resolve({ rows: [] }),
    db.execute({
      sql: `SELECT s.user_id, u.name, s.created_at
            FROM show_stewards s LEFT JOIN "user" u ON u.id = s.user_id
            WHERE s.page_id = ?
            ORDER BY s.created_at ASC, s.user_id ASC
            LIMIT 8`,
      args: [pageId],
    }),
  ]);
  return {
    stewardCount: Number(count.rows[0]?.n ?? 0),
    mySteward: mine.rows.length > 0,
    stewards: (stewards.rows as unknown as Record<string, unknown>[]).map((row) => ({
      userId: String(row.user_id),
      name: (row.name as string) ?? null,
      createdAt: String(row.created_at),
    })),
  };
};

// ── Writes ─────────────────────────────────────────────────────────────────

/** Resolve the page_id for (corps_key, season), creating the page lazily (I-10). */
export const ensureShowPage = async (
  db: Client,
  corpsKey: string,
  season: string,
  ctx: WriteContext
): Promise<string> => {
  assertWritable();
  const existing = await db.execute({
    sql: 'SELECT page_id FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
    args: [corpsKey, season],
  });
  if (existing.rows[0]) return String(existing.rows[0].page_id);

  const pageId = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO show_pages (page_id, corps_key, season, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [pageId, corpsKey, season, ctx.now, ctx.now],
    });
    await insertRevision(tx, {
      pageId,
      targetKind: 'page',
      targetId: pageId,
      op: 'create',
      before: null,
      after: null,
      summary: `Created page for ${corpsKey} ${season}`,
      ctx,
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
  return pageId;
};

export interface OverrideInput {
  pageId: string;
  pinnedKey: string;
  naturalKey: string;
  state: OverrideState;
  contentJson: string | null;
  sourceHash: string | null;
  position?: number | null;
}

/** Upsert a per-row override of a seedable scraped row + record the revision (I-6). */
export const writeOverride = async (
  db: Client,
  input: OverrideInput,
  ctx: WriteContext,
  expectedUpdatedAt?: string | null
): Promise<string> => {
  assertWritable();
  const tx = await db.transaction('write');
  try {
    const prev = await tx.execute({
      sql: 'SELECT override_id, content_json, updated_at FROM show_block_overrides WHERE page_id = ? AND pinned_key = ? AND natural_key = ? LIMIT 1',
      args: [input.pageId, input.pinnedKey, input.naturalKey],
    });
    const existing = prev.rows[0] as unknown as
      | { override_id: string; content_json: string | null; updated_at: string }
      | undefined;
    assertFresh(existing?.updated_at ?? null, expectedUpdatedAt);

    const overrideId = existing?.override_id ?? newId();
    await tx.execute({
      sql: `INSERT INTO show_block_overrides
              (override_id, page_id, pinned_key, natural_key, state, content_json,
               source_hash, position, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(page_id, pinned_key, natural_key) DO UPDATE SET
              state = excluded.state, content_json = excluded.content_json,
              source_hash = excluded.source_hash, position = excluded.position,
              scrape_diverged = 0, updated_at = excluded.updated_at,
              updated_by = excluded.updated_by`,
      args: [
        overrideId,
        input.pageId,
        input.pinnedKey,
        input.naturalKey,
        input.state,
        input.contentJson,
        input.sourceHash,
        input.position ?? null,
        ctx.now,
        ctx.authorId,
      ],
    });
    await touchPage(tx, input.pageId, ctx.now);
    await insertRevision(tx, {
      pageId: input.pageId,
      targetKind: 'override',
      targetId: overrideId,
      op: existing
        ? input.state === 'hidden'
          ? 'hide'
          : 'edit'
        : input.state === 'added'
          ? 'add'
          : 'edit',
      before: existing?.content_json ?? null,
      after: input.contentJson,
      summary: `${input.pinnedKey}: ${input.naturalKey}`,
      ctx,
    });
    await tx.commit();
    return overrideId;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
};

export interface DivergenceSummary {
  checked: number;
  changed: number;
  diverged: number;
  cleared: number;
}

/**
 * Re-check every override on a page against the CURRENT scraped row hashes and flip
 * each override's `scrape_diverged` flag accordingly (set when the scraped source has
 * changed since the override was made; cleared when it matches again). Returns a small
 * summary. Called by the reconcile server-fn (moderator-triggered, plan §scrape-sync).
 */
export const reconcileOverrideDivergence = async (
  db: Client,
  pageId: string,
  currentHashes: Record<string, Record<string, string>>
): Promise<DivergenceSummary> => {
  assertWritable();
  const rows = (
    await db.execute({
      sql: `SELECT override_id, pinned_key, natural_key, source_hash, scrape_diverged
            FROM show_block_overrides WHERE page_id = ?`,
      args: [pageId],
    })
  ).rows as unknown as Pick<
    OverrideRow,
    'override_id' | 'pinned_key' | 'natural_key' | 'source_hash' | 'scrape_diverged'
  >[];

  const tx = await db.transaction('write');
  const summary: DivergenceSummary = { checked: rows.length, changed: 0, diverged: 0, cleared: 0 };
  try {
    for (const row of rows) {
      const currentHash = currentHashes[row.pinned_key]?.[row.natural_key] ?? null;
      const nextDiverged = row.source_hash != null && currentHash !== row.source_hash ? 1 : 0;
      if (nextDiverged) summary.diverged += 1;
      if (Number(row.scrape_diverged) === nextDiverged) continue;
      await tx.execute({
        sql: 'UPDATE show_block_overrides SET scrape_diverged = ? WHERE override_id = ?',
        args: [nextDiverged, row.override_id],
      });
      summary.changed += 1;
      if (!nextDiverged) summary.cleared += 1;
    }
    await tx.commit();
    return summary;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
};

export interface BlockInput {
  pageId: string;
  kind: 'pinned' | 'freeform';
  pinnedKey: string | null;
  position: number;
  contentJson: string;
}

/** Upsert an authored block (uniform/props/links/symbolism/free-form) + revision. */
export const writeBlock = async (
  db: Client,
  input: BlockInput,
  ctx: WriteContext,
  expectedUpdatedAt?: string | null
): Promise<string> => {
  assertWritable();
  const tx = await db.transaction('write');
  try {
    // Pinned blocks are unique per (page, pinned_key); free-form blocks are addressed
    // by position. Look up the current row to decide insert-vs-update + concurrency.
    const prev = input.pinnedKey
      ? await tx.execute({
          sql: 'SELECT block_id, content_json, updated_at FROM show_blocks WHERE page_id = ? AND pinned_key = ? LIMIT 1',
          args: [input.pageId, input.pinnedKey],
        })
      : { rows: [] as unknown[] };
    const existing = prev.rows[0] as
      | { block_id: string; content_json: string; updated_at: string }
      | undefined;
    assertFresh(existing?.updated_at ?? null, expectedUpdatedAt);

    const blockId = existing?.block_id ?? newId();
    if (existing) {
      await tx.execute({
        sql: `UPDATE show_blocks SET content_json = ?, position = ?, updated_at = ?, updated_by = ?
              WHERE block_id = ?`,
        args: [input.contentJson, input.position, ctx.now, ctx.authorId, blockId],
      });
    } else {
      await tx.execute({
        sql: `INSERT INTO show_blocks
                (block_id, page_id, kind, pinned_key, position, content_json, updated_at, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          blockId,
          input.pageId,
          input.kind,
          input.pinnedKey,
          input.position,
          input.contentJson,
          ctx.now,
          ctx.authorId,
        ],
      });
    }
    await touchPage(tx, input.pageId, ctx.now);
    await insertRevision(tx, {
      pageId: input.pageId,
      targetKind: 'block',
      targetId: blockId,
      op: existing ? 'edit' : 'create',
      before: existing?.content_json ?? null,
      after: input.contentJson,
      summary: input.pinnedKey ?? `freeform#${input.position}`,
      ctx,
    });
    await tx.commit();
    return blockId;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
};

/** Add/remove the actor as a steward (page watcher) + record the revision (M9). */
export const setPageSteward = async (
  db: Client,
  pageId: string,
  steward: boolean,
  ctx: WriteContext
): Promise<void> => {
  assertWritable();
  const tx = await db.transaction('write');
  try {
    if (steward) {
      await tx.execute({
        sql: 'INSERT OR IGNORE INTO show_stewards (page_id, user_id, created_at) VALUES (?, ?, ?)',
        args: [pageId, ctx.authorId, ctx.now],
      });
    } else {
      await tx.execute({
        sql: 'DELETE FROM show_stewards WHERE page_id = ? AND user_id = ?',
        args: [pageId, ctx.authorId],
      });
    }
    await touchPage(tx, pageId, ctx.now);
    await insertRevision(tx, {
      pageId,
      targetKind: 'page',
      targetId: pageId,
      op: steward ? 'steward' : 'unsteward',
      before: null,
      after: JSON.stringify({ steward }),
      summary: steward ? 'Started stewarding this page' : 'Stopped stewarding this page',
      ctx,
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
};

/** Set a page's edit lock level (moderator) + record the revision (M9, §6.4). */
export const setPageLockLevel = async (
  db: Client,
  pageId: string,
  lockLevel: ShowPageLock,
  ctx: WriteContext
): Promise<void> => {
  assertWritable();
  const tx = await db.transaction('write');
  try {
    const prev = (
      await tx.execute({
        sql: 'SELECT lock_level FROM show_pages WHERE page_id = ? LIMIT 1',
        args: [pageId],
      })
    ).rows[0] as unknown as { lock_level: string } | undefined;
    const before = prev?.lock_level ?? 'none';
    await tx.execute({
      sql: 'UPDATE show_pages SET lock_level = ?, updated_at = ? WHERE page_id = ?',
      args: [lockLevel, ctx.now, pageId],
    });
    await insertRevision(tx, {
      pageId,
      targetKind: 'page',
      targetId: pageId,
      op: 'lock',
      before: JSON.stringify({ lockLevel: before }),
      after: JSON.stringify({ lockLevel }),
      summary: `Set page lock to ${lockLevel}`,
      ctx,
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
};

// ── internals ────────────────────────────────────────────────────────────────

const assertFresh = (current: string | null, expected?: string | null) => {
  // Only enforce when the caller supplied a precondition (an edit of a row it
  // loaded). A create (no expected) or a first-write (no current) is always fine.
  if (expected === undefined) return;
  if (current !== expected) throw new StaleWriteError(current);
};

const touchPage = (tx: Transaction, pageId: string, now: string) =>
  tx.execute({
    sql: 'UPDATE show_pages SET updated_at = ? WHERE page_id = ?',
    args: [now, pageId],
  });

const insertRevision = (
  tx: Transaction,
  r: {
    pageId: string;
    targetKind: 'override' | 'block' | 'page';
    targetId: string | null;
    op: string;
    before: string | null;
    after: string | null;
    summary: string | null;
    ctx: WriteContext;
  }
) =>
  tx.execute({
    sql: `INSERT INTO show_revisions
            (revision_id, page_id, target_kind, target_id, author_id, created_at, op,
             actor_role, before_json, after_json, summary)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId(),
      r.pageId,
      r.targetKind,
      r.targetId,
      r.ctx.authorId,
      r.ctx.now,
      r.op,
      r.ctx.actorRole,
      r.before,
      r.after,
      r.summary,
    ],
  });
