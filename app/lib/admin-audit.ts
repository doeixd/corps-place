/**
 * Append-only audit for admin-console actions (ADMIN_PAGE_PLAN §8). Every mutating
 * admin server-fn calls `writeAudit` with the acting actor + a before/after snapshot.
 * Lives in `contributions.db` (web-writable). Keep this the single audit sink so
 * `/admin/audit` shows the whole console's activity.
 */
import type { Client } from '@libsql/client';
import type { Actor } from '@/lib/authz';

export interface AuditEntry {
  action: string; // e.g. 'set_page_lock' | 'set_user_role' | 'enqueue_job'
  target?: string | null; // affected entity id/key
  before?: unknown; // prior value (omit for create)
  after?: unknown; // new value
}

export const writeAudit = async (db: Client, actor: Actor, entry: AuditEntry): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO admin_audit
            (audit_id, actor_id, actor_role, action, target, before_json, after_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      actor.userId,
      actor.role,
      entry.action,
      entry.target ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      new Date().toISOString(),
    ],
  });
};
