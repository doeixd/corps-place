import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { Effect } from 'effect';
import { getActor, ForbiddenError } from '@/lib/authz';
import { JobsService, JobsServiceLive } from '@/lib/jobs/jobs-service';
import { JOBS_BLOCK_SCHEMAS, isJobsBlockKind } from '@/lib/jobs/schemas';

const getJobsCtx = async () => {
  const actor = await getActor(getWebRequest());
  if (!actor) throw new ForbiddenError('edit');
  return { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() };
};

// ── Reads (public) ──────────────────────────────────────────────────────────

export const getJobsProfile = createServerFn({ method: 'GET' })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) =>
    Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getProfileBySlug(data.slug)).pipe(
        Effect.provide(JobsServiceLive)
      )
    )
  );

export const getMyJobsProfile = createServerFn({ method: 'GET' }).handler(async () => {
  const actor = await getActor(getWebRequest());
  if (!actor) return null;
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(actor.userId)).pipe(
      Effect.provide(JobsServiceLive)
    )
  );
});

// ── Writes (authed) ─────────────────────────────────────────────────────────

const UpsertProfileInput = v.object({
  kind: v.optional(v.picklist(['employee', 'employer']), 'employee'),
  displayName: v.optional(v.string(), ''),
  headline: v.optional(v.string(), ''),
  location: v.optional(v.string(), ''),
});

export const upsertJobsProfile = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UpsertProfileInput, d))
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();

    const existing = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(ctx.authorId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );

    let profileId: string;
    if (existing) {
      profileId = existing.profile.profile_id;
      await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) =>
          svc.updateProfile(
            profileId,
            {
              displayName: data.displayName,
              headline: data.headline,
              location: data.location,
            },
            ctx
          )
        ).pipe(Effect.provide(JobsServiceLive))
      );
    } else {
      profileId = await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) => svc.createProfile(ctx.authorId, data.kind, ctx)).pipe(
          Effect.provide(JobsServiceLive)
        )
      );
      await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) =>
          svc.updateProfile(
            profileId,
            {
              displayName: data.displayName,
              headline: data.headline,
              location: data.location,
            },
            ctx
          )
        ).pipe(Effect.provide(JobsServiceLive))
      );
    }

    return { ok: true as const, profileId };
  });

const SaveBlockInput = v.object({
  profileId: v.string(),
  kind: v.string(),
  content: v.unknown(),
});

export const saveJobsProfileBlock = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SaveBlockInput, d))
  .handler(async ({ data }) => {
    if (!isJobsBlockKind(data.kind)) throw new Error(`Unknown block kind: ${data.kind}`);
    const content = v.parse(JOBS_BLOCK_SCHEMAS[data.kind], data.content);
    const ctx = await getJobsCtx();

    const blockId = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.writeBlock(data.profileId, data.kind, JSON.stringify(content), ctx)
      ).pipe(Effect.provide(JobsServiceLive))
    );
    return { ok: true as const, blockId, updatedAt: ctx.now };
  });

export const publishJobsProfile = createServerFn({ method: 'POST' })
  .validator((d: { profileId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.publishProfile(data.profileId, ctx)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    return { ok: true as const };
  });

// ── Postings ─────────────────────────────────────────────────────────────────

export const getJobPosting = createServerFn({ method: 'GET' })
  .validator((d: { slug: string }) => d)
  .handler(async ({ data }) =>
    Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getPostingBySlug(data.slug)).pipe(
        Effect.provide(JobsServiceLive)
      )
    )
  );

export const listJobs = createServerFn({ method: 'GET' })
  .validator(
    (d: {
      keyword?: string;
      location?: string;
      remote?: boolean;
      offset?: number;
      limit?: number;
    }) => d
  )
  .handler(async ({ data }) =>
    Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.listPostings(data)).pipe(
        Effect.provide(JobsServiceLive)
      )
    )
  );

const CreatePostingInput = v.object({
  title: v.pipe(v.string(), v.minLength(1, 'Title required')),
  location: v.optional(v.string(), ''),
  remoteOk: v.optional(v.boolean(), false),
  compText: v.optional(v.string(), ''),
  salaryMin: v.optional(v.nullable(v.number())),
  salaryMax: v.optional(v.nullable(v.number())),
  applyUrl: v.optional(v.string(), ''),
  applyEmail: v.optional(v.string(), ''),
  contentJson: v.string(),
});

export const createJobPosting = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreatePostingInput, d))
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    const profile = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(ctx.authorId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    if (!profile || profile.profile.kind !== 'employer')
      throw new Error('Only employers can post jobs');
    const postingId = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.createPosting(profile.profile.profile_id, data, ctx)
      ).pipe(Effect.provide(JobsServiceLive))
    );
    return { ok: true as const, postingId };
  });

export const closeJobPosting = createServerFn({ method: 'POST' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.closePosting(data.postingId, ctx)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    return { ok: true as const };
  });

export const applyToJob = createServerFn({ method: 'POST' })
  .validator((d: { postingId: string; message?: string }) => d)
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('Sign in to apply');
    const result = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.applyToPosting(data.postingId, actor.userId, data.message)
      ).pipe(Effect.provide(JobsServiceLive))
    );
    return { ok: true as const, applicationId: result.applicationId };
  });

// ── Claims ───────────────────────────────────────────────────────────────────

export const suggestClaimMatches = createServerFn({ method: 'GET' })
  .validator((d: { userName: string }) => d)
  .handler(async ({ data }) =>
    Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.suggestClaimMatches(data.userName)).pipe(
        Effect.provide(JobsServiceLive)
      )
    )
  );

export const claimPerson = createServerFn({ method: 'POST' })
  .validator((d: { entityType: string; entityId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    const profile = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(ctx.authorId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    if (!profile) throw new Error('Create a profile first');
    const claimId = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.claimPerson(
          ctx.authorId,
          profile.profile.profile_id,
          data.entityType,
          data.entityId,
          ctx
        )
      ).pipe(Effect.provide(JobsServiceLive))
    );
    return { ok: true as const, claimId };
  });

export const getMyClaims = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await getJobsCtx().catch(() => null);
  if (!ctx) return [];
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.getClaimsForUser(ctx.authorId)).pipe(
      Effect.provide(JobsServiceLive)
    )
  );
});

export const checkClaimByEntity = createServerFn({ method: 'GET' })
  .validator((d: { entityType: string; entityId: string }) => d)
  .handler(async ({ data }) =>
    Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.getClaimByEntity(data.entityType, data.entityId)
      ).pipe(Effect.provide(JobsServiceLive))
    )
  );
