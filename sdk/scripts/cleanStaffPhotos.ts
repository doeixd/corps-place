// Photo + filename-name cleanup (data-quality).
//   1. CLEAR placeholder/template photos: a headshot belongs to ONE person (or 2 = a name-variant
//      dupe), so a photo_url shared across ≥3 distinct people is a template/logo/sponsor image,
//      not a headshot. Also clear obvious junk filenames (demo, preloader, placeholder, /plugins/).
//   2. STRIP an image extension that leaked into a display name ("Erik Nordstrom.heic" →
//      "Erik Nordstrom") — the extractor used the image filename as the name.
// Dry-run default; --apply writes. Run mergeNameVariants.ts afterward (de-extensioned names merge).
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const JUNK_PHOTO = /demo\.|preloader|placeholder|\/plugins\/|optimizer_pro|_transparent|sabers_transparent|\/logo|blank\.|spacer\./i;
const EXT_NAME = /\.(heic|jpe?g|png|webp|gif|tiff?|avif)$/i;

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  // Photos shared by ≥3 distinct people → placeholder/logo.
  const shared = new Set<string>();
  for (const r of (await db.execute("SELECT photo_url FROM corps_staff WHERE photo_url IS NOT NULL AND photo_url!='' GROUP BY photo_url HAVING count(distinct person_id)>=3")).rows as any[]) shared.add(String(r.photo_url));

  const rows = (await db.execute("SELECT staff_id, display_name, photo_url FROM corps_staff WHERE photo_url IS NOT NULL AND photo_url!=''")).rows as any[];
  const clearPhoto = rows.filter((r) => shared.has(String(r.photo_url)) || JUNK_PHOTO.test(String(r.photo_url)));

  const nameRows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name IS NOT NULL")).rows as any[];
  const fixName = nameRows.filter((r) => EXT_NAME.test(String(r.display_name).trim())).map((r) => ({ staff_id: r.staff_id, from: String(r.display_name), to: String(r.display_name).trim().replace(EXT_NAME, "").replace(/[_\s]+$/, "").trim() }));

  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — clear ${clearPhoto.length} placeholder photos, fix ${fixName.length} filename-names\n`);
  console.log("CLEAR PHOTO (sample):"); [...new Set(clearPhoto.map((r) => r.photo_url))].slice(0, 8).forEach((u) => console.log(`  ${String(u).slice(-55)}`));
  console.log("\nFIX NAME:"); fixName.slice(0, 10).forEach((r) => console.log(`  "${r.from}" → "${r.to}"`));
  if (!DRY) {
    for (const r of clearPhoto) await db.execute({ sql: "UPDATE corps_staff SET photo_url=NULL WHERE staff_id=?", args: [r.staff_id] });
    for (const r of fixName) if (r.to.length >= 3) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [r.to, r.staff_id] });
    console.log(`\nApplied: ${clearPhoto.length} photos cleared, ${fixName.length} names fixed.`);
  }
  process.exit(0);
};
main();
