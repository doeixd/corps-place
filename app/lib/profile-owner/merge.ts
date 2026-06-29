// Pure read-time overlay merge (plan §7, Option A): displayed = override ?? scraped.
// Applied at REQUEST time only (route loaders) — NEVER in the read-model emitter,
// so owner edits never bake into the static shards (invariant I-2). No server/Effect
// imports → unit-testable.
//
// Overrides apply ONLY when there is an ACTIVE claim. A 'pending' claim (weak
// name match, awaiting moderator approval) does not publish edits.

export type OverlayField = { content: unknown; diverged: boolean };

export type ProfileOverlay = {
  claim: { status: string; name_match: string | null } | null;
  overrides: Record<string, OverlayField>;
  amOwner?: boolean; // is the requesting session the holder of this claim?
} | null;

export type OwnershipInfo = {
  claimed: boolean; // an active claim exists
  pending: boolean; // a claim exists but awaits moderator approval
  verified: boolean; // name match was exact/close
  mine: boolean; // the current viewer holds this claim (drives the edit affordance)
  edited: string[]; // override field_keys applied
  diverged: string[]; // fields whose scraped source changed under the override
};

/** Common profile surface both StaffProfile and JudgeProfile expose. */
type CommonProfile = {
  biography: string | null;
  photo_url: string | null;
  bioFacts: {
    hometown: string | null;
    currentPosition: { title: string; org: string } | null;
  };
};

const isRemoved = (c: unknown): boolean =>
  typeof c === 'object' && c !== null && (c as { removed?: unknown }).removed === true;

const asText = (c: unknown): string | null => {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof (c as { plain?: unknown }).plain === 'string')
    return (c as { plain: string }).plain;
  return null;
};

const asUrl = (c: unknown): string | null => {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof (c as { url?: unknown }).url === 'string')
    return (c as { url: string }).url;
  return null;
};

const ownershipInfo = (
  overlay: NonNullable<ProfileOverlay>,
  live: boolean,
  overrides: Record<string, OverlayField>
): OwnershipInfo => ({
  claimed: live,
  pending: overlay.claim?.status === 'pending',
  verified:
    !!overlay.claim &&
    (overlay.claim.name_match === 'exact' || overlay.claim.name_match === 'close'),
  mine: overlay.amOwner === true,
  edited: live ? Object.keys(overrides) : [],
  diverged: live
    ? Object.entries(overrides)
        .filter(([, v]) => v.diverged)
        .map(([k]) => k)
    : [],
});

/**
 * Merge a scraped profile with its contributions overlay. Returns a NEW object
 * (no mutation) of the same type plus an optional `ownership` block. When there's
 * no overlay/claim, returns the profile unchanged.
 */
export const mergeProfileOverlay = <T extends CommonProfile>(
  profile: T,
  overlay: ProfileOverlay
): T & { ownership?: OwnershipInfo } => {
  if (!overlay || !overlay.claim) return profile;

  const live = overlay.claim.status === 'active';
  if (!live) {
    // Claim exists but not active (pending) — surface ownership, apply no edits.
    return { ...profile, ownership: ownershipInfo(overlay, false, {}) };
  }

  // Build a patch then spread once (avoids per-property writes on the generic T).
  const ov = overlay.overrides;
  const patch: Partial<CommonProfile> = {};

  if (ov.biography) {
    patch.biography = isRemoved(ov.biography.content)
      ? null
      : asText(ov.biography.content) ?? profile.biography;
  }
  if (ov.photo) {
    patch.photo_url = isRemoved(ov.photo.content)
      ? null
      : asUrl(ov.photo.content) ?? profile.photo_url;
  }
  if (ov.hometown || ov.current_position) {
    const bf = { ...profile.bioFacts };
    if (ov.hometown) {
      bf.hometown = isRemoved(ov.hometown.content)
        ? null
        : asText(ov.hometown.content) ?? bf.hometown;
    }
    if (ov.current_position && !isRemoved(ov.current_position.content)) {
      const c = ov.current_position.content as { title?: unknown; org?: unknown };
      if (typeof c?.title === 'string' && typeof c?.org === 'string') {
        bf.currentPosition = { title: c.title, org: c.org };
      }
    }
    patch.bioFacts = bf;
  }

  return { ...profile, ...patch, ownership: ownershipInfo(overlay, true, ov) };
};
