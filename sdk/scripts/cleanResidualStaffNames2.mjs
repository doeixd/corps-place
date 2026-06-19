// Targeted cleanup of residual staff-name junk surfaced 2026-06: fused name+corps
// strings, credential suffixes, "&" multi-person/department rows, single-token
// fragments, and a punctuation-variant dupe. Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? "file:dci-relational.db" });
const apply = process.argv.includes("--apply");
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const get = async (s, a=[]) => (await db.execute({ sql: s, args: a })).rows;
const run = async (s, a=[]) => apply ? db.execute({ sql: s, args: a }) : null;

const renames = [];   // [staff_id, old, new]
const deletes = [];   // [staff_id, name, reason]

const rows = await get(`SELECT staff_id, person_id, display_name,
  length(trim(coalesce(biography,'')))>=40 hasbio, coalesce(photo_url,'')!='' haspho FROM corps_staff`);
for (const r of rows) {
  const n = r.display_name;
  let nn = n;
  // fused "<Name> Conductors <Name>" / "<Name> Guardians Dallas/Ft Worth" → first person
  nn = nn.replace(/\s+(Conductors?|Guardians)\s+.*$/i, "");
  // credential suffix after comma (keep Jr./Sr.)
  nn = nn.replace(/,\s*(DMA|PharmD|MD|PhD|DMD|MM|MFA|Surgical Technologist|Ed\.?D\.?|Esq\.?)\b.*$/i, "");
  // multi-person "A & B" (not "Ethics & Compliance" which we delete) → keep first person
  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+\s+&\s+[A-Z]/.test(nn)) nn = nn.replace(/\s*&.*$/, "");
  // normalize ", Jr." / ", Sr." / ", III" → " Jr."
  nn = nn.replace(/,\s*(Jr|Sr|II|III|IV)\.?$/i, (_, s) => " " + s.replace(/\.$/, "") + ".");
  nn = nn.replace(/\s{2,}/g, " ").trim();

  const isDept = /^(Ethics & Compliance|Co-Music Directors)$/i.test(n);
  const isFragment = !/\s/.test(n) && !r.hasbio && !r.haspho; // single-token, no bio/photo
  if (isDept || isFragment) { deletes.push([r.staff_id, n, isDept ? "department/label" : "single-token fragment"]); continue; }
  if (nn !== n) renames.push([r.staff_id, n, nn]);
}

console.log(`${apply ? "APPLY" : "DRY-RUN"}: ${renames.length} renames, ${deletes.length} deletes`);
console.log("\n-- RENAMES --");
for (const [sid, o, nw] of renames) {
  console.log(`  [${o}] -> [${nw}]`);
  await run("UPDATE corps_staff SET display_name=?, person_id=? WHERE staff_id=?", [nw, slug(nw), sid]);
}
console.log("\n-- DELETES (also remove their assignments) --");
for (const [sid, nm, why] of deletes) {
  console.log(`  [${nm}] (${why})`);
  await run("DELETE FROM corps_staff_assignments WHERE staff_id=?", [sid]);
  await run("DELETE FROM corps_staff WHERE staff_id=?", [sid]);
}
// Merge KJ Stafford -> k-j-stafford
const kj = await get("SELECT staff_id FROM corps_staff WHERE display_name='KJ Stafford'");
if (kj.length) {
  console.log("\n-- MERGE -- KJ Stafford -> person_id k-j-stafford, display 'K.J. Stafford'");
  for (const r of kj) await run("UPDATE corps_staff SET display_name='K.J. Stafford', person_id='k-j-stafford' WHERE staff_id=?", [r.staff_id]);
}
