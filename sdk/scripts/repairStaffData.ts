#!/usr/bin/env node
// Comprehensive staff data cleanup: deduplicate, merge name variants, recover
// photos/bios from scrape DB + candidates, remove non-person entries, mine bio
// facts, re-emit read-model, and push to R2.
//
// Usage (from sdk/):
//   npx tsx scripts/repairStaffData.ts --apply
//
// Without --apply: dry-run only — reports what it would change.
import { createClient } from "@libsql/client";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const APPLY = process.argv.includes("--apply");
const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const SCRAPE_DB_URL = `file:${resolve(SDK_DIR, "dci-relational-scrape.db")}`;

const db = createClient({ url: DB_URL });
const scrapeDb = createClient({ url: SCRAPE_DB_URL });

const log = (msg: string) => console.log(`[repair] ${msg}`);

async function main() {
  if (APPLY) {
    await db.execute("PRAGMA busy_timeout=15000");
    log("running in APPLY mode");
  } else {
    log("DRY RUN — use --apply to write changes");
  }

  // ── 1. Remove known non-person entries ───────────────────────────────────
  const nonPeople = [
    "american-legion",
    "cape-giving-machine",
    "fundraising-campaigns",
    "standards-committee",
  ];
  for (const pid of nonPeople) {
    const exists = await db.execute({ sql: "SELECT 1 FROM corps_staff WHERE person_id = ?", args: [pid] });
    if (exists.rows.length > 0) {
      log(`removing non-person: ${pid}`);
      if (APPLY) {
        await db.execute({ sql: "DELETE FROM corps_staff_assignments WHERE staff_id IN (SELECT staff_id FROM corps_staff WHERE person_id = ?)", args: [pid] });
        await db.execute({ sql: "DELETE FROM corps_staff WHERE person_id = ?", args: [pid] });
      }
    }
  }

  // ── 2. Merge known duplicate pairs ───────────────────────────────────────
  const merges: [string, string][] = [
    ["elizabeth-ando", "libby-ando"],
    ["happi-yi", "happiness-yi"],
    ["happi-yi-megan-moede-ath", "happiness-yi"],
    ["amanda-steinhaur", "amanda-steinhauer"],
    ["amanda-stevenon", "amanda-marino-stevenson"],
    ["clay-wacholz", "clay-wachholz"],
    ["aaron-christianson-chris-langton", "aaron-christianson"],
  ];
  for (const [from, to] of merges) {
    const fromStaff = await db.execute({ sql: "SELECT staff_id FROM corps_staff WHERE person_id = ?", args: [from] });
    const toStaff = await db.execute({ sql: "SELECT staff_id FROM corps_staff WHERE person_id = ?", args: [to] });
    if (fromStaff.rows.length === 0) continue;
    if (toStaff.rows.length === 0) {
      log(`WARNING: target ${to} missing — skipping merge from ${from}`);
      continue;
    }
    log(`merge: ${from} → ${to}`);
    if (APPLY) {
      await db.execute({ sql: "UPDATE corps_staff_assignments SET staff_id = ? WHERE staff_id = ?", args: [String((toStaff.rows[0] as any).staff_id), String((fromStaff.rows[0] as any).staff_id)] });
      await db.execute({ sql: "DELETE FROM corps_staff WHERE person_id = ?", args: [from] });
    }
  }

  // ── 3. Recover photos + bios from scrape DB ──────────────────────────────
  const recoverScrape = async (field: "photo_url" | "biography") => {
    try {
      const r = await scrapeDb.execute({ sql: `SELECT person_id, ${field} FROM corps_staff WHERE ${field} IS NOT NULL AND ${field} != ''`, args: [] });
      let count = 0;
      for (const row of r.rows as any[]) {
        const exists = await db.execute({ sql: `SELECT 1 FROM corps_staff WHERE person_id = ? AND (${field} IS NULL OR ${field} = '')`, args: [row.person_id] });
        if (exists.rows.length === 0) continue;
        count++;
        if (APPLY) {
          await db.execute({ sql: `UPDATE corps_staff SET ${field} = ? WHERE person_id = ?`, args: [row[field], row.person_id] });
        }
      }
      log(`recover ${field} from scrape DB: ${count} entries`);
    } catch { log(`scrape DB not available — skipping ${field} recovery`); }
  };
  await recoverScrape("photo_url");
  await recoverScrape("biography");

  // ── 4. Recover photos + bios from staff_profile_candidates ───────────────
  for (const kind of ["photo", "bio"] as const) {
    const field = kind === "photo" ? "photo_url" : "biography";
    const r = await db.execute({
      sql: `SELECT DISTINCT spc.person_id, spc.value FROM staff_profile_candidates spc
            JOIN corps_staff cs ON cs.person_id = spc.person_id
            WHERE spc.kind = ? AND spc.value IS NOT NULL AND spc.value != ''
              AND (cs.${field} IS NULL OR cs.${field} = '')
            ORDER BY spc.is_current DESC`, args: [kind],
    });
    const seen = new Set<string>();
    let count = 0;
    for (const row of r.rows as any[]) {
      if (seen.has(row.person_id)) continue;
      seen.add(row.person_id);
      count++;
      if (APPLY) {
        await db.execute({ sql: `UPDATE corps_staff SET ${field} = ? WHERE person_id = ?`, args: [row.value, row.person_id] });
      }
    }
    log(`recover ${field} from candidates: ${count} entries`);
  }

  // ── 5. Fix missing corps entries that have logo files on disk ────────────
  const corpsFixes: { key: string; name: string; division: string; logo: string; city: string }[] = [
    { key: "chien-kuo", name: "Chien Kuo", division: "Open Class", logo: "/corps-logos/chien-kuo.png", city: "Taipei, Taiwan" },
    { key: "north-star", name: "North Star", division: "All Age Class", logo: "/corps-logos/north-star.png", city: "" },
  ];
  for (const c of corpsFixes) {
    const exists = await db.execute({ sql: "SELECT 1 FROM corps WHERE corps_key = ?", args: [c.key] });
    if (exists.rows.length > 0) continue;
    log(`recreate corps: ${c.key}`);
    if (APPLY) {
      await db.execute({
        sql: "INSERT INTO corps (corps_key, name, slug, division_name, corps_logo, display_city, active) VALUES (?, ?, ?, ?, ?, ?, 0)",
        args: [c.key, c.name, c.key, c.division, c.logo, c.city],
      });
    }
    // Link merch store if exists
    if (APPLY) {
      await db.execute({ sql: "UPDATE merch_stores SET corps_key = ?, store_logo = COALESCE(NULLIF(store_logo, ''), ?) WHERE store_id = ?", args: [c.key, c.logo, c.key] });
    }
  }

  // ── 6. Fix event_participants with wrong corps_key (alias mapping) ──────
  const aliasFixes = await db.execute({
    sql: `SELECT ca.alias_key, ca.canonical_name, c.corps_key as canonical_key
          FROM corps_aliases ca
          JOIN corps c ON c.name = ca.canonical_name
          WHERE EXISTS (SELECT 1 FROM event_participants ep WHERE ep.corps_key = ca.alias_key)`,
    args: [],
  });
  for (const row of aliasFixes.rows as any[]) {
    log(`fix event_participants: ${row.alias_key} → ${row.canonical_key}`);
    if (APPLY) {
      await db.execute({ sql: "UPDATE event_participants SET corps_key = ? WHERE corps_key = ?", args: [row.canonical_key, row.alias_key] });
    }
  }

  // ── 7. Run automated merge scripts ───────────────────────────────────────
  const scripts = [
    "mergeNameVariants.ts",
    "mergeNicknames.ts",
    "mergeBySharedPhoto.ts",
    "dedupeAssignments.ts",
  ];
  for (const script of scripts) {
    log(`running ${script}...`);
    try {
      execSync(`npx tsx scripts/${script} --apply`, { cwd: SDK_DIR, stdio: "pipe", timeout: 120_000 });
    } catch (e: any) {
      log(`  ${script} error (continuing): ${e.stderr?.toString().slice(0, 100) ?? e.message}`);
    }
  }

  // ── 8. Mine bio facts ────────────────────────────────────────────────────
  log("running mineBioFacts...");
  try {
    execSync("npx tsx scripts/mineBioFacts.ts --apply", { cwd: SDK_DIR, stdio: "pipe", timeout: 120_000 });
  } catch (e: any) {
    log(`  mineBioFacts error (continuing): ${e.stderr?.toString().slice(0, 100) ?? e.message}`);
  }

  // ── 9. Re-emit read-model + push to R2 ───────────────────────────────────
  log("emitting read-model with JSON snapshot...");
  try {
    execSync("npx tsx scripts/emitReadModel.ts --json-snapshot ../public/read-model", { cwd: SDK_DIR, stdio: "inherit", timeout: 180_000 });
  } catch (e: any) {
    log(`emit error: ${e.stderr?.toString().slice(0, 100) ?? e.message}`);
  }

  log("pushing read-model to R2...");
  try {
    execSync("npx tsx scripts/pushData.ts read-model", { cwd: SDK_DIR, stdio: "inherit", timeout: 120_000 });
  } catch (e: any) {
    log(`push error: ${e.stderr?.toString().slice(0, 100) ?? e.message}`);
  }

  log("done. Rebuild the app and restart the container to pick up changes.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
