/**
 * Site-wide first-sign-in consent (Terms + Privacy acceptance, optional contact
 * opt-in). PURE + isomorphic — imported by both the client ConsentGate and the
 * acceptTerms server-fn, so it must never pull a server-only dependency.
 */

/**
 * Bump when the Terms of Service / Privacy Policy change materially — every user
 * is then re-gated until they accept the new version. Keep it human-readable.
 */
export const CURRENT_TERMS_VERSION = '2026-06-24';

/** The minimal shape of the consent fields better-auth adds to the session user. */
export interface ConsentUser {
  termsAcceptedAt?: string | null;
  termsVersion?: string | null;
  contactConsent?: boolean | null;
}

/** True when a signed-in user still owes acceptance of the current terms. */
export function needsConsent(user: ConsentUser | null | undefined): boolean {
  if (!user) return false; // signed-out users aren't gated
  return !user.termsAcceptedAt || user.termsVersion !== CURRENT_TERMS_VERSION;
}
