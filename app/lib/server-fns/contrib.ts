import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { Schema, SchemaParser } from 'effect';
import * as v from 'valibot';
import { getContributionsDb } from '@/lib/contributions-db';
import {
  ensureShowPage,
  writeBlock,
  writeOverride,
  readShowPageContributions,
  readStewardSummary,
  setPageSteward,
  setPageLockLevel,
  type PageContributions,
  type OverrideState,
  type ShowPageLock,
  type StewardSummary,
} from '@/lib/contrib/store';
import { can, getActor, requireCapability, type PageLock } from '@/lib/authz';
import { enforceRateLimit } from '@/lib/contrib/rate-limit';
import {
  BLOCK_SCHEMAS,
  RepertoireRowInputSchema,
  MovementRowInputSchema,
  isAuthoredPinnedKey,
  adaptUniform,
} from '@/lib/contrib/schemas';
import { scrapedSeedableHashes } from '@/lib/contrib/seedable';
import { getShowDetail } from '@/lib/server-fns/hybrid';
import { reconcileShowDivergenceForDetail } from '@/lib/contrib/reconcile';
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

// ── Governance: page lock level + stewards (M9) ───────────────────────────────
export interface ShowGovernance {
  pageId: string | null;
  lockLevel: ShowPageLock;
  status: string;
  stewardCount: number;
  mySteward: boolean;
  stewards: StewardSummary['stewards'];
  signedIn: boolean;
  canLock: boolean;
  canModerate: boolean;
}

const SHOW_PAGE_LOCKS = ['none', 'trusted', 'mod'] as const satisfies readonly ShowPageLock[];

const parseShowPageLock = (value: unknown): ShowPageLock => {
  if (SHOW_PAGE_LOCKS.includes(value as ShowPageLock)) return value as ShowPageLock;
  throw new Error('Invalid page lock level');
};

const pageGovernance = async (
  db: Awaited<ReturnType<typeof getContributionsDb>>,
  corpsKey: string,
  season: string,
  userId: string | null,
  canLockPage: boolean,
  canModerate: boolean
): Promise<ShowGovernance> => {
  const page = (
    await db.execute({
      sql: 'SELECT page_id, lock_level, status FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
      args: [corpsKey, season],
    })
  ).rows[0] as unknown as { page_id: string; lock_level: ShowPageLock; status: string } | undefined;
  const steward: StewardSummary = await readStewardSummary(db, page?.page_id ?? null, userId);
  return {
    pageId: page?.page_id ?? null,
    lockLevel: page?.lock_level ?? 'none',
    status: page?.status ?? 'active',
    stewardCount: steward.stewardCount,
    mySteward: steward.mySteward,
    stewards: steward.stewards,
    signedIn: userId != null,
    canLock: canLockPage,
    canModerate,
  };
};

export const getShowGovernance = createServerFn({ method: 'GET' })
  .validator((data: { corpsKey: string; season: string }) => data)
  .handler(async ({ data }): Promise<ShowGovernance> => {
    const db = await getContributionsDb();
    const actor = await getActor(getRequest());
    return pageGovernance(
      db,
      data.corpsKey,
      data.season,
      actor?.userId ?? null,
      can(actor, 'lock'),
      can(actor, 'orphan')
    );
  });

/** Steward (watch) or unsteward a page — any signed-in editor. Returns fresh state. */
export const setShowSteward = createServerFn({ method: 'POST' })
  .validator((data: { corpsKey: string; season: string; steward: boolean }) => data)
  .handler(async ({ data }): Promise<ShowGovernance> => {
    const actor = await requireCapability(getRequest(), 'edit');
    const now = new Date().toISOString();
    const db = await getContributionsDb();
    const ctx = { authorId: actor.userId, actorRole: actor.role, now };
    const pageId = await ensureShowPage(db, data.corpsKey, data.season, ctx);
    await setPageSteward(db, pageId, data.steward, ctx);
    return pageGovernance(
      db,
      data.corpsKey,
      data.season,
      actor.userId,
      can(actor, 'lock'),
      can(actor, 'orphan')
    );
  });

/** Raise/clear a page's edit lock (moderator) — requires the `lock` capability. */
export const setShowLockLevel = createServerFn({ method: 'POST' })
  .validator((data: { corpsKey: string; season: string; lockLevel: unknown }) => ({
    ...data,
    lockLevel: parseShowPageLock(data.lockLevel),
  }))
  .handler(async ({ data }): Promise<ShowGovernance> => {
    const actor = await requireCapability(getRequest(), 'lock');
    const now = new Date().toISOString();
    const db = await getContributionsDb();
    const ctx = { authorId: actor.userId, actorRole: actor.role, now };
    const pageId = await ensureShowPage(db, data.corpsKey, data.season, ctx);
    await setPageLockLevel(db, pageId, data.lockLevel, ctx);
    return pageGovernance(db, data.corpsKey, data.season, actor.userId, true, can(actor, 'orphan'));
  });

/** Mark/unmark a page orphaned (moderator). Never deletes contributions (§12). */
export const setShowOrphaned = createServerFn({ method: 'POST' })
  .validator((data: { corpsKey: string; season: string; orphaned: boolean }) => data)
  .handler(async ({ data }): Promise<ShowGovernance> => {
    const actor = await requireCapability(getRequest(), 'orphan');
    const now = new Date().toISOString();
    const db = await getContributionsDb();
    const ctx = { authorId: actor.userId, actorRole: actor.role, now };
    const pageId = await ensureShowPage(db, data.corpsKey, data.season, ctx);
    await db.execute({
      sql: 'UPDATE show_pages SET status = ?, updated_at = ? WHERE page_id = ?',
      args: [data.orphaned ? 'orphaned' : 'active', now, pageId],
    });
    return pageGovernance(db, data.corpsKey, data.season, actor.userId, can(actor, 'lock'), true);
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
    const actor = await requireCapability(getRequest(), 'revert', { lockLevel });

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

// ── Read: mini show previews for expandable lineup rows (plan §3.10 / M9k) ────
// Batch-reads the `uniform` first image + a concept excerpt (`about`.plain, else
// `symbolism`.text) for many (corps_key, season) pairs in one query. Server-only
// (createServerFn strips the getContributionsDb import from the client bundle).
export interface ShowPreviewData {
  uniformImageUrl: string | null;
  conceptExcerpt: string | null;
}

const CONCEPT_CLIP = 200;

const clip = (s: string): string => {
  const t = s.trim();
  return t.length > CONCEPT_CLIP ? t.slice(0, CONCEPT_CLIP).trimEnd() + '…' : t;
};

export const getShowPreviews = createServerFn({ method: 'GET' })
  .validator((data: { corpsSeasons: { corpsKey: string; season: string }[] }) => data)
  .handler(async ({ data }): Promise<Record<string, ShowPreviewData>> => {
    const pairs = (data.corpsSeasons ?? []).slice(0, 60);
    const result: Record<string, ShowPreviewData> = {};
    if (pairs.length === 0) return result;

    const db = await getContributionsDb();
    // One query: OR of (corps_key=? AND season=?) over the page join.
    const conds = pairs.map(() => '(p.corps_key = ? AND p.season = ?)').join(' OR ');
    const args: string[] = [];
    for (const { corpsKey, season } of pairs) args.push(corpsKey, season);
    const rows = (
      await db.execute({
        sql: `SELECT p.corps_key AS corps_key, p.season AS season,
                     b.pinned_key AS pinned_key, b.content_json AS content_json
              FROM show_blocks b JOIN show_pages p ON p.page_id = b.page_id
              WHERE b.pinned_key IN ('uniform','about','symbolism') AND (${conds})`,
        args,
      })
    ).rows as unknown as {
      corps_key: string;
      season: string;
      pinned_key: string;
      content_json: string | null;
    }[];

    // Group by key, then derive the two fields, preferring `about` over `symbolism`.
    type Acc = { uniform?: string | null; about?: string | null; symbolism?: string | null };
    const byKey = new Map<string, Acc>();
    for (const r of rows) {
      const key = `${r.corps_key}:${r.season}`;
      const acc = byKey.get(key) ?? {};
      byKey.set(key, acc);
      if (!r.content_json) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.content_json);
      } catch {
        continue;
      }
      if (r.pinned_key === 'uniform') {
        // New shape is `{ sections: [{ images }] }`; legacy is flat `{ images }`.
        // adaptUniform bridges both, so read the first image across all sections.
        acc.uniform = adaptUniform(parsed).sections.flatMap((s) => s.images ?? [])[0]?.url ?? null;
      } else if (r.pinned_key === 'about') {
        const plain = (parsed as { plain?: string }).plain;
        acc.about = typeof plain === 'string' && plain.trim() ? clip(plain) : null;
      } else if (r.pinned_key === 'symbolism') {
        const text = (parsed as { text?: string }).text;
        acc.symbolism = typeof text === 'string' && text.trim() ? clip(text) : null;
      }
    }
    for (const [key, acc] of byKey) {
      result[key] = {
        uniformImageUrl: acc.uniform ?? null,
        conceptExcerpt: acc.about ?? acc.symbolism ?? null,
      };
    }
    return result;
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
    const actor = await requireCapability(getRequest(), 'edit', { lockLevel });
    await enforceRateLimit(db, actor, 'edit');

    // Domain normalization the schema can't express (e.g. hex colors).
    const normalized =
      data.pinnedKey === 'uniform'
        ? {
            ...(content as {
              sections: { colors: { hex: string; label?: string | null }[] }[];
            }),
            sections: (
              content as { sections: { colors: { hex: string; label?: string | null }[] }[] }
            ).sections.map((s) => ({
              ...s,
              colors: s.colors.map((c) => ({ ...c, hex: normalizeHex(c.hex) ?? c.hex })),
            })),
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
    const actor = await requireCapability(getRequest(), 'edit', { lockLevel });
    await enforceRateLimit(db, actor, 'edit');

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

// ── Reconcile: re-check overrides against the latest scrape (moderator action) ──
// Flips each override's scrape_diverged flag so the "source changed" badges reflect
// reality after a fresh scrape. Gated on the 'lock' capability (moderator/admin).
export const reconcileShowDivergence = createServerFn({ method: 'POST' })
  .validator((data: { corpsKey: string; season: string }) => data)
  .handler(async ({ data }) => {
    const db = await getContributionsDb();
    const lockLevel = ((
      await db.execute({
        sql: 'SELECT lock_level FROM show_pages WHERE corps_key = ? AND season = ? LIMIT 1',
        args: [data.corpsKey, data.season],
      })
    ).rows[0]?.lock_level ?? 'none') as PageLock;
    await requireCapability(getRequest(), 'lock', { lockLevel });
    const show = await readScrapedShowDetail(data.corpsKey, data.season);
    return reconcileShowDivergenceForDetail(db, data.corpsKey, data.season, show);
  });
