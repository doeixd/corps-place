/**
 * Content-moderation server functions (ADMIN_PAGE_PLAN §6). The cross-page
 * "firehose" the per-page HistoryPanel never gave us, plus page lock/list. All
 * reads/writes are on `contributions.db`, so these are direct server-fns (no VM
 * worker). Every fn re-checks capability FIRST — the loader gate is only UX.
 *
 * Revert reuses the existing `revertRevision` (contrib.ts). The `hideRevision`/
 * `hideMedia` actions need the additive `hidden` columns (§6.3, guarded migration
 * at M4) and land with that migration — not here.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import { requireCapability } from '@/lib/authz';

export interface AdminRevisionRow {
  revisionId: string;
  pageId: string;
  corpsKey: string | null;
  season: string | null;
  targetKind: string;
  op: string;
  authorId: string;
  authorName: string | null;
  actorRole: string;
  summary: string | null;
  createdAt: string;
}

const ListRevisionsInput = v.object({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)), 100),
});

/** Recent revisions across ALL pages (the moderation feed). Cap: viewAdmin. */
export const listRecentRevisions = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(ListRevisionsInput, d))
  .handler(async ({ data }): Promise<AdminRevisionRow[]> => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const db = await getContributionsDb();
    const rows = (
      await db.execute({
        sql: `SELECT r.revision_id, r.page_id, p.corps_key, p.season,
                     r.target_kind, r.op, r.author_id, u.name AS author_name,
                     r.actor_role, r.summary, r.created_at
              FROM show_revisions r
              LEFT JOIN show_pages p ON p.page_id = r.page_id
              LEFT JOIN "user" u ON u.id = r.author_id
              ORDER BY r.created_at DESC, r.revision_id DESC
              LIMIT ?`,
        args: [data.limit],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      revisionId: String(r.revision_id),
      pageId: String(r.page_id),
      corpsKey: (r.corps_key as string) ?? null,
      season: (r.season as string) ?? null,
      targetKind: String(r.target_kind),
      op: String(r.op),
      authorId: String(r.author_id),
      authorName: (r.author_name as string) ?? null,
      actorRole: String(r.actor_role),
      summary: (r.summary as string) ?? null,
      createdAt: String(r.created_at),
    }));
  });

export interface AdminPageRow {
  pageId: string;
  corpsKey: string;
  season: string;
  status: string;
  lockLevel: string;
  updatedAt: string;
}

const ListPagesInput = v.object({
  lockedOnly: v.optional(v.boolean(), false),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)), 200),
});

/** Admin list of show pages (none existed before). Cap: viewAdmin. */
export const listShowPages = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(ListPagesInput, d))
  .handler(async ({ data }): Promise<AdminPageRow[]> => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const db = await getContributionsDb();
    const where = data.lockedOnly ? "WHERE lock_level != 'none'" : '';
    const rows = (
      await db.execute({
        sql: `SELECT page_id, corps_key, season, status, lock_level, updated_at
              FROM show_pages ${where}
              ORDER BY updated_at DESC LIMIT ?`,
        args: [data.limit],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      pageId: String(r.page_id),
      corpsKey: String(r.corps_key),
      season: String(r.season),
      status: String(r.status),
      lockLevel: String(r.lock_level),
      updatedAt: String(r.updated_at),
    }));
  });

const SetLockInput = v.object({
  pageId: v.string(),
  level: v.picklist(['none', 'trusted', 'mod']),
});

/** Set/clear a page's lock level (the setter the edit fns already enforce). Cap: lock. */
export const setPageLock = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SetLockInput, d))
  .handler(async ({ data }) => {
    await requireCapability(getWebRequest(), 'lock');
    const db = await getContributionsDb();
    const now = new Date().toISOString();
    const res = await db.execute({
      sql: 'UPDATE show_pages SET lock_level = ?, updated_at = ? WHERE page_id = ?',
      args: [data.level, now, data.pageId],
    });
    if (res.rowsAffected === 0) throw new Error('NOT_FOUND');
    // TODO(§8): append an admin_audit row once that table lands (M3).
    return { ok: true as const, pageId: data.pageId, level: data.level };
  });
