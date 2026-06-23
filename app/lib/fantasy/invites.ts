/**
 * Invite token + slug helpers (Fantasy DCI plan §7, Appendix G).
 *
 * Pure, server-side helpers — the race-safe accept itself lives in the
 * `acceptInvite` server-fn (Appendix G.3), which needs the DB. These are the
 * value generators (high-entropy token, url-safe slug) it relies on.
 */
import { Buffer } from 'node:buffer';

/** Kebab-case a league name, trimmed to a sane length. */
export const kebab = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'league';

/** N random hex chars (N must be even). */
const randomHex = (chars: number): string => {
  const bytes = new Uint8Array(chars / 2);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
};

/** Slug = kebab(name) + '-' + 6 hex (Appendix F.1 createLeague). */
export const makeLeagueSlug = (name: string): string => `${kebab(name)}-${randomHex(6)}`;

/** The invite link secret: 32 random bytes, base64url (Appendix F.1 createInvite). */
export const mintInviteToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
};

/** Default invite lifetime (§4.3). */
export const DEFAULT_INVITE_DAYS = 14;

/** ISO string `days` from `fromIso`. */
export const isoPlusDays = (fromIso: string, days: number): string =>
  new Date(new Date(fromIso).getTime() + days * 86_400_000).toISOString();

/** The site's public origin (no trailing slash), for building absolute links. */
export const siteOrigin = (): string =>
  (process.env.BETTER_AUTH_URL ?? 'http://localhost:5173').replace(/\/+$/, '');

/** Absolute join URL for an invite token. */
export const inviteUrl = (token: string): string => `${siteOrigin()}/fantasy/join/${token}`;
