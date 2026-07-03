// Corps-colors save (CORPS_COLORS_PLAN step 4 / ADMIN_PAGE_PLAN §6.5). The serving
// container has no dci-relational.db, so the durable write can't happen here. Instead
// we (a) patch the live read-model slot for an immediate visual effect, and (b) enqueue
// a `save_corps_colors` job the VM worker runs against the relational source DB. Gated
// by the real role system (was dev-only).

import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { Schema, SchemaParser } from 'effect';
import { normalizeHex } from '@sdk/src/corpsColors.js';
import { getReadModelClient, readModelEnabled } from '@/lib/read-model-db';
import { getContributionsDb } from '@/lib/contributions-db';
import { requireCapability } from '@/lib/authz';
import { writeAudit } from '@/lib/admin-audit';

const SaveInput = Schema.Struct({
  corpsKey: Schema.String.check(Schema.isMinLength(1)),
  primary: Schema.String.check(Schema.isMinLength(1)),
  // Empty string clears the secondary (single-hue corps).
  secondary: Schema.String,
});

export const saveCorpsColors = createServerFn({ method: 'POST' })
  .validator(SchemaParser.decodeUnknownSync(SaveInput))
  .handler(async ({ data }) => {
    const actor = await requireCapability(getRequest(), 'viewAdmin');

    const primary = normalizeHex(data.primary);
    if (!primary) throw new Error(`Invalid primary color: ${data.primary}`);
    const secondary = data.secondary.trim() ? normalizeHex(data.secondary) : null;
    if (data.secondary.trim() && !secondary)
      throw new Error(`Invalid secondary color: ${data.secondary}`);

    // (a) Immediate, best-effort patch of the active read-model slot so the editor +
    // site reflect the change now. Durability comes from the enqueued job below.
    if (readModelEnabled()) {
      try {
        await getReadModelClient().execute({
          sql: `UPDATE rm_corps SET color_primary = ?, color_secondary = ?, color_source = 'manual' WHERE corps_key = ?`,
          args: [primary, secondary, data.corpsKey],
        });
      } catch {
        /* slot patch is best-effort; the enqueued job is the durable write */
      }
    }

    // (b) Durable write via the VM worker (relational DB isn't on this container).
    // Colors are passed as 6 hex chars (no '#') to satisfy the worker arg whitelist.
    const db = await getContributionsDb();
    const now = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO admin_jobs (job_id, kind, args_json, status, requested_by, queued_at)
            VALUES (?, 'save_corps_colors', ?, 'queued', ?, ?)`,
      args: [
        crypto.randomUUID(),
        JSON.stringify({
          corps: data.corpsKey,
          primary: primary.slice(1),
          secondary: secondary ? secondary.slice(1) : 'none',
        }),
        actor.userId,
        now,
      ],
    });
    await writeAudit(db, actor, {
      action: 'save_corps_colors',
      target: data.corpsKey,
      after: { primary, secondary },
    });

    return { corpsKey: data.corpsKey, primary, secondary, color_source: 'manual' as const };
  });
