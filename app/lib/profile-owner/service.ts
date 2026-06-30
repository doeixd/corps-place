import { Context, Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import { ProfileSql, ProfileSqlLive, requireDurableStorage } from './sql';
import { ClaimExists, NotFound } from './errors';
import { nameMatch, type NameMatchTier } from './name-match';
import type { OverlayField, OverrideContent } from './merge';
import { getReadModelClient } from '@/lib/read-model-db';
import { readStaffProfile, readJudgeProfile } from '@sdk/src/readModel/readers';

// ProfileOwnerService (plan §7): the server-side owner of staff/judge profile
// claims + the editable overlay. Reads/writes contributions.db; every claim or
// override write records a profile_revisions row in the SAME transaction (I-6).
// SERVER-ONLY — kept behind createServerFn boundaries so Effect never ships to
// the client bundle.

export type EntityType = 'staff' | 'judge';
const newId = () => randomUUID();

export interface WriteContext {
  authorId: string;
  actorRole: string;
  now: string;
}

export interface ClaimRow {
  claim_id: string;
  user_id: string;
  status: string; // active | pending | revoked
  name_match: string | null;
  name_score: number | null;
  attested_at: string;
  claimed_at: string;
}

const makeProfileOwnerService = Effect.gen(function* () {
  const sql = yield* ProfileSql;

  // Scraped display_name for the entity (read-model). Best-effort: null when the
  // read-model is unavailable (local dev) or the entity is unknown — the name
  // match then degrades to 'weak', which the gate routes to moderator review.
  const resolveDisplayName = Effect.fn('ProfileOwnerService.resolveDisplayName')(function* (
    entityType: EntityType,
    entityId: string
  ) {
    return yield* Effect.promise(async () => {
      try {
        const db = getReadModelClient();
        const p =
          entityType === 'staff'
            ? await readStaffProfile(db, entityId)
            : await readJudgeProfile(db, entityId);
        return p?.display_name ?? null;
      } catch {
        return null;
      }
    });
  });

  // Read the active claim + the editable overlay for an entity. Powers the
  // read-merge (step 3) and the owner/admin UI. Empty for the ~99% unclaimed.
  const readOverlay = Effect.fn('ProfileOwnerService.readOverlay')(function* (
    entityType: EntityType,
    entityId: string
  ) {
    const claims = yield* sql<ClaimRow>`
      SELECT claim_id, user_id, status, name_match, name_score, attested_at, claimed_at
      FROM profile_claims
      WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND status != 'revoked'
      LIMIT 1`;
    const overrides = yield* sql<{ field_key: string; content_json: string; scrape_diverged: number }>`
      SELECT field_key, content_json, scrape_diverged
      FROM profile_overrides
      WHERE entity_type = ${entityType} AND entity_id = ${entityId}`;
    const fields: Record<string, OverlayField> = {};
    for (const o of overrides) {
      let content: OverrideContent = null;
      try {
        content = JSON.parse(o.content_json) as OverrideContent;
      } catch {
        content = o.content_json;
      }
      fields[o.field_key] = { content, diverged: o.scrape_diverged === 1 };
    }
    return { claim: claims[0] ?? null, overrides: fields };
  });

  // Evaluate the Google-name ↔ profile-name match without writing (for the UI
  // preview before the attestation step).
  const evaluateNameMatch = Effect.fn('ProfileOwnerService.evaluateNameMatch')(function* (
    entityType: EntityType,
    entityId: string,
    googleName: string
  ) {
    const matchedName = yield* resolveDisplayName(entityType, entityId);
    const nm = nameMatch(googleName, matchedName ?? '');
    return { ...nm, matchedName };
  });

  const claimProfile = Effect.fn('ProfileOwnerService.claimProfile')(function* (
    input: {
      entityType: EntityType;
      entityId: string;
      googleName: string | null;
      attestationVersion: string;
      ip?: string | null;
      userAgent?: string | null;
    },
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;
    const { entityType, entityId } = input;

    const existing = yield* sql<{ claim_id: string }>`
      SELECT claim_id FROM profile_claims
      WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND status != 'revoked' LIMIT 1`;
    if (existing[0]) return yield* Effect.fail(new ClaimExists({ entityType, entityId }));

    const matchedName = yield* resolveDisplayName(entityType, entityId);
    const nm = nameMatch(input.googleName ?? '', matchedName ?? '');
    // Tiered gate (plan §4): exact/close → live immediately; weak → moderator review.
    const status = nm.match === 'weak' ? 'pending' : 'active';
    const claimId = newId();

    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          INSERT INTO profile_claims
            (claim_id, entity_type, entity_id, user_id, status, google_name, matched_name,
             name_match, name_score, attested_at, attestation_version, attest_ip,
             attest_user_agent, claimed_at)
          VALUES (${claimId}, ${entityType}, ${entityId}, ${ctx.authorId}, ${status},
                  ${input.googleName ?? null}, ${matchedName}, ${nm.match}, ${nm.score},
                  ${ctx.now}, ${input.attestationVersion}, ${input.ip ?? null},
                  ${input.userAgent ?? null}, ${ctx.now})`;
          yield* sql`
          INSERT INTO profile_revisions
            (revision_id, entity_type, entity_id, target_kind, actor_user_id, actor_role, op, after_json, created_at)
          VALUES (${newId()}, ${entityType}, ${entityId}, 'claim', ${ctx.authorId}, ${ctx.actorRole},
                  'claim', ${JSON.stringify({ status, name_match: nm.match, name_score: nm.score })}, ${ctx.now})`;
        })
      )
      // Close the SELECT-then-INSERT race: a concurrent claim trips the partial
      // unique index uq_profile_claims_active → map that to ClaimExists, not a 500.
      .pipe(
        Effect.mapError((e) =>
          /UNIQUE|constraint/i.test(String((e as { message?: string })?.message ?? e))
            ? new ClaimExists({ entityType, entityId })
            : e
        )
      );

    return { claimId, status, nameMatch: nm.match as NameMatchTier, nameScore: nm.score, matchedName };
  });

  const revokeClaim = Effect.fn('ProfileOwnerService.revokeClaim')(function* (
    claimId: string,
    ctx: WriteContext,
    reason?: string | null
  ) {
    yield* requireDurableStorage;
    const rows = yield* sql<{ entity_type: string; entity_id: string; status: string }>`
      SELECT entity_type, entity_id, status FROM profile_claims WHERE claim_id = ${claimId} LIMIT 1`;
    const c = rows[0];
    if (!c) return yield* Effect.fail(new NotFound({ message: 'claim not found' }));

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE profile_claims SET status = 'revoked', revoked_at = ${ctx.now},
            revoked_by = ${ctx.authorId}, revoke_reason = ${reason ?? null} WHERE claim_id = ${claimId}`;
        // Clear this entity's overrides on revoke. Overrides are keyed by
        // (entity_type, entity_id), not by claim — leaving them would let a later
        // claimant (e.g. the real person, after a bad actor is revoked) silently
        // inherit the prior owner's edits. The full edit history is preserved in
        // profile_revisions, so this only resets the live overlay to scraped.
        yield* sql`
          DELETE FROM profile_overrides
          WHERE entity_type = ${c.entity_type} AND entity_id = ${c.entity_id}`;
        yield* sql`
          INSERT INTO profile_revisions
            (revision_id, entity_type, entity_id, target_kind, actor_user_id, actor_role, op, before_json, created_at)
          VALUES (${newId()}, ${c.entity_type}, ${c.entity_id}, 'claim', ${ctx.authorId}, ${ctx.actorRole},
                  'revoke', ${JSON.stringify({ status: c.status, clearedOverrides: true })}, ${ctx.now})`;
      })
    );
  });

  // Upsert one field's override + record a revision, atomically. `removed` writes
  // a {removed:true} payload (op='remove') so a re-scrape can't resurrect the
  // scraped value the owner intentionally cleared (e.g. a photo).
  const saveOverride = Effect.fn('ProfileOwnerService.saveOverride')(function* (
    input: {
      entityType: EntityType;
      entityId: string;
      fieldKey: string;
      content: unknown;
      sourceHash?: string | null;
      removed?: boolean;
    },
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;
    const { entityType, entityId, fieldKey } = input;
    const payload = input.removed ? { removed: true } : input.content;
    const contentJson = JSON.stringify(payload);

    const prev = yield* sql<{ content_json: string }>`
      SELECT content_json FROM profile_overrides
      WHERE entity_type = ${entityType} AND entity_id = ${entityId} AND field_key = ${fieldKey} LIMIT 1`;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO profile_overrides
            (entity_type, entity_id, field_key, content_json, source_hash, scrape_diverged, updated_at, updated_by)
          VALUES (${entityType}, ${entityId}, ${fieldKey}, ${contentJson}, ${input.sourceHash ?? null}, 0,
                  ${ctx.now}, ${ctx.authorId})
          ON CONFLICT(entity_type, entity_id, field_key) DO UPDATE SET
            content_json = excluded.content_json, source_hash = excluded.source_hash,
            scrape_diverged = 0, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;
        yield* sql`
          INSERT INTO profile_revisions
            (revision_id, entity_type, entity_id, target_kind, field_key, actor_user_id, actor_role, op, before_json, after_json, created_at)
          VALUES (${newId()}, ${entityType}, ${entityId}, 'override', ${fieldKey}, ${ctx.authorId}, ${ctx.actorRole},
                  ${input.removed ? 'remove' : 'edit'}, ${prev[0]?.content_json ?? null}, ${contentJson}, ${ctx.now})`;
      })
    );
  });

  // Moderation queue (plan §9): list claims for the admin console. Default to the
  // ones needing attention (pending), or pass a status to filter.
  const listClaims = Effect.fn('ProfileOwnerService.listClaims')(function* (status?: string) {
    return yield* sql<{
      claim_id: string; entity_type: string; entity_id: string; user_id: string; status: string;
      google_name: string | null; matched_name: string | null; name_match: string | null;
      name_score: number | null; claimed_at: string; attested_at: string;
    }>`
      SELECT claim_id, entity_type, entity_id, user_id, status, google_name, matched_name,
             name_match, name_score, claimed_at, attested_at
      FROM profile_claims
      WHERE ${status ? sql`status = ${status}` : sql`status != 'revoked'`}
      ORDER BY (status = 'pending') DESC, claimed_at DESC
      LIMIT 500`;
  });

  // Approve a pending (weak-match) claim → active. Audit-tracked in profile_revisions.
  const approveClaim = Effect.fn('ProfileOwnerService.approveClaim')(function* (
    claimId: string,
    ctx: WriteContext
  ) {
    yield* requireDurableStorage;
    const rows = yield* sql<{ entity_type: string; entity_id: string; status: string }>`
      SELECT entity_type, entity_id, status FROM profile_claims WHERE claim_id = ${claimId} LIMIT 1`;
    const c = rows[0];
    if (!c) return yield* Effect.fail(new NotFound({ message: 'claim not found' }));
    if (c.status !== 'pending')
      return yield* Effect.fail(new NotFound({ message: `claim not pending (is '${c.status}')` }));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE profile_claims SET status = 'active' WHERE claim_id = ${claimId}`;
        yield* sql`
          INSERT INTO profile_revisions
            (revision_id, entity_type, entity_id, target_kind, actor_user_id, actor_role, op, after_json, created_at)
          VALUES (${newId()}, ${c.entity_type}, ${c.entity_id}, 'claim', ${ctx.authorId}, ${ctx.actorRole},
                  'approve', ${JSON.stringify({ status: 'active', from: 'pending' })}, ${ctx.now})`;
      })
    );
  });

  return { readOverlay, evaluateNameMatch, claimProfile, revokeClaim, saveOverride, listClaims, approveClaim };
});

export class ProfileOwnerService extends Context.Service<
  ProfileOwnerService,
  Effect.Success<typeof makeProfileOwnerService>
>()('ProfileOwnerService') {}

export const ProfileOwnerServiceLive = Layer.effect(
  ProfileOwnerService,
  makeProfileOwnerService
).pipe(Layer.provide(ProfileSqlLive));
