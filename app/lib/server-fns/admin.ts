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
import { getContributionsDb, durableStorageStatus } from '@/lib/contributions-db';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import { can, getActor, requireCapability, type Capability } from '@/lib/authz';
import { writeAudit } from '@/lib/admin-audit';
import { CURRENT_TERMS_VERSION } from '@/lib/consent';

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

export interface AuditRow {
  auditId: string;
  actorId: string;
  actorName: string | null;
  actorRole: string;
  action: string;
  target: string | null;
  createdAt: string;
}

const ListAuditInput = v.object({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)), 100),
});

/** Recent admin actions (§8). Cap: viewAdmin. */
export const listAudit = createServerFn({ method: 'GET' })
  .validator((d: unknown) => v.parse(ListAuditInput, d))
  .handler(async ({ data }): Promise<AuditRow[]> => {
    await requireCapability(getWebRequest(), 'viewAdmin');
    const db = await getContributionsDb();
    const rows = (
      await db.execute({
        sql: `SELECT a.audit_id, a.actor_id, u.name AS actor_name, a.actor_role,
                     a.action, a.target, a.created_at
              FROM admin_audit a LEFT JOIN "user" u ON u.id = a.actor_id
              ORDER BY a.created_at DESC LIMIT ?`,
        args: [data.limit],
      })
    ).rows as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      auditId: String(r.audit_id),
      actorId: String(r.actor_id),
      actorName: (r.actor_name as string) ?? null,
      actorRole: String(r.actor_role),
      action: String(r.action),
      target: (r.target as string) ?? null,
      createdAt: String(r.created_at),
    }));
  });

/** System & ops snapshot (§8.1): read-model generation + data-quality (both on the
 *  serving container) + contributions.db size. Scrape freshness lives in
 *  dci-relational.db (not on this container) → VM-fed later. Cap: viewAdmin. */
export const adminSystem = createServerFn({ method: 'GET' }).handler(async () => {
  await requireCapability(getWebRequest(), 'viewAdmin');
  const db = await getContributionsDb();
  const contributionsDbBytes = await dbSizeBytes(db);

  let readModel: {
    enabled: boolean;
    builtAt: string | null;
    schemaVersion: string | null;
    ingestCommit: string | null;
    currentSeason: string | null;
    rowCounts: Record<string, number> | null;
    dqCounts: Record<string, number> | null;
  } = {
    enabled: false,
    builtAt: null,
    schemaVersion: null,
    ingestCommit: null,
    currentSeason: null,
    rowCounts: null,
    dqCounts: null,
  };

  if (readModelEnabled()) {
    try {
      const rm = getReadModelClient();
      const rows = (await rm.execute('SELECT key, value FROM rm_meta')).rows as unknown as {
        key: string;
        value: string;
      }[];
      const meta = new Map(rows.map((r) => [String(r.key), r.value as string]));
      const parse = (s: string | undefined) => {
        if (!s) return null;
        try {
          return JSON.parse(s) as Record<string, number>;
        } catch {
          return null;
        }
      };
      readModel = {
        enabled: true,
        builtAt: meta.get('built_at') ?? null,
        schemaVersion: meta.get('schema_version') ?? null,
        ingestCommit: meta.get('ingest_commit') ?? null,
        currentSeason: meta.get('current_season') ?? null,
        rowCounts: parse(meta.get('row_counts_json')),
        dqCounts: parse(meta.get('dq_counts_json')),
      };
    } catch {
      readModel = { ...readModel, enabled: true };
    }
  }

  // Consent + notification adoption (operator visibility for the first-sign-in
  // gate + the notification matrix). All cheap COUNT/SUM on contributions.db.
  const num = (x: unknown) => Number(x ?? 0);
  const consentRow = (
    await db.execute({
      sql: `SELECT COUNT(*) AS total,
                   SUM(CASE WHEN termsAcceptedAt IS NOT NULL AND termsVersion = ? THEN 1 ELSE 0 END) AS accepted,
                   SUM(CASE WHEN contactConsent = 1 THEN 1 ELSE 0 END) AS opted_in
            FROM "user"`,
      args: [CURRENT_TERMS_VERSION],
    })
  ).rows[0] as { total: unknown; accepted: unknown; opted_in: unknown };
  const memberRow = (
    await db.execute(
      `SELECT COUNT(*) AS total, SUM(notify_email) AS email_on, SUM(notify_push) AS push_on
       FROM fantasy_members WHERE status = 'active'`
    )
  ).rows[0] as { total: unknown; email_on: unknown; push_on: unknown };
  const pendingEmails = num(
    (await db.execute(`SELECT COUNT(*) AS c FROM fantasy_notifications WHERE email_sent_at IS NULL`))
      .rows[0]?.c
  );
  const jobsDue = num(
    (await db.execute(`SELECT COUNT(*) AS c FROM fantasy_scheduled_jobs WHERE done_at IS NULL`))
      .rows[0]?.c
  );
  const pushSubs = await countRows(db, 'fantasy_push_subscriptions');

  return {
    generatedAt: new Date().toISOString(),
    contributionsDbBytes,
    readModel,
    durable: durableStorageStatus(),
    consent: {
      version: CURRENT_TERMS_VERSION,
      totalUsers: num(consentRow?.total),
      accepted: num(consentRow?.accepted),
      optedIn: num(consentRow?.opted_in),
    },
    notifications: {
      activeMembers: num(memberRow?.total),
      emailOn: num(memberRow?.email_on),
      pushOn: num(memberRow?.push_on),
      pendingEmails,
      jobsDue,
      pushSubs,
    },
  };
});

// ---------------------------------------------------------------------------
// announcement banner (§8.2) — public read, admin write, stored in admin_settings
// ---------------------------------------------------------------------------
/** Public: current site announcement (null when none). No cap. */
export const getAnnouncement = createServerFn({ method: 'GET' }).handler(async () => {
  const db = await getContributionsDb();
  const row = (
    await db.execute({ sql: "SELECT value_json FROM admin_settings WHERE key = 'announcement'" })
  ).rows[0] as { value_json?: string } | undefined;
  if (!row?.value_json) return { text: null as string | null };
  try {
    return { text: (JSON.parse(row.value_json) as { text?: string }).text ?? null };
  } catch {
    return { text: null as string | null };
  }
});

/** Set/clear the announcement banner. Cap: runJobs (admin operator action). */
export const setAnnouncement = createServerFn({ method: 'POST' })
  .validator((d: unknown) => v.parse(v.object({ text: v.pipe(v.string(), v.maxLength(280)) }), d))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getWebRequest(), 'runJobs');
    const db = await getContributionsDb();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO admin_settings (key, value_json, updated_by, updated_at)
            VALUES ('announcement', ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
              updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      args: [JSON.stringify({ text: data.text }), actor.userId, now],
    });
    await writeAudit(db, actor, { action: 'set_announcement', after: { text: data.text } });
    return { ok: true as const };
  });

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
