import { Context, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { randomUUID } from 'node:crypto';
import { JobsSql, JobsSqlLive, requireDurableStorage } from './jobs-sql';
import { getReadModelClient } from '@/lib/read-model-db';
import { readStaffDirectory, readStaffProfile } from '@sdk/src/readModel/readers';
import { readJudgeDirectory, readJudgeProfile } from '@sdk/src/readModel/readers';
import type { StaffProfile, StaffSummary } from '@sdk/src/readModel/builders/staff';
import type { JudgeProfile, JudgeSummary } from '@sdk/src/readModel/builders/judges';
import { NotFound, Forbidden, ProfileExists } from './errors';

const newId = () => randomUUID();

export interface WriteContext {
  authorId: string;
  actorRole: string;
  now: string;
}

// ── Service builder ─────────────────────────────────────────────────────────

const makeJobsService = Effect.gen(function* () {
  const sql = yield* JobsSql;

  // ── Profile reads ───────────────────────────────────────────────────────

  const getProfileBySlug = Effect.fn('JobsService.getProfileBySlug')(function* (slug: string) {
    const rows = yield* sql<{
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
    }>`SELECT * FROM jobs_profile WHERE slug = ${slug} AND status IN ('published', 'draft') LIMIT 1`;
    const profile = rows[0];
    if (!profile) return null;

    const blocks = yield* sql<{
      block_id: string;
      profile_id: string;
      kind: string;
      content_json: string;
      position: number;
      updated_at: string;
      updated_by: string;
    }>`SELECT * FROM jobs_profile_block WHERE profile_id = ${profile.profile_id} ORDER BY position`;
    return { profile, blocks };
  });

  const getProfileByUser = Effect.fn('JobsService.getProfileByUser')(function* (userId: string) {
    const rows = yield* sql<{
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
    }>`SELECT * FROM jobs_profile WHERE user_id = ${userId} LIMIT 1`;
    const profile = rows[0];
    if (!profile) return null;

    const blocks = yield* sql<{
      block_id: string;
      profile_id: string;
      kind: string;
      content_json: string;
      position: number;
      updated_at: string;
      updated_by: string;
    }>`SELECT * FROM jobs_profile_block WHERE profile_id = ${profile.profile_id} ORDER BY position`;
    return { profile, blocks };
  });

  // ── Slug generation ────────────────────────────────────────────────────

  const generateSlug = Effect.fn('JobsService.generateSlug')(function* (base: string) {
    let slug = base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) slug = 'user';
    let candidate = slug;
    let suffix = 2;
    while (true) {
      const existing = yield* sql<{
        c: number;
      }>`SELECT 1 AS c FROM jobs_profile WHERE slug = ${candidate} LIMIT 1`;
      if (!existing[0]) return candidate;
      candidate = `${slug}-${suffix}`;
      suffix++;
    }
  });

  // ── Profile writes ──────────────────────────────────────────────────────

  const createProfile = Effect.fn('JobsService.createProfile')(function* (
    userId: string,
    kind: string,
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;

    const existing = yield* sql<{
      profile_id: string;
    }>`SELECT profile_id FROM jobs_profile WHERE user_id = ${userId} LIMIT 1`;
    if (existing[0])
      return yield* Effect.fail(new ProfileExists({ profileId: existing[0].profile_id }));

    const profileId = newId();
    const slug = yield* generateSlug(userId.slice(0, 8));

    yield* sql`INSERT INTO jobs_profile (profile_id, user_id, kind, slug, display_name, created_at, updated_at)
               VALUES (${profileId}, ${userId}, ${kind}, ${slug}, 'User', ${ctx.now}, ${ctx.now})`;

    yield* sql`INSERT INTO jobs_revision (revision_id, target_kind, target_id, actor_user_id, actor_role, op, created_at)
               VALUES (${newId()}, 'profile', ${profileId}, ${ctx.authorId}, ${ctx.actorRole}, 'create', ${ctx.now})`;

    return profileId;
  });

  const updateProfile = Effect.fn('JobsService.updateProfile')(function* (
    profileId: string,
    data: {
      displayName?: string;
      headline?: string;
      location?: string;
      contactEmail?: string;
      contactVisibility?: string;
      slug?: string;
    },
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;

    const fields: string[] = [];
    const args: unknown[] = [];

    if (data.displayName !== undefined) {
      fields.push('display_name = ?');
      args.push(data.displayName);
    }
    if (data.headline !== undefined) {
      fields.push('headline = ?');
      args.push(data.headline);
    }
    if (data.location !== undefined) {
      fields.push('location = ?');
      args.push(data.location);
    }
    if (data.contactEmail !== undefined) {
      fields.push('contact_email = ?');
      args.push(data.contactEmail);
    }
    if (data.contactVisibility !== undefined) {
      fields.push('contact_visibility = ?');
      args.push(data.contactVisibility);
    }
    if (data.slug !== undefined) {
      fields.push('slug = ?');
      args.push(data.slug);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    args.push(ctx.now);
    args.push(profileId);

    yield* sql(`UPDATE jobs_profile SET ${fields.join(', ')} WHERE profile_id = ?`).pipe(
      Effect.orDie
    );
  });

  // ── Block writes ────────────────────────────────────────────────────────

  const writeBlock = Effect.fn('JobsService.writeBlock')(function* (
    profileId: string,
    kind: string,
    contentJson: string,
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;

    const existing = yield* sql<{
      block_id: string;
      content_json: string;
    }>`SELECT block_id, content_json FROM jobs_profile_block WHERE profile_id = ${profileId} AND kind = ${kind} LIMIT 1`;

    const blockId = existing[0]?.block_id ?? newId();

    if (existing[0]) {
      yield* sql`UPDATE jobs_profile_block SET content_json = ${contentJson}, updated_at = ${ctx.now}, updated_by = ${ctx.authorId} WHERE block_id = ${blockId}`;
    } else {
      const maxPos = yield* sql<{
        p: number;
      }>`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM jobs_profile_block WHERE profile_id = ${profileId}`;
      const position = maxPos[0]?.p ?? 0;
      yield* sql`INSERT INTO jobs_profile_block (block_id, profile_id, kind, content_json, position, updated_at, updated_by)
                 VALUES (${blockId}, ${profileId}, ${kind}, ${contentJson}, ${position}, ${ctx.now}, ${ctx.authorId})`;
    }

    yield* sql`UPDATE jobs_profile SET updated_at = ${ctx.now} WHERE profile_id = ${profileId}`;
    yield* sql`INSERT INTO jobs_revision (revision_id, target_kind, target_id, actor_user_id, actor_role, op, before_json, after_json, created_at)
               VALUES (${newId()}, 'block', ${blockId}, ${ctx.authorId}, ${ctx.actorRole}, ${existing[0] ? 'edit' : 'create'}, ${existing[0]?.content_json ?? null}, ${contentJson}, ${ctx.now})`;

    return blockId;
  });

  const publishProfile = Effect.fn('JobsService.publishProfile')(function* (
    profileId: string,
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;

    const prev = yield* sql<{
      status: string;
    }>`SELECT status FROM jobs_profile WHERE profile_id = ${profileId} LIMIT 1`;
    const before = prev[0]?.status ?? null;

    yield* sql`UPDATE jobs_profile SET status = 'published', updated_at = ${ctx.now} WHERE profile_id = ${profileId}`;
    yield* sql`INSERT INTO jobs_revision (revision_id, target_kind, target_id, actor_user_id, actor_role, op, before_json, after_json, created_at)
               VALUES (${newId()}, 'profile', ${profileId}, ${ctx.authorId}, ${ctx.actorRole}, 'publish', ${before}, 'published', ${ctx.now})`;
  });

  // ── Posting reads ───────────────────────────────────────────────────────

  const getPostingBySlug = Effect.fn('JobsService.getPostingBySlug')(function* (slug: string) {
    const rows = yield* sql<{
      posting_id: string;
      employer_profile_id: string;
      slug: string;
      title: string;
      location: string | null;
      remote_ok: number;
      comp_text: string | null;
      salary_min: number | null;
      salary_max: number | null;
      salary_currency: string | null;
      apply_url: string | null;
      apply_email: string | null;
      content_json: string;
      status: string;
      published_at: string | null;
      expires_at: string | null;
      is_boosted: number;
      boosted_until: string | null;
      created_at: string;
      updated_at: string;
    }>`SELECT * FROM jobs_posting WHERE slug = ${slug} LIMIT 1`;
    return rows[0] ?? null;
  });

  const listPostings = Effect.fn('JobsService.listPostings')(function* (
    filters: {
      status?: string;
      keyword?: string;
      location?: string;
      remote?: boolean;
      offset?: number;
      limit?: number;
    } = {}
  ) {
    const conditions: string[] = [];
    const args: unknown[] = [];
    let sqlStr = 'SELECT * FROM jobs_posting WHERE 1=1';

    if (filters.status) {
      conditions.push('status = ?');
      args.push(filters.status);
    } else {
      conditions.push("status = 'published'");
    }

    if (filters.keyword) {
      conditions.push('title LIKE ?');
      args.push(`%${filters.keyword}%`);
    }
    if (filters.location) {
      conditions.push('location LIKE ?');
      args.push(`%${filters.location}%`);
    }
    if (filters.remote) {
      conditions.push('remote_ok = 1');
    }

    if (conditions.length) sqlStr += ' AND ' + conditions.join(' AND ');
    sqlStr += ' ORDER BY is_boosted DESC, published_at DESC';
    sqlStr += ` LIMIT ${filters.limit ?? 20} OFFSET ${filters.offset ?? 0}`;

    const rows = yield* sql<{
      posting_id: string;
      employer_profile_id: string;
      slug: string;
      title: string;
      location: string | null;
      remote_ok: number;
      comp_text: string | null;
      salary_min: number | null;
      salary_max: number | null;
      apply_url: string | null;
      content_json: string;
      status: string;
      published_at: string | null;
      is_boosted: number;
      created_at: string;
    }>(sqlStr).pipe(Effect.orDie);

    const countRows = yield* sql<{ c: number }>(
      `SELECT COUNT(*) AS c FROM jobs_posting WHERE ${conditions.join(' AND ')}`
    ).pipe(Effect.orDie);

    return { rows, total: Number(countRows[0]?.c ?? 0) };
  });

  const listPostingsByEmployer = Effect.fn('JobsService.listPostingsByEmployer')(function* (
    employerProfileId: string
  ) {
    return yield* sql<{
      posting_id: string;
      slug: string;
      title: string;
      location: string | null;
      status: string;
      published_at: string | null;
      is_boosted: number;
      created_at: string;
    }>`SELECT posting_id, slug, title, location, status, published_at, is_boosted, created_at
       FROM jobs_posting WHERE employer_profile_id = ${employerProfileId}
       ORDER BY created_at DESC`;
  });

  // ── Posting writes ──────────────────────────────────────────────────────

  const generatePostingSlug = Effect.fn('JobsService.generatePostingSlug')(function* (
    base: string
  ) {
    let slug = base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) slug = 'job';
    let candidate = slug;
    let suffix = 2;
    while (true) {
      const existing = yield* sql<{
        c: number;
      }>`SELECT 1 AS c FROM jobs_posting WHERE slug = ${candidate} LIMIT 1`;
      if (!existing[0]) return candidate;
      candidate = `${slug}-${suffix}`;
      suffix++;
    }
  });

  const createPosting = Effect.fn('JobsService.createPosting')(function* (
    employerProfileId: string,
    data: {
      title: string;
      location?: string;
      remoteOk?: boolean;
      compText?: string;
      salaryMin?: number | null;
      salaryMax?: number | null;
      applyUrl?: string;
      applyEmail?: string;
      contentJson: string;
    },
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;
    const postingId = newId();
    const slug = yield* generatePostingSlug(data.title);

    yield* sql`INSERT INTO jobs_posting (posting_id, employer_profile_id, slug, title,
                 location, remote_ok, comp_text, salary_min, salary_max,
                 apply_url, apply_email, content_json, status, created_at, updated_at)
               VALUES (${postingId}, ${employerProfileId}, ${slug}, ${data.title},
                 ${data.location ?? null}, ${data.remoteOk ? 1 : 0}, ${data.compText ?? null},
                 ${data.salaryMin ?? null}, ${data.salaryMax ?? null},
                 ${data.applyUrl ?? null}, ${data.applyEmail ?? null}, ${data.contentJson},
                 'published', ${ctx.now}, ${ctx.now})`;

    yield* sql`INSERT INTO jobs_revision (revision_id, target_kind, target_id, actor_user_id, actor_role, op, created_at)
               VALUES (${newId()}, 'posting', ${postingId}, ${ctx.authorId}, ${ctx.actorRole}, 'create', ${ctx.now})`;
    return postingId;
  });

  const updatePosting = Effect.fn('JobsService.updatePosting')(function* (
    postingId: string,
    data: {
      title?: string;
      location?: string;
      remoteOk?: boolean;
      compText?: string;
      salaryMin?: number | null;
      salaryMax?: number | null;
      applyUrl?: string;
      applyEmail?: string;
      contentJson?: string;
      status?: string;
    },
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;
    const fields: string[] = [];
    const args: unknown[] = [];

    if (data.title !== undefined) {
      fields.push('title = ?');
      args.push(data.title);
    }
    if (data.location !== undefined) {
      fields.push('location = ?');
      args.push(data.location);
    }
    if (data.remoteOk !== undefined) {
      fields.push('remote_ok = ?');
      args.push(data.remoteOk ? 1 : 0);
    }
    if (data.compText !== undefined) {
      fields.push('comp_text = ?');
      args.push(data.compText);
    }
    if (data.salaryMin !== undefined) {
      fields.push('salary_min = ?');
      args.push(data.salaryMin);
    }
    if (data.salaryMax !== undefined) {
      fields.push('salary_max = ?');
      args.push(data.salaryMax);
    }
    if (data.applyUrl !== undefined) {
      fields.push('apply_url = ?');
      args.push(data.applyUrl);
    }
    if (data.applyEmail !== undefined) {
      fields.push('apply_email = ?');
      args.push(data.applyEmail);
    }
    if (data.contentJson !== undefined) {
      fields.push('content_json = ?');
      args.push(data.contentJson);
    }
    if (data.status !== undefined) {
      fields.push('status = ?');
      args.push(data.status);
    }

    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    args.push(ctx.now);
    args.push(postingId);
    yield* sql(`UPDATE jobs_posting SET ${fields.join(', ')} WHERE posting_id = ?`).pipe(
      Effect.orDie
    );

    yield* sql`INSERT INTO jobs_revision (revision_id, target_kind, target_id, actor_user_id, actor_role, op, created_at)
               VALUES (${newId()}, 'posting', ${postingId}, ${ctx.authorId}, ${ctx.actorRole}, 'edit', ${ctx.now})`;
  });

  const closePosting = Effect.fn('JobsService.closePosting')(function* (
    postingId: string,
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;
    yield* sql`UPDATE jobs_posting SET status = 'closed', updated_at = ${ctx.now} WHERE posting_id = ${postingId}`;
    yield* sql`INSERT INTO jobs_revision (revision_id, target_kind, target_id, actor_user_id, actor_role, op, created_at)
               VALUES (${newId()}, 'posting', ${postingId}, ${ctx.authorId}, ${ctx.actorRole}, 'close', ${ctx.now})`;
  });

  // ── Applications ─────────────────────────────────────────────────────────

  const applyToPosting = Effect.fn('JobsService.applyToPosting')(function* (
    postingId: string,
    applicantUserId: string,
    message?: string
  ) {
    yield* requireDurableStorage;
    const applicationId = newId();
    const now = new Date().toISOString();
    yield* sql`INSERT INTO jobs_application (application_id, posting_id, applicant_user_id, message, created_at)
               VALUES (${applicationId}, ${postingId}, ${applicantUserId}, ${message ?? null}, ${now})`;

    // Fetch employer contact info for notification
    const posting = yield* sql<{
      employer_profile_id: string;
      title: string;
    }>`SELECT employer_profile_id, title FROM jobs_posting WHERE posting_id = ${postingId} LIMIT 1`;
    const employer = yield* sql<{
      contact_email: string | null;
      display_name: string;
      notify_on_apply: number;
    }>`SELECT contact_email, display_name, notify_on_apply FROM jobs_profile WHERE profile_id = ${posting[0]?.employer_profile_id} LIMIT 1`;

    return {
      applicationId,
      employerEmail: employer[0]?.contact_email ?? null,
      jobTitle: posting[0]?.title ?? '',
    };
  });

  // ── Claims ────────────────────────────────────────────────────────────────

  const getClaimsForUser = Effect.fn('JobsService.getClaimsForUser')(function* (userId: string) {
    return yield* sql<{
      claim_id: string;
      profile_id: string;
      entity_type: string;
      entity_id: string;
      status: string;
      claimed_at: string;
    }>`SELECT claim_id, profile_id, entity_type, entity_id, status, claimed_at
       FROM jobs_person_claim WHERE user_id = ${userId} ORDER BY claimed_at DESC`;
  });

  const getClaimByEntity = Effect.fn('JobsService.getClaimByEntity')(function* (
    entityType: string,
    entityId: string
  ) {
    const rows = yield* sql<{
      claim_id: string;
      user_id: string;
      profile_id: string;
      status: string;
    }>`SELECT claim_id, user_id, profile_id, status FROM jobs_person_claim
       WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND status = 'active' LIMIT 1`;
    return rows[0] ?? null;
  });

  const claimPerson = Effect.fn('JobsService.claimPerson')(function* (
    userId: string,
    profileId: string,
    entityType: string,
    entityId: string,
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;

    // Check not already claimed
    const existing = yield* sql<{
      claim_id: string;
    }>`SELECT claim_id FROM jobs_person_claim WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND status = 'active' LIMIT 1`;
    if (existing[0]) return yield* Effect.fail(new Error('This page is already claimed'));

    const claimId = newId();
    yield* sql`INSERT INTO jobs_person_claim (claim_id, user_id, profile_id, entity_type, entity_id, status, claimed_at)
               VALUES (${claimId}, ${userId}, ${profileId}, ${entityType}, ${entityId}, 'active', ${ctx.now})`;
    yield* sql`INSERT INTO jobs_revision (revision_id, target_kind, target_id, actor_user_id, actor_role, op, created_at)
               VALUES (${newId()}, 'claim', ${claimId}, ${ctx.authorId}, ${ctx.actorRole}, 'create', ${ctx.now})`;

    // Read read-model profile to seed blocks (bridge async SDK readers via Effect.promise)
    const db = getReadModelClient();
    let displayName = '';
    if (entityType === 'staff') {
      const profile = yield* Effect.promise(() => readStaffProfile(db, entityId));
      if (profile) {
        displayName = profile.display_name;
        // Seed summary from biography
        if (profile.biography) {
          const summaryJson = JSON.stringify({
            format: 'lexical',
            version: 1,
            doc: profile.biography,
            plain: profile.biography.slice(0, 500),
          });
          yield* writeBlock(profileId, 'summary', summaryJson, ctx);
        }
        // Seed experience from assignments
        if (profile.assignments.length > 0) {
          const exp = {
            items: profile.assignments.map((a) => ({
              org: a.corps_name ?? '',
              role: a.title ?? '',
              startYear: a.season ?? '',
              endYear: a.season ?? '',
            })),
          };
          yield* writeBlock(profileId, 'experience', JSON.stringify(exp), ctx);
        }
        // Seed location from bioFacts
        if (profile.bioFacts?.hometown) {
          yield* sql`UPDATE jobs_profile SET location = ${profile.bioFacts.hometown}, updated_at = ${ctx.now} WHERE profile_id = ${profileId}`;
        }
        // Seed skills from caption assignments
        const captions = [...new Set(profile.assignments.map((a) => a.caption).filter(Boolean))];
        if (captions.length > 0) {
          yield* writeBlock(profileId, 'skills', JSON.stringify({ items: captions }), ctx);
        }
      }
    } else if (entityType === 'judge') {
      const profile = yield* Effect.promise(() => readJudgeProfile(db, entityId));
      if (profile) {
        displayName = profile.display_name;
        if (profile.biography) {
          const summaryJson = JSON.stringify({
            format: 'lexical',
            version: 1,
            doc: profile.biography,
            plain: profile.biography.slice(0, 500),
          });
          yield* writeBlock(profileId, 'summary', summaryJson, ctx);
        }
        if (profile.assignments.length > 0) {
          const exp = {
            items: profile.assignments.map((a) => ({
              org: a.competition_name ?? '',
              role: `Judge — ${a.caption ?? ''}`,
              startYear: a.season ?? '',
              endYear: a.season ?? '',
            })),
          };
          yield* writeBlock(profileId, 'experience', JSON.stringify(exp), ctx);
        }
      }
    }

    // Update display name from the read-model
    if (displayName) {
      yield* sql`UPDATE jobs_profile SET display_name = ${displayName}, updated_at = ${ctx.now} WHERE profile_id = ${profileId}`;
    }

    return claimId;
  });

  const revokeClaim = Effect.fn('JobsService.revokeClaim')(function* (
    claimId: string,
    revokedBy: string,
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;
    yield* sql`UPDATE jobs_person_claim SET status = 'revoked', revoked_at = ${ctx.now}, revoked_by = ${revokedBy}
               WHERE claim_id = ${claimId}`;
    yield* sql`INSERT INTO jobs_revision (revision_id, target_kind, target_id, actor_user_id, actor_role, op, created_at)
               VALUES (${newId()}, 'claim', ${claimId}, ${ctx.authorId}, ${ctx.actorRole}, 'revoke', ${ctx.now})`;
  });

  const suggestClaimMatches = Effect.fn('JobsService.suggestClaimMatches')(function* (
    userName: string
  ) {
    const q = userName.toLowerCase().trim();
    if (q.length < 2) return [];
    const db = getReadModelClient();

    // Search staff directory
    const staffAll = readStaffDirectory(db);
    const judgeAll = readJudgeDirectory(db);
    const [staffList, judgeList] = yield* Effect.promise(() => Promise.all([staffAll, judgeAll]));

    const staffMatches = staffList
      .filter((s) => s.display_name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((s) => ({
        entityType: 'staff' as const,
        entityId: s.person_id,
        displayName: s.display_name,
        photoUrl: s.photo_url ?? null,
        description: s.default_title ?? `${s.corps_count} corps`,
        seasons: s.seasons,
      }));

    const judgeMatches = judgeList
      .filter((j) => j.display_name.toLowerCase().includes(q))
      .slice(0, 5)
      .map((j) => ({
        entityType: 'judge' as const,
        entityId: j.judge_id,
        displayName: j.display_name,
        photoUrl: j.photo_url ?? null,
        description: `${j.assignment_count} assignments`,
        seasons: j.seasons,
      }));

    return [...staffMatches, ...judgeMatches].slice(0, 8);
  });

  // ── Ownership guard ─────────────────────────────────────────────────────

  const requireOwner = Effect.fn('JobsService.requireOwner')(function* (
    profileId: string,
    actorUserId: string,
    isModerator: boolean
  ) {
    const row = yield* sql<{
      user_id: string;
    }>`SELECT user_id FROM jobs_profile WHERE profile_id = ${profileId} LIMIT 1`;
    if (!row[0]) return yield* Effect.fail(new NotFound({ message: 'Profile not found' }));
    if (row[0].user_id !== actorUserId && !isModerator) {
      return yield* Effect.fail(new Forbidden({ message: 'You do not own this profile' }));
    }
  });

  return {
    getProfileBySlug,
    getProfileByUser,
    createProfile,
    updateProfile,
    writeBlock,
    publishProfile,
    generateSlug,
    requireOwner,
    // Postings
    getPostingBySlug,
    listPostings,
    listPostingsByEmployer,
    createPosting,
    updatePosting,
    closePosting,
    applyToPosting,
    getClaimsForUser,
    getClaimByEntity,
    claimPerson,
    revokeClaim,
    suggestClaimMatches,
  };
});

export class JobsService extends Context.Service<
  JobsService,
  Effect.Success<typeof makeJobsService>
>()('JobsService') {}

export const JobsServiceLive = Layer.effect(JobsService, makeJobsService).pipe(
  Layer.provide(JobsSqlLive)
);
