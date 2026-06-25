import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import { Schema, SchemaParser } from 'effect';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import {
  ensureShowPage,
  writeBlock,
  writeOverride,
  readShowPageContributions,
  type PageContributions,
  type OverrideState,
} from '@/lib/contrib/store';
import { requireCapability, type PageLock } from '@/lib/authz';
import {
  BLOCK_SCHEMAS,
  RepertoireRowInputSchema,
  MovementRowInputSchema,
  isAuthoredPinnedKey,
} from '@/lib/contrib/schemas';
import { scrapedSeedableHashes } from '@/lib/contrib/seedable';
import { getShowDetail } from '@/lib/server-fns/hybrid';
import { normalizeHex } from '@sdk/src/corpsColors.js';

/**
 * Contribution write/read server-fns (M3). Reads are public; the write fn runs
 * through the `authorize()` chokepoint (I-12) and re-parses content with the same
 * Effect Schema the form used (never trust the client, §6.6). Lazy page create
 * (I-10); every write records a revision in one transaction via the store (I-6).
 */

// ── Read: contributions overlay for a show (public, always fresh) ─────────────
export const getShowContributions = createServerFn({ method: 'GET' })
  .validator((data: { corpsKey: string; season: string }) => data)
  .handler(async ({ data }): Promise<PageContributions> => {
    const db = await getContributionsDb();
    return readShowPageContributions(db, data.corpsKey, data.season);
  });

// ── Read: full edit history for a show (public — the wiki's transparency) ─────
export interface HistoryEntry {
  revisionId: string;
  targetKind: string;
  targetId: string | null;
  authorId: string;
  authorName: string | null;
  createdAt: string;
  op: string;
  actorRole: string;
  summary: string | null;
  beforeJson: string | null;
  afterJson: string | null;
}

export const getShowHistory = createServerFn({ method: 'GET' })
  .validator((data: { corpsKey: string; season: string }) => data)
  .handler(async ({ data }): Promise<HistoryEntry[]> => {
    const db = await getContributionsDb();
    const page = (
      await db.execute({
        sql: 'SELECT page_id FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
        args: [data.corpsKey, data.season],
      })
    ).rows[0] as unknown as { page_id: string } | undefined;
    if (!page) return [];
    // Join better-auth's `user` table for a display name (revisions store only the id).
    const rows = (
      await db.execute({
        sql: `SELECT r.revision_id, r.target_kind, r.target_id, r.author_id, u.name AS author_name,
                     r.created_at, r.op, r.actor_role, r.summary, r.before_json, r.after_json
              FROM show_revisions r LEFT JOIN "user" u ON u.id = r.author_id
              WHERE r.page_id = ? ORDER BY r.created_at DESC, r.revision_id DESC LIMIT 300`,
        args: [page.page_id],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      revisionId: String(r.revision_id),
      targetKind: String(r.target_kind),
      targetId: (r.target_id as string) ?? null,
      authorId: String(r.author_id),
      authorName: (r.author_name as string) ?? null,
      createdAt: String(r.created_at),
      op: String(r.op),
      actorRole: String(r.actor_role),
      summary: (r.summary as string) ?? null,
      beforeJson: (r.before_json as string) ?? null,
      afterJson: (r.after_json as string) ?? null,
    }));
  });

// ── Revert an authored-block revision (revert-as-forward-revision, I-5) ───────
export const revertRevision = createServerFn({ method: 'POST' })
  .validator((data: { revisionId: string }) => data)
  .handler(async ({ data }) => {
    const db = await getContributionsDb();
    const rev = (
      await db.execute({
        sql: `SELECT page_id, target_kind, target_id, before_json FROM show_revisions WHERE revision_id = ? LIMIT 1`,
        args: [data.revisionId],
      })
    ).rows[0] as unknown as
      | {
          page_id: string;
          target_kind: string;
          target_id: string | null;
          before_json: string | null;
        }
      | undefined;
    if (!rev) throw new Error('Revision not found');
    if (rev.target_kind !== 'block') throw new Error('Only block edits are revertible for now');
    if (rev.before_json == null)
      throw new Error("Can't revert a create yet (nothing to restore to)");

    const block = (
      await db.execute({
        sql: `SELECT page_id, pinned_key, position, corps_key, season
              FROM show_blocks b JOIN show_pages p ON p.page_id = b.page_id
              WHERE b.block_id = ? LIMIT 1`,
        args: [rev.target_id],
      })
    ).rows[0] as unknown as
      | {
          page_id: string;
          pinned_key: string | null;
          position: number;
          corps_key: string;
          season: string;
        }
      | undefined;
    if (!block) throw new Error('Target block no longer exists');

    const lockLevel = ((
      await db.execute({
        sql: 'SELECT lock_level FROM show_pages WHERE page_id = ? LIMIT 1',
        args: [block.page_id],
      })
    ).rows[0]?.lock_level ?? 'none') as PageLock;
    const actor = await requireCapability(getWebRequest(), 'revert', { lockLevel });

    const now = new Date().toISOString();
    const blockId = await writeBlock(
      db,
      {
        pageId: block.page_id,
        kind: 'pinned',
        pinnedKey: block.pinned_key,
        position: block.position,
        contentJson: rev.before_json,
      },
      { authorId: actor.userId, actorRole: actor.role, now }
    );
    return { ok: true as const, blockId, restoredFrom: data.revisionId };
  });

// ── Write: save an authored pinned block (uniform/props/links/symbolism) ──────
const SaveBlockInput = Schema.Struct({
  corpsKey: Schema.String,
  season: Schema.String,
  pinnedKey: Schema.String,
  content: Schema.Unknown,
  // v3 `optionalWith({ nullable: true })` expanded to its native v4 form (the
  // compat helper's overload doesn't resolve under the app tsconfig here).
  expectedUpdatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeInput = SchemaParser.decodeUnknownSync(SaveBlockInput);

export const saveShowBlock = createServerFn({ method: 'POST' })
  .validator(decodeInput)
  .handler(async ({ data }) => {
    if (!isAuthoredPinnedKey(data.pinnedKey)) throw new Error(`Unknown block: ${data.pinnedKey}`);

    // Layer 2 (§6.6): re-parse the content with the block's own Valibot schema
    // (same schema the Formisch form used — never trust the client).
    const content = v.parse(BLOCK_SCHEMAS[data.pinnedKey], data.content);

    const db = await getContributionsDb();
    // Page lock gates the edit capability (§6.4). Default 'none' for a new page.
    const lockLevel = ((
      await db.execute({
        sql: 'SELECT lock_level FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
        args: [data.corpsKey, data.season],
      })
    ).rows[0]?.lock_level ?? 'none') as PageLock;

    // The chokepoint: throws ForbiddenError if not allowed (I-12).
    const actor = await requireCapability(getWebRequest(), 'edit', { lockLevel });

    // Domain normalization the schema can't express (e.g. hex colors).
    const normalized =
      data.pinnedKey === 'uniform'
        ? {
            ...(content as { colors: { hex: string; label?: string | null }[] }),
            colors: (content as { colors: { hex: string; label?: string | null }[] }).colors.map(
              (c) => ({ ...c, hex: normalizeHex(c.hex) ?? c.hex })
            ),
          }
        : content;

    const now = new Date().toISOString();
    const ctx = { authorId: actor.userId, actorRole: actor.role, now };
    const pageId = await ensureShowPage(db, data.corpsKey, data.season, ctx);
    const blockId = await writeBlock(
      db,
      {
        pageId,
        kind: 'pinned',
        pinnedKey: data.pinnedKey,
        position: 0,
        contentJson: JSON.stringify(normalized),
      },
      ctx,
      data.expectedUpdatedAt
    );
    return { ok: true as const, blockId, updatedAt: now };
  });

// ── Write: save a seedable per-row override (repertoire / movements) ──────────
// Designers/media are handled by master's existing authored block sections, so
// the override path is restricted to the two seedable list sections here.
type SaveOverrideData = {
  corpsKey: string;
  season: string;
  pinnedKey: 'repertoire' | 'movements';
  naturalKey: string;
  state: OverrideState;
  content: unknown;
  position?: number | null;
  expectedUpdatedAt?: string | null;
};

const OVERRIDE_SCHEMAS = {
  repertoire: RepertoireRowInputSchema,
  movements: MovementRowInputSchema,
} as const;

/** Read the scraped show-detail server-side (the divergence baseline source). */
const readScrapedShowDetail = (corpsKey: string, season: string) =>
  getShowDetail({ data: { corpsKey, season } });

export const saveShowOverride = createServerFn({ method: 'POST' })
  .validator((data: SaveOverrideData) => data)
  .handler(async ({ data }) => {
    const schema = OVERRIDE_SCHEMAS[data.pinnedKey];
    if (!schema) throw new Error(`Unknown override section: ${data.pinnedKey}`);
    // Layer 2 (§6.6): re-parse with the row's own Valibot schema (never trust the
    // client). A hide carries no content.
    const content = data.state === 'hidden' ? null : v.parse(schema, data.content);

    // Divergence baseline is server-authoritative (never trust the client's
    // sourceHash): recompute the hash of the scraped row this override is based
    // on, by its natural key. 'added' rows have no scraped counterpart → null.
    let serverSourceHash: string | null = null;
    if (data.state !== 'added') {
      const show = await readScrapedShowDetail(data.corpsKey, data.season);
      if (show) {
        serverSourceHash = scrapedSeedableHashes(show)[data.pinnedKey]?.[data.naturalKey] ?? null;
      }
    }

    const db = await getContributionsDb();
    const lockLevel = ((
      await db.execute({
        sql: 'SELECT lock_level FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
        args: [data.corpsKey, data.season],
      })
    ).rows[0]?.lock_level ?? 'none') as PageLock;
    const actor = await requireCapability(getWebRequest(), 'edit', { lockLevel });
    // TODO(rate-limit): the reverted branch called enforceRateLimit(db, actor,
    // 'edit') here; the rate-limit subsystem is not on master yet, so it's omitted.

    const now = new Date().toISOString();
    const ctx = { authorId: actor.userId, actorRole: actor.role, now };
    const pageId = await ensureShowPage(db, data.corpsKey, data.season, ctx);
    const overrideId = await writeOverride(
      db,
      {
        pageId,
        pinnedKey: data.pinnedKey,
        naturalKey: data.naturalKey,
        state: data.state,
        contentJson: content ? JSON.stringify(content) : null,
        sourceHash: serverSourceHash,
        position: data.position,
      },
      ctx,
      data.expectedUpdatedAt
    );
    return { ok: true as const, overrideId, updatedAt: now };
  });
