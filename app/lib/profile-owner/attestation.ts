// Shared attestation version + copy for profile claims (plan §5). Recorded
// per-claim in profile_claims.attestation_version. Bump ATTESTATION_VERSION when
// the wording changes; keep it aligned with the live Terms of Service (§13).
// Pure constants — imported by both the claim dialog (client) and the server-fn.
//
// Deliberately NOT "under penalty of perjury" — a claim is a binding contractual
// representation, not a sworn legal declaration. The consequences named here are
// the ones we can actually assert.

export const ATTESTATION_VERSION = '2026-06-29';

export const ATTESTATION_COPY =
  'By continuing, you represent and affirm that you are the individual represented on this profile, or that you are authorized to manage it. This is a legally binding agreement under our Terms of Service. Knowingly claiming a profile that is not yours, or providing false information, is a serious violation that may result in permanent loss of access and can expose you to civil or criminal liability for fraud or impersonation.';

/** Override fields an owner may edit (plan §6 default scope: bio + facts + photo;
 *  scraped competitive record stays authoritative). */
export const ALLOWED_PROFILE_FIELDS = [
  'display_name',
  'biography',
  'photo',
  'hometown',
  'current_position',
  'links',
  // Editable collections (op-log content: { ops: CollectionOp[] }) — P1/P2.
  'awards',
  'performed',
  'assignments',
] as const;
export type ProfileField = (typeof ALLOWED_PROFILE_FIELDS)[number];
