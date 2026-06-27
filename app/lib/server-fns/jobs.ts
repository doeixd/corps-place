import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { Effect } from 'effect';
import { getActor, ForbiddenError } from '@/lib/authz';
import { rateLimit } from '@/lib/rate-limit';
import { JobsService, JobsServiceLive } from '@/lib/jobs/jobs-service';
import { JOBS_BLOCK_SCHEMAS, isJobsBlockKind } from '@/lib/jobs/schemas';
import { normalizeZip } from '@/lib/jobs/zip';
import { sortByDistance, type LatLng } from '@/lib/geo';
import { sendEmail } from '@/lib/email';

// Pure (no service closure) — safe at module scope; used only inside handlers.
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Pure (no service closure) — anti-abuse throttle. Closes only over the pure
// `rateLimit`, never JobsServiceLive, so client-bundle tree-shaking stays intact.
const limit = (action: string, userId: string, max: number, windowMs: number): void => {
  if (!rateLimit(`jobs:${action}:${userId}`, max, windowMs))
    throw new Error('Too many requests — please slow down and try again in a bit.');
};

// NOTE: do NOT add a module-scope helper that closes over `JobsServiceLive` (or any
// service Live / runtime). Each `.handler()` below inlines `Effect.provide(JobsServiceLive)`
// so the server-fn code-split can strip the whole jobs server chain (node:crypto,
// contributions-db/LibsqlClient, node:fs) from the CLIENT bundle. An unused module-scope
// holder defeats that tree-shaking and blanks the site client-side. See memory
// fantasy-jobs-deploy-bundle-leak.

const getJobsCtx = async () => {
  const actor = await getActor(getWebRequest());
  if (!actor) throw new ForbiddenError('edit');
  return { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() };
};

// Best-effort ZIP → {lat,lng}. Never throws: an unknown/invalid ZIP yields null so
// callers can store the raw ZIP without coordinates rather than failing the write.
const geocodeZip = async (zip: string | null): Promise<LatLng | null> => {
  if (!zip) return null;
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.lookupZip(zip)).pipe(Effect.provide(JobsServiceLive))
  ).catch(() => null);
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
  displayName: v.optional(v.pipe(v.string(), v.maxLength(120)), ''),
  headline: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
  location: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
  zip: v.optional(v.pipe(v.string(), v.maxLength(10)), ''),
  directoryOptOut: v.optional(v.boolean()),
});

export const upsertJobsProfile = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UpsertProfileInput, d))
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    limit('edit', ctx.authorId, 40, 10 * 60_000);

    // Geocode the ZIP best-effort so we can sort/filter by distance later.
    const z = normalizeZip(data.zip);
    const coords = await geocodeZip(z);
    const profileData = {
      displayName: data.displayName,
      headline: data.headline,
      location: data.location,
      zip: z,
      locationLat: coords?.lat ?? null,
      locationLng: coords?.lng ?? null,
      ...(data.directoryOptOut !== undefined ? { directoryOptOut: data.directoryOptOut } : {}),
    };

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
          svc.updateProfile(profileId, profileData, ctx)
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
          svc.updateProfile(profileId, profileData, ctx)
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
    limit('edit', ctx.authorId, 40, 10 * 60_000);

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
      work?: 'remote' | 'onsite';
      sort?: 'newest' | 'nearest' | 'pay';
      nearZip?: string;
      nearLat?: number;
      nearLng?: number;
      offset?: number;
      limit?: number;
    }) => d
  )
  .handler(async ({ data }) => {
    // Filters + non-distance ordering are SQL-side. `work` filters remote/onsite;
    // 'newest'/'pay' sorts map straight to ORDER BY. 'nearest' is resolved here.
    const baseFilters = {
      keyword: data.keyword,
      location: data.location,
      remote: data.remote,
      work: data.work,
      sort: data.sort === 'pay' ? ('pay' as const) : ('newest' as const),
    };

    // Resolve a distance origin: explicit geolocation coords win, else the typed ZIP.
    const origin =
      data.nearLat != null && data.nearLng != null
        ? { lat: data.nearLat, lng: data.nearLng }
        : await geocodeZip(normalizeZip(data.nearZip));

    // Nearest with an origin must sort the WHOLE matching set, not just a page.
    // Fetch the full set (capped), distance-sort, then slice to the requested page.
    if (data.sort === 'nearest' && origin) {
      const full = await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) =>
          svc.listPostings({ ...baseFilters, offset: 0, limit: 1000 })
        ).pipe(Effect.provide(JobsServiceLive))
      );
      const sorted = sortByDistance(full.rows, origin, (r) =>
        r.location_lat != null && r.location_lng != null
          ? { lat: r.location_lat, lng: r.location_lng }
          : null
      ).map(({ item, distanceMiles }) => ({ ...item, distance_miles: distanceMiles }));
      const offset = data.offset ?? 0;
      const limit = data.limit ?? 20;
      return { rows: sorted.slice(offset, offset + limit), total: full.total };
    }

    const result = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.listPostings({ ...baseFilters, offset: data.offset, limit: data.limit })
      ).pipe(Effect.provide(JobsServiceLive))
    );

    // Attach distance_miles to the page when an origin exists; otherwise null.
    if (!origin) {
      return { ...result, rows: result.rows.map((r) => ({ ...r, distance_miles: null })) };
    }
    const sorted = sortByDistance(result.rows, origin, (r) =>
      r.location_lat != null && r.location_lng != null
        ? { lat: r.location_lat, lng: r.location_lng }
        : null
    ).map(({ item, distanceMiles }) => ({ ...item, distance_miles: distanceMiles }));
    return { ...result, rows: sorted };
  });

const CreatePostingInput = v.object({
  title: v.pipe(v.string(), v.minLength(1, 'Title required'), v.maxLength(200)),
  location: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
  zip: v.optional(v.string(), ''),
  remoteOk: v.optional(v.boolean(), false),
  compText: v.optional(v.pipe(v.string(), v.maxLength(500)), ''),
  salaryMin: v.optional(v.nullable(v.number())),
  salaryMax: v.optional(v.nullable(v.number())),
  applyUrl: v.optional(v.pipe(v.string(), v.maxLength(500)), ''),
  applyEmail: v.optional(v.pipe(v.string(), v.maxLength(200)), ''),
  contentJson: v.string(),
  expiresDays: v.optional(v.number()),
});

export const createJobPosting = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreatePostingInput, d))
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    limit('post', ctx.authorId, 6, 60_000);
    limit('post-day', ctx.authorId, 40, 24 * 3600_000);
    const profile = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(ctx.authorId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    // Anti-flood: cap the number of live (non-closed/expired) listings per employer.
    if (profile) {
      const existingPostings = await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) =>
          svc.listPostingsByEmployer(profile.profile.profile_id)
        ).pipe(Effect.provide(JobsServiceLive))
      );
      const active = existingPostings.filter((p) => p.status !== 'closed').length;
      if (active >= 50)
        throw new Error(
          'You have too many active listings. Close or delete some before posting more.'
        );
    }
    // Posting a job IS acting as an employer — auto-provision a profile rather than
    // 500'ing with "Only employers can post jobs". Existing profiles can post too.
    const profileId =
      profile?.profile.profile_id ??
      (await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) => svc.createProfile(ctx.authorId, 'employer', ctx)).pipe(
          Effect.provide(JobsServiceLive)
        )
      ));
    // Geocode the ZIP best-effort for distance sorting (never blocks the post).
    const z = normalizeZip(data.zip);
    const coords = await geocodeZip(z);
    // Auto-hide the listing after N days (default 60). Stored as an absolute timestamp.
    const expiresAt = new Date(Date.now() + (data.expiresDays ?? 60) * 86_400_000).toISOString();
    const postingData = {
      ...data,
      zip: z,
      locationLat: coords?.lat ?? null,
      locationLng: coords?.lng ?? null,
      expiresAt,
    };

    const { postingId, slug } = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.createPosting(profileId, postingData, ctx)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );

    // Fire INSTANT saved-search alerts (best-effort — never block the post).
    const matched = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.fireAlertsForNewPosting(postingId, data.title, data.location ?? null, data.remoteOk ? 1 : 0)
      ).pipe(Effect.provide(JobsServiceLive))
    ).catch(() => [] as { alertId: string; email: string }[]);

    if (matched.length) {
      const titleHtml = escapeHtml(data.title);
      const loc = data.location ? ` — ${escapeHtml(data.location)}` : '';
      await Promise.all(
        matched.map((m) =>
          sendEmail({
            to: m.email,
            subject: `New job matching your alert: ${data.title}`,
            tag: 'jobs-alert',
            html: `<p>A new posting matches your saved job search:</p>
<p><strong>${titleHtml}</strong>${loc}</p>
<p><a href="https://drumcorps.app/jobs/${encodeURIComponent(slug)}">View the posting →</a></p>
<p style="color:#888;font-size:12px">Manage your alerts in your <a href="https://drumcorps.app/jobs/me">profile</a>.</p>`,
          }).catch((e) => console.warn('[jobs] alert email failed:', e))
        )
      );
    }

    return { ok: true as const, postingId };
  });

export const closeJobPosting = createServerFn({ method: 'POST' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    limit('manage', ctx.authorId, 60, 10 * 60_000);
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* JobsService;
        // Ownership guard: the actor's profile must own the posting.
        const profile = yield* svc.getProfileByUser(ctx.authorId);
        const posting = yield* svc.getPostingById(data.postingId);
        if (
          !profile ||
          !posting ||
          posting.employer_profile_id !== profile.profile.profile_id
        ) {
          return yield* Effect.fail(new ForbiddenError('edit'));
        }
        yield* svc.closePosting(data.postingId, ctx);
      }).pipe(Effect.provide(JobsServiceLive))
    );
    return { ok: true as const };
  });

export const deleteJobPosting = createServerFn({ method: 'POST' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    limit('manage', ctx.authorId, 60, 10 * 60_000);
    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* JobsService;
        // Ownership guard: the actor's profile must own the posting.
        const profile = yield* svc.getProfileByUser(ctx.authorId);
        const posting = yield* svc.getPostingById(data.postingId);
        if (
          !profile ||
          !posting ||
          posting.employer_profile_id !== profile.profile.profile_id
        ) {
          return yield* Effect.fail(new ForbiddenError('edit'));
        }
        yield* svc.deletePosting(data.postingId, ctx);
      }).pipe(Effect.provide(JobsServiceLive))
    );
    return { ok: true as const };
  });

const APPLICANT_STATUSES = ['new', 'reviewed', 'shortlisted', 'passed'] as const;
const SetApplicantStatusInput = v.object({
  applicationId: v.string(),
  status: v.picklist(APPLICANT_STATUSES),
});

export const setApplicantStatus = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(SetApplicantStatusInput, d))
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    limit('manage', ctx.authorId, 60, 10 * 60_000);
    const profile = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(ctx.authorId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    if (!profile) throw new ForbiddenError('edit');
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.setApplicationStatus(data.applicationId, data.status, profile.profile.profile_id)
      ).pipe(Effect.provide(JobsServiceLive))
    );

    // Notify the applicant on positive movement only (shortlisted/reviewed) — never
    // for new/passed, to avoid noise and harsh rejection pings. Best-effort: a mail
    // failure must never fail the status mutation.
    if (data.status === 'shortlisted' || data.status === 'reviewed') {
      const info = await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) =>
          svc.getApplicationNotifyInfo(data.applicationId, profile.profile.profile_id)
        ).pipe(Effect.provide(JobsServiceLive))
      ).catch(() => null);
      if (info?.applicant_email) {
        const title = escapeHtml(info.title);
        await sendEmail({
          to: info.applicant_email,
          subject: `Update on your application to "${info.title}"`,
          tag: 'jobs-application-status',
          html: `<p>There's an update on your application to <strong>${title}</strong>.</p>
<p><a href="https://pageantryjobs.com/jobs/me">View your applications →</a></p>`,
        }).catch((e) => console.warn('[jobs] status email failed:', e));
      }
    }

    return { ok: true as const };
  });

const ApplyInput = v.object({
  postingId: v.string(),
  message: v.optional(v.pipe(v.string(), v.maxLength(5000))),
});

export const applyToJob = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(ApplyInput, d))
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('Sign in to apply');
    limit('apply', actor.userId, 12, 60_000);
    const result = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.applyToPosting(data.postingId, actor.userId, data.message)
      ).pipe(Effect.provide(JobsServiceLive))
    );

    // Notify the employer (best-effort — never fail the application on email).
    if (result.notifyOnApply && result.employerEmail) {
      const title = escapeHtml(result.jobTitle);
      await sendEmail({
        to: result.employerEmail,
        subject: `New application for "${result.jobTitle}"`,
        tag: 'jobs-application',
        html: `<p>Hi ${escapeHtml(result.employerName || 'there')},</p>
<p><strong>${escapeHtml(result.applicantName)}</strong> applied to your posting <strong>${title}</strong>.</p>
${data.message ? `<blockquote style="border-left:3px solid #ddd;padding-left:12px;color:#555">${escapeHtml(data.message)}</blockquote>` : ''}
<p><a href="https://drumcorps.app/jobs/me">View your applications →</a></p>`,
      }).catch((e) => console.warn('[jobs] application email failed:', e));
    }

    return { ok: true as const, applicationId: result.applicationId };
  });

export const hasAppliedToJob = createServerFn({ method: 'GET' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    if (!actor) return false;
    return Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.hasApplied(data.postingId, actor.userId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
  });

// ── Moderation ───────────────────────────────────────────────────────────────

export const reportContent = createServerFn({ method: 'POST' })
  .validator((d: { targetKind: string; targetId: string; reason?: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    limit('report', ctx.authorId, 20, 10 * 60_000);
    const flagId = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.reportBad(ctx.authorId, data.targetKind, data.targetId, data.reason)
      ).pipe(Effect.provide(JobsServiceLive))
    );
    return { ok: true as const, flagId };
  });

export const getFlagQueue = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await getJobsCtx();
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.listFlags('open')).pipe(
      Effect.provide(JobsServiceLive)
    )
  );
});

export const getPendingClaims = createServerFn({ method: 'GET' }).handler(async () => {
  await getJobsCtx();
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.listPendingClaims()).pipe(
      Effect.provide(JobsServiceLive)
    )
  );
});

export const dismissFlag = createServerFn({ method: 'POST' })
  .validator((d: { flagId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.dismissFlag(data.flagId, ctx.authorId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    return { ok: true as const };
  });

export const actionFlag = createServerFn({ method: 'POST' })
  .validator((d: { flagId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.actionFlag(data.flagId, ctx.authorId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    return { ok: true as const };
  });

// ── Talent search (employer-only) ────────────────────────────────────────────

export const searchTalent = createServerFn({ method: 'GET' })
  .validator(
    (d: {
      keyword?: string;
      location?: string;
      skills?: string[];
      sort?: 'newest' | 'nearest';
      nearZip?: string;
      nearLat?: number;
      nearLng?: number;
      offset?: number;
      limit?: number;
    }) => d
  )
  .handler(async ({ data }) => {
    // Runs in the route loader, which executes for signed-out visitors too — return
    // empty (no data leak) instead of throwing, so the page can render its sign-in
    // gate rather than a 500.
    const actor = await getActor(getWebRequest());
    if (!actor) return { rows: [], total: 0 };

    const baseFilters = {
      keyword: data.keyword,
      location: data.location,
      skills: data.skills,
      sort: 'newest' as const,
    };

    // Resolve a distance origin: explicit geolocation coords win, else the typed ZIP.
    const origin =
      data.nearLat != null && data.nearLng != null
        ? { lat: data.nearLat, lng: data.nearLng }
        : await geocodeZip(normalizeZip(data.nearZip));

    // Nearest with an origin sorts the WHOLE matching set, then slices the page.
    if (data.sort === 'nearest' && origin) {
      const full = await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) =>
          svc.searchTalent({ ...baseFilters, offset: 0, limit: 1000 })
        ).pipe(Effect.provide(JobsServiceLive))
      );
      const sorted = sortByDistance(full.rows, origin, (r) =>
        r.location_lat != null && r.location_lng != null
          ? { lat: r.location_lat, lng: r.location_lng }
          : null
      ).map(({ item, distanceMiles }) => ({ ...item, distance_miles: distanceMiles }));
      const offset = data.offset ?? 0;
      const limit = data.limit ?? 20;
      return { rows: sorted.slice(offset, offset + limit), total: full.total };
    }

    const result = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.searchTalent({ ...baseFilters, offset: data.offset, limit: data.limit })
      ).pipe(Effect.provide(JobsServiceLive))
    );

    if (!origin) {
      return { ...result, rows: result.rows.map((r) => ({ ...r, distance_miles: null })) };
    }
    const sorted = sortByDistance(result.rows, origin, (r) =>
      r.location_lat != null && r.location_lng != null
        ? { lat: r.location_lat, lng: r.location_lng }
        : null
    ).map(({ item, distanceMiles }) => ({ ...item, distance_miles: distanceMiles }));
    return { ...result, rows: sorted };
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
    limit('claim', ctx.authorId, 10, 10 * 60_000);
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

// ── Saved search alerts ──────────────────────────────────────────────────────

const CreateAlertInput = v.object({
  kind: v.string(),
  filtersJson: v.pipe(v.string(), v.maxLength(4000)),
  frequency: v.optional(v.string()),
});

export const createJobAlert = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(CreateAlertInput, d))
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    limit('alert', ctx.authorId, 20, 10 * 60_000);
    const alertId = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.createAlert(ctx.authorId, data.kind, data.filtersJson, data.frequency ?? 'daily')
      ).pipe(Effect.provide(JobsServiceLive))
    );
    return { ok: true as const, alertId };
  });

export const listMyAlerts = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await getJobsCtx();
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.listAlerts(ctx.authorId)).pipe(
      Effect.provide(JobsServiceLive)
    )
  );
});

// ── Payments / Boosting ──────────────────────────────────────────────────────

export const createBoostCheckout = createServerFn({ method: 'POST' })
  .validator((d: { postingId: string; slug: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    const { createBoostCheckoutSession } = await import('@/lib/jobs/payments');
    const orderId = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.createBoostOrder(ctx.authorId, data.postingId, ctx)
      ).pipe(Effect.provide(JobsServiceLive))
    );
    const { url } = await createBoostCheckoutSession({
      postingId: data.postingId,
      slug: data.slug,
    });
    return { ok: true as const, url, orderId };
  });

// ── Resume parsing (M6) ─────────────────────────────────────────────────────

const UploadResumeInput = v.object({
  base64: v.string(),
  fileName: v.string(),
});

export const uploadAndParseResume = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UploadResumeInput, d))
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    if (!actor) throw new Error('Sign in to upload a résumé');
    limit('resume', actor.userId, 10, 10 * 60_000);
    // DoS guard: reject empty / oversized uploads before touching disk.
    const buf = Buffer.from(data.base64, 'base64');
    if (buf.length === 0 || buf.length > 8 * 1024 * 1024)
      throw new Error('Résumé must be a non-empty file under 8 MB.');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    const filePath = path.join(tmpDir, data.fileName);
    try {
      fs.writeFileSync(filePath, buf);
      const { parseResume } = await import('resume-parser-ats');
      const result = parseResume({ filePath });
      return { ok: true as const, parsed: result.data };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

// ── Bookmarks ────────────────────────────────────────────────────────────────

export const bookmarkJob = createServerFn({ method: 'POST' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    limit('bookmark', ctx.authorId, 60, 10 * 60_000);
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.bookmarkJob(ctx.authorId, data.postingId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    return { ok: true as const };
  });

export const isJobBookmarked = createServerFn({ method: 'GET' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    if (!actor) return false;
    return Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.isBookmarked(actor.userId, data.postingId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
  });

export const removeBookmark = createServerFn({ method: 'POST' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.removeBookmark(ctx.authorId, data.postingId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    return { ok: true as const };
  });

export const getMyBookmarks = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await getJobsCtx();
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.getMyBookmarks(ctx.authorId)).pipe(
      Effect.provide(JobsServiceLive)
    )
  );
});

// ── Application tracking ─────────────────────────────────────────────────────

export const getMyApplications = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await getJobsCtx();
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.getMyApplications(ctx.authorId)).pipe(
      Effect.provide(JobsServiceLive)
    )
  );
});

export const getMyPostings = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await getJobsCtx();
  const profile = await Effect.runPromise(
    Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(ctx.authorId)).pipe(
      Effect.provide(JobsServiceLive)
    )
  );
  if (!profile) return [];
  return Effect.runPromise(
    Effect.flatMap(JobsService, (svc) =>
      svc.listPostingsByEmployer(profile.profile.profile_id)
    ).pipe(Effect.provide(JobsServiceLive))
  );
});

export const getPostingApplicants = createServerFn({ method: 'GET' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
    const profile = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getProfileByUser(ctx.authorId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    if (!profile) return [];
    return Effect.runPromise(
      Effect.flatMap(JobsService, (svc) =>
        svc.getApplicantsForPosting(data.postingId, profile.profile.profile_id)
      ).pipe(Effect.provide(JobsServiceLive))
    );
  });

export const deleteJobAlert = createServerFn({ method: 'POST' })
  .validator((d: { alertId: string }) => d)
  .handler(async ({ data }) => {
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.deleteAlert(data.alertId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    return { ok: true as const };
  });
