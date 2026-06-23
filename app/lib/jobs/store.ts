import type { Client, Transaction } from '@libsql/client';
import { durableStorageStatus } from '@/lib/contributions-db';

export interface WriteContext {
  authorId: string;
  actorRole: string;
  now: string;
}

class DurableStorageUnavailableError extends Error {
  readonly _tag = 'DurableStorageUnavailableError';
  constructor(reason: string) {
    super(`Jobs storage is not writable: ${reason}`);
  }
}

const assertWritable = () => {
  const status = durableStorageStatus();
  if (!status.ready) throw new DurableStorageUnavailableError(status.reason);
};

export const newId = () => crypto.randomUUID();

// ── Reads ────────────────────────────────────────────────────────────────────

export interface ProfileRow {
  profile_id: string;
  user_id: string;
  kind: string;
  slug: string;
  display_name: string;
  headline: string | null;
  location: string | null;
  status: string;
  contact_email: string | null;
  contact_visibility: string;
  links_json: string | null;
  notify_on_apply: number;
  accepted_terms_version: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileBlockRow {
  block_id: string;
  profile_id: string;
  kind: string;
  content_json: string;
  position: number;
  updated_at: string;
  updated_by: string;
}

export interface PublicProfile {
  profile: ProfileRow;
  blocks: ProfileBlockRow[];
}

export const readPublicProfile = async (
  db: Client,
  slug: string
): Promise<PublicProfile | null> => {
  const profileRes = await db.execute({
    sql: `SELECT * FROM jobs_profile WHERE slug = ? AND status IN ('published', 'draft') LIMIT 1`,
    args: [slug],
  });
  const profile = (profileRes.rows[0] as unknown as ProfileRow) ?? null;
  if (!profile) return null;

  const blocksRes = await db.execute({
    sql: 'SELECT * FROM jobs_profile_block WHERE profile_id = ? ORDER BY position',
    args: [profile.profile_id],
  });
  return { profile, blocks: blocksRes.rows as unknown as ProfileBlockRow[] };
};

export const readProfileByUser = async (
  db: Client,
  userId: string
): Promise<PublicProfile | null> => {
  const profileRes = await db.execute({
    sql: 'SELECT * FROM jobs_profile WHERE user_id = ? LIMIT 1',
    args: [userId],
  });
  const profile = (profileRes.rows[0] as unknown as ProfileRow) ?? null;
  if (!profile) return null;

  const blocksRes = await db.execute({
    sql: 'SELECT * FROM jobs_profile_block WHERE profile_id = ? ORDER BY position',
    args: [profile.profile_id],
  });
  return { profile, blocks: blocksRes.rows as unknown as ProfileBlockRow[] };
};

// ── Writes ───────────────────────────────────────────────────────────────────

export const uniqueSlug = async (db: Client, base: string): Promise<string> => {
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) slug = 'user';
  let candidate = slug;
  let suffix = 2;
  while (true) {
    const existing = await db.execute({
      sql: 'SELECT 1 FROM jobs_profile WHERE slug = ? LIMIT 1',
      args: [candidate],
    });
    if (!existing.rows[0]) return candidate;
    candidate = `${slug}-${suffix}`;
    suffix++;
  }
};

export const ensureMyProfile = async (
  db: Client,
  userId: string,
  kind: string,
  ctx: WriteContext
): Promise<string> => {
  assertWritable();
  const existing = await db.execute({
    sql: 'SELECT profile_id FROM jobs_profile WHERE user_id = ? LIMIT 1',
    args: [userId],
  });
  if (existing.rows[0]) return String(existing.rows[0].profile_id);

  const profileId = newId();
  const slug = await uniqueSlug(db, userId.slice(0, 8));
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO jobs_profile (profile_id, user_id, kind, slug, display_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [profileId, userId, kind, slug, 'User', ctx.now, ctx.now],
    });
    await insertJobsRevision(tx, {
      targetKind: 'profile',
      targetId: profileId,
      op: 'create',
      before: null,
      after: null,
      ctx,
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
  return profileId;
};

export interface BlockInput {
  profileId: string;
  kind: string;
  contentJson: string;
}

export const writeProfileBlock = async (
  db: Client,
  input: BlockInput,
  ctx: WriteContext
): Promise<string> => {
  assertWritable();
  const tx = await db.transaction('write');
  try {
    const prev = await tx.execute({
      sql: 'SELECT block_id, content_json FROM jobs_profile_block WHERE profile_id = ? AND kind = ? LIMIT 1',
      args: [input.profileId, input.kind],
    });
    const existing = prev.rows[0] as { block_id: string; content_json: string } | undefined;

    const blockId = existing?.block_id ?? newId();
    if (existing) {
      await tx.execute({
        sql: 'UPDATE jobs_profile_block SET content_json = ?, updated_at = ?, updated_by = ? WHERE block_id = ?',
        args: [input.contentJson, ctx.now, ctx.authorId, blockId],
      });
    } else {
      const maxPosRes = await tx.execute({
        sql: 'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM jobs_profile_block WHERE profile_id = ?',
        args: [input.profileId],
      });
      const position = Number((maxPosRes.rows[0] as { next_pos: number }).next_pos);
      await tx.execute({
        sql: `INSERT INTO jobs_profile_block (block_id, profile_id, kind, content_json, position, updated_at, updated_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          blockId,
          input.profileId,
          input.kind,
          input.contentJson,
          position,
          ctx.now,
          ctx.authorId,
        ],
      });
    }
    await touchProfile(tx, input.profileId, ctx.now);
    await insertJobsRevision(tx, {
      targetKind: 'block',
      targetId: blockId,
      op: existing ? 'edit' : 'create',
      before: existing?.content_json ?? null,
      after: input.contentJson,
      ctx,
    });
    await tx.commit();
    return blockId;
  } catch (e) {
    await tx.rollback();
    throw e;
  }
};

export const publishProfile = async (
  db: Client,
  profileId: string,
  ctx: WriteContext
): Promise<void> => {
  assertWritable();
  const tx = await db.transaction('write');
  try {
    const prev = await tx.execute({
      sql: 'SELECT status FROM jobs_profile WHERE profile_id = ? LIMIT 1',
      args: [profileId],
    });
    const before = (prev.rows[0] as { status: string } | undefined)?.status ?? null;
    await tx.execute({
      sql: "UPDATE jobs_profile SET status = 'published', updated_at = ? WHERE profile_id = ?",
      args: [ctx.now, profileId],
    });
    await insertJobsRevision(tx, {
      targetKind: 'profile',
      targetId: profileId,
      op: 'publish',
      before,
      after: 'published',
      ctx,
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
};

// ── Internals ────────────────────────────────────────────────────────────────

const touchProfile = (tx: Transaction, profileId: string, now: string) =>
  tx.execute({
    sql: 'UPDATE jobs_profile SET updated_at = ? WHERE profile_id = ?',
    args: [now, profileId],
  });

export const insertJobsRevision = (
  tx: Transaction,
  r: {
    targetKind: string;
    targetId: string | null;
    op: string;
    before: string | null;
    after: string | null;
    ctx: WriteContext;
  }
) =>
  tx.execute({
    sql: `INSERT INTO jobs_revision
            (revision_id, target_kind, target_id, actor_user_id, actor_role, op,
             before_json, after_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId(),
      r.targetKind,
      r.targetId,
      r.ctx.authorId,
      r.ctx.actorRole,
      r.op,
      r.before,
      r.after,
      r.ctx.now,
    ],
  });
