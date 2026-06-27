import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import { Effect } from 'effect';
import { getActor, ForbiddenError } from '@/lib/authz';
import { JobsService, JobsServiceLive } from '@/lib/jobs/jobs-service';
import { JOBS_BLOCK_SCHEMAS, isJobsBlockKind } from '@/lib/jobs/schemas';
import { sendEmail } from '@/lib/email';

// Pure (no service closure) — safe at module scope; used only inside handlers.
const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

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
    // Posting a job IS acting as an employer — auto-provision a profile rather than
    // 500'ing with "Only employers can post jobs". Existing profiles can post too.
    const profileId =
      profile?.profile.profile_id ??
      (await Effect.runPromise(
        Effect.flatMap(JobsService, (svc) => svc.createProfile(ctx.authorId, 'employer', ctx)).pipe(
          Effect.provide(JobsServiceLive)
        )
      ));
    const { postingId, slug } = await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.createPosting(profileId, data, ctx)).pipe(
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

// ── Moderation ───────────────────────────────────────────────────────────────

export const reportContent = createServerFn({ method: 'POST' })
  .validator((d: { targetKind: string; targetId: string; reason?: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
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
    return Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.searchTalent(data)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
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

// ── Saved search alerts ──────────────────────────────────────────────────────

export const createJobAlert = createServerFn({ method: 'POST' })
  .validator((d: { kind: string; filtersJson: string; frequency?: string }) => d)
  .handler(async ({ data }) => {
    const ctx = await getJobsCtx();
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

export const parseResumeFile = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ rawText: v.string() }), d))
  .handler(async ({ data }) => {
    try {
      const { parseResume } = await import('resume-parser-ats');
      const result = parseResume({ rawText: data.rawText });
      return { ok: true as const, parsed: result.data };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });

const UploadResumeInput = v.object({
  base64: v.string(),
  fileName: v.string(),
});

export const uploadAndParseResume = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(UploadResumeInput, d))
  .handler(async ({ data }) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
    const filePath = path.join(tmpDir, data.fileName);
    try {
      const buffer = Buffer.from(data.base64, 'base64');
      fs.writeFileSync(filePath, buffer);
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
    await Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.bookmarkJob(ctx.authorId, data.postingId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    );
    return { ok: true as const };
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

export const getPostingApplications = createServerFn({ method: 'GET' })
  .validator((d: { postingId: string }) => d)
  .handler(async ({ data }) =>
    Effect.runPromise(
      Effect.flatMap(JobsService, (svc) => svc.getPostingApplications(data.postingId)).pipe(
        Effect.provide(JobsServiceLive)
      )
    )
  );

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
