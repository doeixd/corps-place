// Deterministic boot-time migration for contributions.db.
//
// Runs in docker-entrypoint.sh BEFORE the server starts, so additive column
// migrations are applied in a dedicated process up front rather than lazily on the
// first request (which proved unreliable — see memory contributions-db-lazy-migration-trap).
// STRICTLY best-effort: any failure logs and exits 0 so the app still boots (the
// app's own ensureColumns remains a fallback). Plain ESM (only @libsql/client +
// the shared column list), runnable under the pruned production node_modules.

import { createClient } from '@libsql/client';
import { applyAddColumns } from './contributions-migrations.mjs';

const url = process.env.CONTRIBUTIONS_DB_URL ?? 'file:/data/contributions.db';

async function main() {
  const db = createClient({ url });
  // Wait for locks instead of failing fast (better-auth shares this file).
  await db.execute('PRAGMA busy_timeout=5000');
  const added = await applyAddColumns(db);
  console.log(`[migrate-contributions] ok — ${added} column(s) added (${url}).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[migrate-contributions] failed (best-effort, continuing boot): ${err?.message ?? err}`);
    process.exit(0);
  });
