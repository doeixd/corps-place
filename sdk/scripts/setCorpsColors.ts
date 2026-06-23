// Durable corps-colors write (ADMIN_PAGE_PLAN §6.5). Run BY THE VM WORKER where
// dci-relational.db exists — the serving container can't write the relational DB, so
// the /admin colors editor patches the read-model live (immediate) and enqueues this
// for the durable write. Mirrors the old in-app saveCorpsColors relational write.
//
// Usage: npx tsx scripts/setCorpsColors.ts --corps <corps_key> --primary <RRGGBB>
//        [--secondary <RRGGBB|none>]
import { createClient } from '@libsql/client';
import * as path from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const corpsKey = flag('--corps');
const primaryRaw = flag('--primary');
const secondaryRaw = flag('--secondary') ?? 'none';

if (!corpsKey || !primaryRaw) {
  console.error('setCorpsColors: --corps and --primary are required');
  process.exit(2);
}

// Args arrive as 6 hex chars (no '#', per the worker's safe-arg whitelist).
const normHex = (s: string): string | null => {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
};

const primary = normHex(primaryRaw);
if (!primary) {
  console.error(`setCorpsColors: invalid --primary: ${primaryRaw}`);
  process.exit(2);
}
const secondary = secondaryRaw === 'none' ? null : normHex(secondaryRaw);
if (secondaryRaw !== 'none' && !secondary) {
  console.error(`setCorpsColors: invalid --secondary: ${secondaryRaw}`);
  process.exit(2);
}

const dbUrl =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${path.resolve(process.cwd(), 'dci-relational.db')}`;

const main = async () => {
  const db = createClient({ url: dbUrl });
  await db.execute({
    sql: `UPDATE corps SET color_primary = ?, color_secondary = ?, color_source = 'manual' WHERE corps_key = ?`,
    args: [primary, secondary, corpsKey],
  });
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS corps_curated_fields (
            corps_key TEXT NOT NULL, field TEXT NOT NULL, source TEXT, set_at TEXT NOT NULL,
            PRIMARY KEY (corps_key, field))`,
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO corps_curated_fields (corps_key, field, source, set_at)
          VALUES (?, 'colors', 'color-editor', ?)
          ON CONFLICT(corps_key, field) DO UPDATE SET source = excluded.source, set_at = excluded.set_at`,
    args: [corpsKey, new Date().toISOString()],
  });
  console.log(`setCorpsColors: ${corpsKey} → ${primary}${secondary ? ` / ${secondary}` : ''}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
