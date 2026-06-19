#!/usr/bin/env node
// Repair missing/broken corps data: recreate corps entries that were
// accidentally deleted from the DB (logo files and event data remain),
// fix event_participants with wrong corps_key that should resolve via aliases,
// and fix empty slugs.
//
// Usage (from sdk/):
//   npx tsx scripts/repairCorpsData.ts --apply
//
// Without --apply: dry-run only — reports what it would change.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(SDK_DIR, "..");
loadRepoEnv(SDK_DIR);

const APPLY = process.argv.includes("--apply");
const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const db = createClient({ url: DB_URL });

const log = (msg: string) => console.log(`[repair-corps] ${msg}`);

async function main() {
  if (APPLY) {
    await db.execute("PRAGMA busy_timeout=15000");
    log("running in APPLY mode");
  } else {
    log("DRY RUN — use --apply to write changes");
  }

  // ── 1. Fix event_participants with wrong corps_key ───────────────────────
  // The corps_aliases table has alias_key → canonical_name mappings, but
  // no code currently resolves them. We wire through event_participants.
  const aliases = await db.execute({
    sql: `SELECT ca.alias_key, ca.canonical_name,
                 c.corps_key as canonical_key, c.name as resolved_name
          FROM corps_aliases ca
          JOIN corps c ON c.name = ca.canonical_name
          WHERE EXISTS (
            SELECT 1 FROM event_participants ep WHERE ep.corps_key = ca.alias_key
          )
          GROUP BY ca.alias_key`,
    args: [],
  });
  for (const row of aliases.rows as any[]) {
    const count = await db.execute({
      sql: "SELECT COUNT(*) as n FROM event_participants WHERE corps_key = ?",
      args: [row.alias_key],
    });
    log(`fix alias: ${row.alias_key} → ${row.canonical_key} (${(count.rows[0] as any).n} rows)`);
    if (APPLY) {
      await db.execute({
        sql: "UPDATE event_participants SET corps_key = ? WHERE corps_key = ?",
        args: [row.canonical_key, row.alias_key],
      });
    }
  }

  // ── 2. Fix empty slugs ───────────────────────────────────────────────────
  const emptySlugs = await db.execute({
    sql: "SELECT corps_key, name FROM corps WHERE slug IS NULL OR slug = ''",
    args: [],
  });
  for (const row of emptySlugs.rows as any[]) {
    const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    log(`fix slug: ${row.corps_key} → ${slug}`);
    if (APPLY) {
      await db.execute({ sql: "UPDATE corps SET slug = ? WHERE corps_key = ?", args: [slug, row.corps_key] });
    }
  }

  // ── 3. Recreate missing corps that have logo files on disk ───────────────
  const missingCorps = await db.execute({
    sql: `SELECT DISTINCT ep.corps_key, ep.corps_name
          FROM event_participants ep
          WHERE ep.corps_key NOT IN (SELECT corps_key FROM corps)
          UNION
          SELECT DISTINCT m.store_id, m.name
          FROM merch_stores m
          WHERE m.store_id NOT IN (SELECT corps_key FROM corps)`,
    args: [],
  });

  const logosDir = resolve(REPO_ROOT, "public/corps-logos");
  for (const row of missingCorps.rows as any[]) {
    const key = row.corps_key;
    const name = row.corps_name;
    // Try to find a logo file
    let logo = null;
    for (const ext of [".png", ".jpg", ".jpeg"]) {
      if (existsSync(resolve(logosDir, `${key}${ext}`))) {
        logo = `/corps-logos/${key}${ext}`;
        break;
      }
    }
    // Try to find division from event data
    const divResult = await db.execute({
      sql: "SELECT division_name FROM corps WHERE corps_key = ? LIMIT 1", args: [key],
    });
    let division = "Open Class";
    if (divResult.rows.length > 0) division = String((divResult.rows[0] as any).division_name || division);

    log(`recreate corps: ${key} "${name}" ${division} logo=${logo ?? "none"}`);
    if (APPLY) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      await db.execute({
        sql: `INSERT OR IGNORE INTO corps (corps_key, name, slug, division_name, corps_logo, active)
              VALUES (?, ?, ?, ?, ?, 0)`,
        args: [key, name, slug, division, logo],
      });
      // Link merch store
      await db.execute({
        sql: "UPDATE merch_stores SET corps_key = ? WHERE store_id = ?",
        args: [key, key],
      });
      if (logo) {
        await db.execute({
          sql: "UPDATE merch_stores SET store_logo = COALESCE(NULLIF(store_logo, ''), ?) WHERE store_id = ? AND corps_key = ?",
          args: [logo, key, key],
        });
      }
    }
  }

  log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
