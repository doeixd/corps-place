/**
 * Admin console server functions (ADMIN_PAGE_PLAN §2, §4, Appendix A).
 *
 * Two enforcement points everywhere: the route loader calls `requireAdmin` (UX gate),
 * and every admin server-fn calls `requireCapability` FIRST (the real gate). Mirrors
 * the `createServerFn` + `getWebRequest` + valibot idiom in `fantasy.ts`.
 *
 * This file is the route-independent foundation for M1 — it adds no routes (so no
 * `routeTree.gen.ts` regeneration). The Overview snapshot here reports only
 * `contributions.db` facts, which the serving container CAN read; relational-DB /
 * read-model freshness, model, and scrape health are VM-fed (§8.1) and added later.
 */
import { createServerFn } from '@tanstack/react-start/client';
import { getWebRequest } from '@tanstack/react-start/server';
import * as v from 'valibot';
import type { Client } from '@libsql/client';
import { getContributionsDb } from '@/lib/contributions-db';
import { can, getActor, requireCapability, type Capability } from '@/lib/authz';

// Admin capabilities the loader gate may be asked to check (validated, never trusted).
const ADMIN_CAPS = [
  'viewAdmin',
  'runJobs',
  'manageUsers',
  'manageFantasyQuiz',
  'manageFantasyLeagues',
  'customerSupport',
  'impersonate',
] as const satisfies readonly Capability[];

const CapInput = v.object({ cap: v.picklist(ADMIN_CAPS) });

/**
 * Loader gate. Returns a discriminated result (never throws for auth) so the route
 * can tell signed-out (→ sign-in prompt) from signed-in-wrong-role (→ notFound, so
 * the console isn't advertised) from authorized. The real security gate is
 * `requireCapability` inside each mutating server-fn — this only shapes the page.
 */
export const requireAdmin = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(CapInput, d))
  .handler(async ({ data }) => {
    const actor = await getActor(getWebRequest());
    if (!actor) return { status: 'signed_out' as const };
    if (!can(actor, data.cap)) return { status: 'forbidden' as const };
    return { status: 'ok' as const, userId: actor.userId, role: actor.role };
  });

// One scalar COUNT(*); returns 0 for a table that doesn't exist yet (forward-safe).
const countRows = async (db: Client, table: string): Promise<number> => {
  try {
    const row = (await db.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0];
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
};

const dbSizeBytes = async (db: Client): Promise<number> => {
  try {
    const pc = Number((await db.execute('PRAGMA page_count')).rows[0]?.page_count ?? 0);
    const ps = Number((await db.execute('PRAGMA page_size')).rows[0]?.page_size ?? 0);
    return pc * ps;
  } catch {
    return 0;
  }
};

/** Overview snapshot (§4) — contributions.db only in this slice. Cap: viewAdmin. */
export const adminStatus = createServerFn({ method: 'GET' }).handler(async () => {
  await requireCapability(getWebRequest(), 'viewAdmin');
  const db = await getContributionsDb();
  const [pages, revisions, media, citations, leagues, members, sizeBytes] = await Promise.all([
    countRows(db, 'show_pages'),
    countRows(db, 'show_revisions'),
    countRows(db, 'show_media'),
    countRows(db, 'show_citations'),
    countRows(db, 'fantasy_leagues'),
    countRows(db, 'fantasy_members'),
    dbSizeBytes(db),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    wiki: { pages, revisions, media, citations },
    fantasy: { leagues, members },
    contributionsDb: { sizeBytes },
    // TODO(§8.1): read-model generation (rm_meta), data-quality (dq_*), scrape
    // freshness, model card, dci-relational.db size — all VM-fed (the serving
    // container has no dci-relational.db). Add once the worker writes a snapshot.
  };
});
