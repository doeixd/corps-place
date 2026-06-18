import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { LibsqlDialect } from '@libsql/kysely-libsql';
import * as path from 'node:path';

/**
 * Auth for the Show Detail Wiki (plan §6). Three passwordless methods — Google,
 * passkey (WebAuthn), magic link. better-auth's tables live in the SAME
 * contributions.db as the wiki content (one durable store on the /data volume).
 *
 * Reads are public; writes are gated (the editor UI + write server-fns require a
 * session). Every user carries a capability `role` (user|trusted|moderator|admin,
 * §6.2) — additive, not user-settable (`input: false`).
 */

// Same DB the contributions store uses (plan §3.1: /data volume in prod).
const dbUrl =
  process.env.CONTRIBUTIONS_DB_URL ??
  `file:${path.resolve(process.cwd(), 'sdk', 'contributions.db')}`;

const baseURL = process.env.BETTER_AUTH_URL ?? 'http://localhost:5173';
const rpID = (() => {
  try {
    return new URL(baseURL).hostname;
  } catch {
    return 'localhost';
  }
})();

// Magic-link delivery. Uses Resend when RESEND_API_KEY is set; otherwise logs the
// link (dev) so sign-in still works, and warns that email isn't configured (plan
// §6.1 — magic link's one external dependency). Google + passkey work regardless.
const sendMagicLink = async ({ email, url }: { email: string; url: string }) => {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn(
      `[auth] RESEND_API_KEY not set — magic link NOT emailed. Dev link for ${email}:\n  ${url}`
    );
    return;
  }
  const { Resend } = await import('resend');
  const { error } = await new Resend(key).emails.send({
    from: process.env.MAGIC_LINK_FROM ?? 'corps.place <login@drumcorps.app>',
    to: email,
    subject: 'Your corps.place sign-in link',
    html: `<p>Click to sign in:</p><p><a href="${url}">Sign in to corps.place</a></p><p>This link expires shortly. If you didn't request it, ignore this email.</p>`,
  });
  if (error) throw new Error(`Resend send failed: ${JSON.stringify(error)}`);
};

export const auth = betterAuth({
  database: { dialect: new LibsqlDialect({ url: dbUrl }), type: 'sqlite' },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    },
  },
  user: {
    additionalFields: {
      // Capability role (§6.2). Not user-settable; promoted by an admin later (M9).
      role: { type: 'string', required: false, defaultValue: 'user', input: false },
    },
  },
  plugins: [
    magicLink({ sendMagicLink }),
    passkey({ rpID, rpName: 'corps.place', origin: baseURL }),
  ],
});

export type Auth = typeof auth;
