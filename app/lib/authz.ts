import { auth } from './auth';

/**
 * Authorization chokepoint for the Show Detail Wiki (plan §6.2/§6.5).
 *
 * Editing is the DEFAULT capability for any authenticated user; roles grant only
 * extra (destructive/structural) powers. This is the single place permission is
 * decided — every write server-fn calls `requireCapability` first. UI gating is
 * cosmetic; the server is the gate.
 */

export type Role = 'user' | 'trusted' | 'moderator' | 'admin';
const RANK: Record<Role, number> = { user: 1, trusted: 2, moderator: 3, admin: 4 };

export type Capability =
  | 'edit' // edit blocks / override rows
  | 'upload' // upload media
  | 'revert' // revert a revision
  | 'lock' // lock/unlock a page
  | 'hideRevision' // hide a revision/media
  | 'orphan' // mark page orphaned / merge
  | 'grantRole' // grant/revoke roles, ban
  | 'deletePage'
  | 'manageFantasyQuiz' // author the fantasy knowledge-quiz bank (Fantasy plan G.4)
  | 'manageFantasyLeagues' // support ops on fantasy leagues (cancel/refund, take-down)
  // Admin console (ADMIN_PAGE_PLAN §2). Operator capabilities on top of the wiki set.
  | 'viewAdmin' // see the /admin console at all
  | 'runJobs' // enqueue SDK jobs (scrape/ingest/predict/fine-tune) for the VM worker
  | 'manageUsers' // list users, grant/revoke role, ban, GDPR delete/export
  | 'customerSupport' // user lookup, support inbox, account recovery
  | 'impersonate'; // "view as user" — high-trust debugging

// Minimum role per capability (the §6.2 matrix). Editing/upload/revert = any user.
const MIN_ROLE: Record<Capability, Role> = {
  edit: 'user',
  upload: 'user',
  revert: 'user',
  lock: 'moderator',
  hideRevision: 'moderator',
  orphan: 'moderator',
  grantRole: 'admin',
  deletePage: 'admin',
  manageFantasyQuiz: 'moderator',
  manageFantasyLeagues: 'admin',
  viewAdmin: 'moderator',
  runJobs: 'admin',
  manageUsers: 'admin',
  customerSupport: 'moderator',
  impersonate: 'admin',
};

export type PageLock = 'none' | 'trusted' | 'mod';
// Editing a locked page requires clearing the lock level (§6.4).
const LOCK_MIN_ROLE: Record<PageLock, Role> = {
  none: 'user',
  trusted: 'trusted',
  mod: 'moderator',
};

export interface Actor {
  userId: string;
  role: Role;
}

/** Pure decision: may `actor` perform `action` (on a page with `lockLevel`)? */
export const can = (
  actor: Actor | null,
  action: Capability,
  ctx?: { lockLevel?: PageLock }
): boolean => {
  if (!actor) return false; // all writes require a session (I-9)
  const rank = RANK[actor.role] ?? 0;
  if (rank < RANK[MIN_ROLE[action]]) return false;
  // A lock raises the bar for the edit-family capabilities only.
  if ((action === 'edit' || action === 'upload') && ctx?.lockLevel) {
    if (rank < RANK[LOCK_MIN_ROLE[ctx.lockLevel]]) return false;
  }
  return true;
};

export class ForbiddenError extends Error {
  readonly _tag = 'ForbiddenError';
  constructor(public readonly action: Capability) {
    super(`Not allowed: ${action}`);
  }
}

/** Resolve the actor from the request session, or null when signed out. */
export const getActor = async (request: Request): Promise<Actor | null> => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  // Defense-in-depth: reject banned users even on an already-valid cookie. The
  // better-auth admin plugin deletes sessions on ban + blocks new sign-ins, but
  // getSession() doesn't re-check the flag — so we do (ADMIN_PAGE_PLAN R3). `banned`
  // is undefined until the admin plugin is enabled, so this is a safe no-op until then.
  if ((session.user as { banned?: boolean | null }).banned) return null;
  return { userId: session.user.id, role: (session.user as { role?: Role }).role ?? 'user' };
};

/** Server-fn guard: throws ForbiddenError unless the actor has the capability. */
export const requireCapability = async (
  request: Request,
  action: Capability,
  ctx?: { lockLevel?: PageLock }
): Promise<Actor> => {
  const actor = await getActor(request);
  if (!can(actor, action, ctx)) throw new ForbiddenError(action);
  return actor!;
};
