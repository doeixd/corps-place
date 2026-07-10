import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import { Effect } from 'effect';
import {
  ProfileOwnerService,
  ProfileOwnerServiceLive,
  type EntityType,
} from '@/lib/profile-owner/service';
import type { ProfileOverlay } from '@/lib/profile-owner/merge';
import { ATTESTATION_VERSION, ALLOWED_PROFILE_FIELDS } from '@/lib/profile-owner/attestation';
import { requireCapability, requireProfileOwner, ForbiddenError } from '@/lib/authz';
import { rateLimit } from '@/lib/rate-limit';
import { auth } from '@/lib/auth';
import { getContributionsDb } from '@/lib/contributions-db';
// NOTE: `@/rpc` and MediaService are imported LAZILY inside setProfilePhoto's
// handler (below). A module-scope `import { fantasyRuntime } from '@/rpc'` runs
// @/rpc's ManagedRuntime.make(FantasyServicesLive) at module init, dragging the
// entire nine-service fantasy runtime (+ Stripe, web-push, better-auth, libsql)
// into the CLIENT entry on every route that renders a claim panel. Only one
// handler needs it, so keep it out of the module graph.

// Server-fn boundary for staff/judge profile ownership. Effect/ProfileOwnerService
// stay behind these handlers (code-split server-side) so the client bundle imports
// only thin references. NOTE (fantasy-jobs-deploy-bundle-leak): never add a
// module-scope helper that closes over ProfileOwnerServiceLive — inline
// Effect.provide(...) in each handler so client tree-shaking holds.

const MAX_FIELD_BYTES = 200_000; // bound an override payload (Lexical envelope etc.)

// ── Reads ─────────────────────────────────────────────────────────────────

/** Overlay for the read-merge (plan §7). Tiny + usually empty. */
export const getProfileOverlay = createServerFn({ method: 'GET' })
  .validator((data: { entityType: EntityType; entityId: string }) => data)
  .handler(async ({ data }): Promise<NonNullable<ProfileOverlay>> => {
    const overlay = await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.readOverlay(data.entityType, data.entityId)
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    // Is the requester the claim holder? Resolved server-side; the owner's user_id
    // is never sent to the client (only the boolean).
    let amOwner = false;
    if (overlay.claim) {
      const session = await auth.api.getSession({ headers: getWebRequest().headers });
      amOwner = !!session?.user && session.user.id === overlay.claim.user_id;
    }
    return {
      claim: overlay.claim
        ? { status: overlay.claim.status, name_match: overlay.claim.name_match }
        : null,
      overrides: overlay.overrides,
      amOwner,
      aliasOf: overlay.aliasOf,
    };
  });

/** Name-match preview for the claim flow — does the signed-in user's Google name
 *  match this profile? Shown before the attestation step (plan §4). */
export const evaluateProfileNameMatch = createServerFn({ method: 'GET' })
  .validator((data: { entityType: EntityType; entityId: string }) => data)
  .handler(async ({ data }) => {
    const req = getWebRequest();
    const session = await auth.api.getSession({ headers: req.headers });
    const googleName = session?.user?.name ?? '';
    return Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.evaluateNameMatch(data.entityType, data.entityId, googleName)
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
  });

// ── Writes ────────────────────────────────────────────────────────────────

/** Claim a profile. Requires the signed-in user to have actively confirmed the
 *  binding attestation (plan §5). Tiered gate happens in the service. */
export const claimProfile = createServerFn({ method: 'POST' })
  .validator((data: { entityType: EntityType; entityId: string; attested: boolean }) => data)
  .handler(async ({ data }) => {
    if (data.attested !== true) throw new ForbiddenError('claimProfile');
    const req = getWebRequest();
    const actor = await requireCapability(req, 'claimProfile');
    // Guardrail (plan §14, Tiered+): cap claims per user so a spoofed-name sweep
    // can't mass-claim profiles. 5 / hour is well above any honest use.
    if (!rateLimit(`profile-claim:${actor.userId}`, 5, 3_600_000))
      throw new Error('Too many claim attempts — please try again later.');
    const session = await auth.api.getSession({ headers: req.headers });
    const googleName = session?.user?.name ?? null;
    const ip = req.headers.get('x-forwarded-for') ?? null;
    const userAgent = req.headers.get('user-agent') ?? null;
    return Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.claimProfile(
          {
            entityType: data.entityType,
            entityId: data.entityId,
            googleName,
            attestationVersion: ATTESTATION_VERSION,
            ip,
            userAgent,
          },
          { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() }
        )
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
  });

/** Revoke/unclaim. requireProfileOwner allows the owner OR a moderator+. */
export const revokeProfileClaim = createServerFn({ method: 'POST' })
  .validator(
    (data: { claimId: string; entityType: EntityType; entityId: string; reason?: string }) => data
  )
  .handler(async ({ data }) => {
    const db = await getContributionsDb();
    const actor = await requireProfileOwner(db, data.entityType, data.entityId);
    await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.revokeClaim(
          data.claimId,
          { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() },
          data.reason ?? null
        )
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    return { ok: true };
  });

/** Save (or clear, via removed:true) one override field. Owner-gated; field key
 *  allowlisted to the editable scope (plan §6); payload size-bounded. */
export const saveProfileField = createServerFn({ method: 'POST' })
  .validator(
    (data: {
      entityType: EntityType;
      entityId: string;
      fieldKey: string;
      content?: unknown;
      removed?: boolean;
      sourceHash?: string | null;
    }) => data
  )
  .handler(async ({ data }) => {
    if (!(ALLOWED_PROFILE_FIELDS as readonly string[]).includes(data.fieldKey)) {
      throw new ForbiddenError('claimProfile');
    }
    if (!data.removed && JSON.stringify(data.content ?? null).length > MAX_FIELD_BYTES) {
      throw new ForbiddenError('claimProfile');
    }
    const db = await getContributionsDb();
    const actor = await requireProfileOwner(db, data.entityType, data.entityId);
    await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.saveOverride(
          {
            entityType: data.entityType,
            entityId: data.entityId,
            fieldKey: data.fieldKey,
            content: data.content ?? null,
            removed: data.removed,
            sourceHash: data.sourceHash ?? null,
          },
          { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() }
        )
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    return { ok: true };
  });

/** Upload (or clear, when dataBase64 is null) the owner's profile photo. Reuses the
 *  shared MediaService.uploadProfilePhoto (sharp→WebP/EXIF-strip→R2, served via
 *  /api/fantasy-media/$id) then stores the result as the `photo` override. */
export const setProfilePhoto = createServerFn({ method: 'POST' })
  .validator(
    (data: { entityType: EntityType; entityId: string; dataBase64?: string | null }) => data
  )
  .handler(async ({ data }): Promise<{ ok: true; url: string | null }> => {
    const db = await getContributionsDb();
    const actor = await requireProfileOwner(db, data.entityType, data.entityId);
    const ctx = { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() };

    if (data.dataBase64) {
      const dataBase64 = data.dataBase64;
      const [{ fantasyRuntime }, { MediaService }] = await Promise.all([
        import('@/rpc'),
        import('@/lib/fantasy/services/media-service'),
      ]);
      const res = await fantasyRuntime.runPromise(
        Effect.flatMap(MediaService, (s) => s.uploadProfilePhoto({ actor, dataBase64 }))
      );
      await Effect.runPromise(
        Effect.flatMap(ProfileOwnerService, (s) =>
          s.saveOverride(
            {
              entityType: data.entityType,
              entityId: data.entityId,
              fieldKey: 'photo',
              content: { url: res.url, mediaId: res.mediaId },
            },
            ctx
          )
        ).pipe(Effect.provide(ProfileOwnerServiceLive))
      );
      return { ok: true, url: res.url };
    }

    await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.saveOverride(
          { entityType: data.entityType, entityId: data.entityId, fieldKey: 'photo', content: null, removed: true },
          ctx
        )
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    return { ok: true, url: null };
  });

/** Moderation queue (plan §9). Lists claims for the admin console; `manageProfileClaims`. */
export const listProfileClaims = createServerFn({ method: 'GET' })
  .validator((data?: { status?: string }) => data ?? {})
  .handler(async ({ data }) => {
    await requireCapability(getWebRequest(), 'manageProfileClaims');
    return Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) => s.listClaims(data.status)).pipe(
        Effect.provide(ProfileOwnerServiceLive)
      )
    );
  });

/** Approve a pending (weak-match) claim → active; `manageProfileClaims`. */
export const approveProfileClaim = createServerFn({ method: 'POST' })
  .validator((data: { claimId: string }) => data)
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageProfileClaims');
    await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.approveClaim(data.claimId, {
          authorId: actor.userId,
          actorRole: actor.role,
          now: new Date().toISOString(),
        })
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    return { ok: true };
  });

/** Reconcile source divergence across all overrides (plan §11). `manageProfileClaims`.
 *  Safe to run on a schedule or on demand. Returns how many were checked/changed. */
export const reconcileProfileOverrides = createServerFn({ method: 'POST' })
  .handler(async (): Promise<{ checked: number; changed: number }> => {
    const actor = await requireCapability(getWebRequest(), 'manageProfileClaims');
    return Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.reconcile({ authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() })
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
  });

/** Re-point an orphaned claim (+ its overrides) to a new entity_id; `manageProfileClaims`. */
export const repointProfileClaim = createServerFn({ method: 'POST' })
  .validator((data: { claimId: string; newEntityId: string }) => data)
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'manageProfileClaims');
    await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.repointClaim(data.claimId, data.newEntityId, {
          authorId: actor.userId,
          actorRole: actor.role,
          now: new Date().toISOString(),
        })
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    return { ok: true };
  });

/** Owner self-delete / moderator takedown (plan §11b). Revokes the claim + clears
 *  overrides (contributions-side) AND enqueues a VM-worker `suppress_profile` job so
 *  the entity is durably removed from the read-model (a re-scrape can't resurrect it).
 *  Owner-or-moderator via requireProfileOwner. */
export const deleteProfile = createServerFn({ method: 'POST' })
  .validator((data: { entityType: EntityType; entityId: string; reason?: string }) => data)
  .handler(async ({ data }) => {
    // The worker interpolates the id into a shell command, so it must fit the safe
    // whitelist (mirrors admin-jobs SafeArg) before we enqueue.
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(data.entityId)) throw new ForbiddenError('claimProfile');
    const db = await getContributionsDb();
    const actor = await requireProfileOwner(db, data.entityType, data.entityId);
    const ctx = { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() };
    await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.deleteProfile(data.entityType, data.entityId, ctx, data.reason ?? null)
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    // Durable read-model suppression runs off the serving container → VM worker job.
    await db.execute({
      sql: `INSERT INTO admin_jobs (job_id, kind, args_json, status, requested_by, queued_at)
            VALUES (?, 'suppress_profile', ?, 'queued', ?, ?)`,
      args: [
        crypto.randomUUID(),
        JSON.stringify({ type: data.entityType, id: data.entityId }),
        actor.userId,
        ctx.now,
      ],
    });
    return { ok: true as const };
  });

/** Merge two profile pages that are the same person (plan §11a). The user must own
 *  BOTH (active claim) or be a moderator — requireProfileOwner on each. v1 same-type. */
export const mergeProfiles = createServerFn({ method: 'POST' })
  .validator(
    (data: { canonicalType: EntityType; canonicalId: string; mergedType: EntityType; mergedId: string }) => data
  )
  .handler(async ({ data }) => {
    const db = await getContributionsDb();
    await requireProfileOwner(db, data.canonicalType, data.canonicalId);
    const actor = await requireProfileOwner(db, data.mergedType, data.mergedId);
    await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.mergeProfiles(
          { type: data.canonicalType, id: data.canonicalId },
          { type: data.mergedType, id: data.mergedId },
          { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() }
        )
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    return { ok: true as const };
  });

/** Undo a merge (plan §11a). Owner of the canonical (or moderator). */
export const unmergeProfile = createServerFn({ method: 'POST' })
  .validator((data: { canonicalType: EntityType; canonicalId: string; mergedType: EntityType; mergedId: string }) => data)
  .handler(async ({ data }) => {
    const db = await getContributionsDb();
    const actor = await requireProfileOwner(db, data.canonicalType, data.canonicalId);
    await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.unmergeProfiles(
          { type: data.mergedType, id: data.mergedId },
          { authorId: actor.userId, actorRole: actor.role, now: new Date().toISOString() }
        )
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    return { ok: true as const };
  });
