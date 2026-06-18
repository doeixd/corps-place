import { createAuthClient } from 'better-auth/react';

/**
 * Browser auth client (plan §6). Talks to the /api/auth/* handler on the same
 * origin. `useSession` drives the edit affordances (signed-in users see editors;
 * signed-out users see a sign-in CTA). Reads stay public.
 */
export const authClient = createAuthClient();
export const { useSession, signIn, signOut } = authClient;
