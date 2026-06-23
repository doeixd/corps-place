import { createAuthClient } from 'better-auth/react';
import { adminClient } from 'better-auth/client/plugins';

/**
 * Browser auth client (plan §6). Talks to the /api/auth/* handler on the same
 * origin. `useSession` drives the edit affordances (signed-in users see editors;
 * signed-out users see a sign-in CTA). Reads stay public.
 *
 * `adminClient` (ADMIN_PAGE_PLAN §10.2) is included for impersonation/stop —
 * `authClient.admin.impersonateUser`/`stopImpersonating` round-trip the session
 * cookie through the auth route (the correct path; don't hand-roll it server-side).
 * The server admin plugin enforces adminRoles; role grants/bans use our own
 * manageUsers-gated server-fns (extra guard rails + audit).
 */
export const authClient = createAuthClient({ plugins: [adminClient()] });
export const { useSession, signIn, signOut } = authClient;
