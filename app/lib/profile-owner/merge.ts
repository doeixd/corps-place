// Pure read-time overlay merge (plan §7, Option A): displayed = override ?? scraped.
// Applied at REQUEST time only (route loaders) — NEVER in the read-model emitter,
// so owner edits never bake into the static shards (invariant I-2). No server/Effect
// imports → unit-testable.
//
// Overrides apply ONLY when there is an ACTIVE claim. A 'pending' claim (weak
// name match, awaiting moderator approval) does not publish edits.

/** Override content shapes the editor writes (text / photo url / removal). A concrete
 *  union — `unknown` breaks TanStack's serializable ServerFn return constraint and a
 *  recursive JSON type trips its deep-instantiation guard (TS2589). */
export type OverrideContent =
  | string
  | { plain: string }
  | { url: string }
  | { removed: true }
  | CollectionOverride
  | null;
export type OverlayField = { content: OverrideContent; diverged: boolean };

// ── Collection overrides (plan §2, Option B) ────────────────────────────────
// An owner's CRUD of a scraped collection (awards / performed / assignments) is
// stored as an operation log keyed by a STABLE per-item identity, so a re-scrape
// still surfaces new items while the owner's add/edit/remove stick. Concrete,
// non-recursive shapes (same TS2589 / serialization constraint as above).
export type AwardItem = { name: string; year: number | null };
export type PerformedItem = { group: string; startYear: number | null; endYear: number | null };
export type AssignmentItem = {
  corps_key: string;
  corps_name: string;
  corps_slug: string | null;
  season: string | null;
  title: string | null;
  role_type: string | null;
  start_year: number | null;
  end_year: number | null;
};
export type CollectionItem = AwardItem | PerformedItem | AssignmentItem;
/** One CRUD op. `edit` carries the FULL replacement item (not a partial) to keep
 *  the union concrete. `key` is the stable identity (see *Key helpers below). */
export type CollectionOp =
  | { op: 'add'; key: string; item: CollectionItem }
  | { op: 'edit'; key: string; item: CollectionItem }
  | { op: 'remove'; key: string };
export type CollectionOverride = { ops: CollectionOp[] };

export type ProfileOverlay = {
  claim: { status: string; name_match: string | null } | null;
  overrides: Record<string, OverlayField>;
  amOwner?: boolean; // is the requesting session the holder of this claim?
  aliasOf?: { type: string; id: string } | null; // §11a: this page is merged into another
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
export type CommonProfile = {
  biography: string | null;
  photo_url: string | null;
  bioFacts: {
    hometown: string | null;
    currentPosition: { title: string; org: string } | null;
    // Editable collections (P1). Optional so a judge profile (no awards) still
    // satisfies the shared surface; treated as [] when absent.
    awards?: readonly AwardItem[];
    performedOther?: readonly PerformedItem[];
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

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

// Stable identity keys — coarse on purpose so a re-scrape that only reformats a
// title/name doesn't orphan the override (the reconciler re-links otherwise).
export const awardKey = (a: AwardItem) => `award:${norm(a.name)}:${a.year ?? ''}`;
export const performedKey = (p: PerformedItem) => `perf:${norm(p.group)}:${p.startYear ?? ''}`;
export const assignmentKey = (a: AssignmentItem) =>
  `asn:${norm(a.corps_key)}:${a.season ?? ''}:${norm(a.role_type)}:${norm(a.title)}`;

const opsOf = (c: OverrideContent): CollectionOp[] =>
  c && typeof c === 'object' && Array.isArray((c as { ops?: unknown }).ops)
    ? (c as CollectionOverride).ops
    : [];

/**
 * Apply a collection override's ops onto the scraped list: displayed = scraped −
 * removed + added ± edited, keyed by `keyOf`. Order: scraped first (in place),
 * then any added items the owner introduced. Pure; no mutation of inputs.
 */
export const applyCollectionOps = <Item>(
  scraped: readonly Item[],
  ops: CollectionOp[],
  keyOf: (i: Item) => string
): Item[] => {
  const map = new Map<string, Item>();
  for (const it of scraped) map.set(keyOf(it), it);
  for (const op of ops) {
    if (op.op === 'remove') map.delete(op.key);
    else map.set(op.key, op.item as unknown as Item); // add | edit (full replacement)
  }
  return [...map.values()];
};

/**
 * The inverse of applyCollectionOps: derive the op log that turns the SCRAPED
 * list into the owner's EDITED list — what the editor persists. A key present in
 * scraped but not edited → remove; a new key → add; a changed item → edit.
 * (A rename that changes the key reads as remove-old + add-new, which is fine.)
 * Round-trips: applyCollectionOps(scraped, diffCollectionOps(scraped, edited)) ≍
 * edited (by key).
 */
export const diffCollectionOps = <Item>(
  scraped: readonly Item[],
  edited: readonly Item[],
  keyOf: (i: Item) => string
): CollectionOp[] => {
  const scrapedByKey = new Map(scraped.map((i) => [keyOf(i), i] as const));
  const editedByKey = new Map(edited.map((i) => [keyOf(i), i] as const));
  const ops: CollectionOp[] = [];
  for (const k of scrapedByKey.keys()) {
    if (!editedByKey.has(k)) ops.push({ op: 'remove', key: k });
  }
  for (const [k, item] of editedByKey) {
    const s = scrapedByKey.get(k);
    if (!s) ops.push({ op: 'add', key: k, item: item as unknown as CollectionItem });
    else if (JSON.stringify(s) !== JSON.stringify(item))
      ops.push({ op: 'edit', key: k, item: item as unknown as CollectionItem });
  }
  return ops;
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
  if (ov.hometown || ov.current_position || ov.awards || ov.performed) {
    const bf = { ...profile.bioFacts };
    if (ov.hometown) {
      bf.hometown = isRemoved(ov.hometown.content)
        ? null
        : asText(ov.hometown.content) ?? bf.hometown;
    }
    if (ov.current_position) {
      if (isRemoved(ov.current_position.content)) {
        bf.currentPosition = null; // honor an explicit removal, like the other fields
      } else {
        const c = ov.current_position.content as { title?: unknown; org?: unknown };
        if (typeof c?.title === 'string' && typeof c?.org === 'string') {
          bf.currentPosition = { title: c.title, org: c.org };
        }
      }
    }
    // Collection overrides (P1): apply the owner's add/edit/remove ops onto the
    // scraped list, keyed by stable identity.
    if (ov.awards) {
      bf.awards = applyCollectionOps(bf.awards ?? [], opsOf(ov.awards.content), awardKey);
    }
    if (ov.performed) {
      bf.performedOther = applyCollectionOps(
        bf.performedOther ?? [],
        opsOf(ov.performed.content),
        performedKey
      );
    }
    patch.bioFacts = bf;
  }

  return { ...profile, ...patch, ownership: ownershipInfo(overlay, true, ov) };
};

/**
 * Staff-only: apply the 'assignments' collection override to the TOP-LEVEL
 * assignments list (StaffAssignment ≍ AssignmentItem). Kept separate from
 * mergeProfileOverlay because judges carry a different, score-derived
 * event/caption record that must NOT be owner-editable (plan §1.3 / P2). Applies
 * only under an ACTIVE claim; otherwise returns the scraped list unchanged.
 */
export const mergeAssignmentsOverlay = (
  scraped: readonly AssignmentItem[],
  overlay: ProfileOverlay
): AssignmentItem[] => {
  if (!overlay?.claim || overlay.claim.status !== 'active') return [...scraped];
  const ov = overlay.overrides.assignments;
  return ov ? applyCollectionOps(scraped, opsOf(ov.content), assignmentKey) : [...scraped];
};

/** Stable, dependency-free hash of a scraped value (djb2 → base36). Same on client
 *  and server so save-time and reconcile-time hashes are comparable. */
export const hashSource = (v: unknown): string => {
  const s = JSON.stringify(v ?? null);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** The SCRAPED value an override of `fieldKey` shadows — used to record source_hash
 *  at save time and to detect later divergence when the source is re-scraped. */
export const scrapedFieldValue = (profile: CommonProfile, fieldKey: string): unknown => {
  switch (fieldKey) {
    case 'biography':
      return profile.biography;
    case 'photo':
      return profile.photo_url;
    case 'hometown':
      return profile.bioFacts.hometown;
    case 'current_position':
      return profile.bioFacts.currentPosition;
    case 'awards':
      return profile.bioFacts.awards ?? [];
    case 'performed':
      return profile.bioFacts.performedOther ?? [];
    default:
      return null;
  }
};
