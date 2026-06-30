// Surgical cleanup of the residual junk/edge display names (found via a looksLikePersonName
// sweep — but that function FALSE-rejects real surnames it treats as stopwords: "Hall" (Hall of
// Fame), "Emmy", "Post" — so we do NOT delete on that signal; we hand-pick the real junk).
//   • STRIP "Team " prefix → "Team Joe Roach" → "Joe Roach"
//   • STRIP a leaked byline/credit prefix → "By George Fennell" → "George Fennell"
//     (rename if the remainder is a real person; DELETE if not, e.g. "At Vanguard").
//   • STRIP trailing " The" (leaked "The <Corps>") → "Bear The" → "Bear"
//   • STRIP trailing !/? → "Andrew Duss!" → "Andrew Duss"
//   • DELETE non-person labels: "AZ The Academy", "Follow on Instagram", CTA/locative
//     leads ("At Vanguard", "Visit …"), "Advocacy Connector", …
// Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { archiveStaffDeletion } from "./deletionArchive.js";
import { looksLikePersonName } from "../src/staffScraper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const DRY = !process.argv.includes("--apply");
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}` });

const DELETE_RE = /^([A-Z]{2}\s+The\s+|Recent News$|Follow on\b|Advocacy Connector$|.*\bClick$|Hit Counter$|.* Feature$|(At|In|On|From|Visit|Join|Meet|Watch|Learn|Read|Shop|Donate|Support|See)\s+\S)/;
// A leaked byline/credit prefix ("By …", "Photos by …", "Courtesy of …").
const CREDIT_RE = /^(Words by|Story by|Text by|Photos? by|Video by|Interview (?:by|with)|Presented by|Hosted by|Courtesy of|Written by|Edited by|Produced by|Directed by|Featuring|Feat\.?|By)\s+/i;
const rename = (raw: string): string => {
  let s = raw.trim();
  s = s.replace(/^Team\s+/i, "");           // "Team Joe Roach" → "Joe Roach"
  s = s.replace(/\s+The$/i, "");            // "Bear The" → "Bear"
  s = s.replace(/[!?]+$/, "").trim();       // "Andrew Duss!" → "Andrew Duss"
  return s;
};

const main = async () => {
  if (!DRY) await db.execute("PRAGMA busy_timeout=15000");
  const rows = (await db.execute("SELECT staff_id, display_name FROM corps_staff WHERE display_name IS NOT NULL")).rows as any[];
  const dels: string[] = [], renames: { staff_id: string; from: string; to: string }[] = [];
  for (const r of rows) {
    const name = String(r.display_name);
    if (DELETE_RE.test(name.trim())) { dels.push(r.staff_id); continue; }
    if (CREDIT_RE.test(name.trim())) {
      const rest = name.trim().replace(CREDIT_RE, "").trim();
      if (rest.length >= 3 && looksLikePersonName(rest)) renames.push({ staff_id: r.staff_id, from: name, to: rest });
      else dels.push(r.staff_id); // credit prefix but remainder isn't a person → junk
      continue;
    }
    const to = rename(name);
    if (to !== name && to.length >= 3) renames.push({ staff_id: r.staff_id, from: name, to });
  }
  console.log(`${DRY ? "(dry-run)" : "APPLIED"} — ${renames.length} renames, ${dels.length} deletes\n`);
  console.log("RENAME:"); [...new Map(renames.map((r) => [r.from, r])).values()].slice(0, 20).forEach((r) => console.log(`  "${r.from}" → "${r.to}"`));
  console.log("\nDELETE:"); for (const id of dels.slice(0, 15)) { const n = rows.find((r) => r.staff_id === id)?.display_name; console.log(`  "${n}"`); }
  if (!DRY) {
    for (const r of renames) await db.execute({ sql: "UPDATE corps_staff SET display_name=? WHERE staff_id=?", args: [r.to, r.staff_id] });
    await archiveStaffDeletion(db, dels.map((d) => String(d)), { script: "cleanResidualNames", reason: "residual non-person label" });
    for (let i = 0; i < dels.length; i += 200) { const b = dels.slice(i, i + 200); await db.execute({ sql: `DELETE FROM corps_staff WHERE staff_id IN (${b.map(() => "?").join(",")})`, args: b }); }
    console.log(`\nApplied ${renames.length} renames, ${dels.length} deletes.`);
  }
  process.exit(0);
};
main();
