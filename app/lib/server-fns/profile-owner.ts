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
import { auth } from '@/lib/auth';
import { getContributionsDb } from '@/lib/contributions-db';

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
  .handler(async ({ data }): Promise<ProfileOverlay> => {
    const overlay = await Effect.runPromise(
      Effect.flatMap(ProfileOwnerService, (s) =>
        s.readOverlay(data.entityType, data.entityId)
      ).pipe(Effect.provide(ProfileOwnerServiceLive))
    );
    return {
      claim: overlay.claim
        ? { status: overlay.claim.status, name_match: overlay.claim.name_match }
        : null,
      overrides: overlay.overrides,
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
