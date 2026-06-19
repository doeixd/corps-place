// Backfill: re-run the (extended) normalizeCaption over corps_staff_assignments rows
// currently bucketed role_type='other', promoting audio/media/medical/admin (and any
// caption words newly matched, e.g. quads->percussion). Mirrors relational.ts
// normalizeCaption EXACTLY. Dry-run default; --apply writes.
import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.DCI_RELATIONAL_DB_URL ?? "file:dci-relational.db" });
const apply = process.argv.includes("--apply");

function normalizeCaption(title) {
  const t = (title ?? "").toLowerCase();
  if (!t.trim()) return "other";
  if (/\bdrum\s*majors?\b|\bdm\b/.test(t)) return "drum-major";
  if (/\b(brass|horns?|hornline|trumpets?|mellophones?|baritones?|euphoniums?|tubas?|contras?)\b/.test(t)) return "brass";
  if (/\b(percussion|batter\w*|drumline|front\s*ensemble|pit|mallets?|snares?|tenors?|quads?|cymbals?|timpani)\b/.test(t)) return "percussion";
  if (/\b(colou?r\s*guard|guard|weapons?|sab[er]+|rifles?|flags?|winter\s*guard)\b/.test(t)) return "guard";
  if (/\b(visual|drill|marching|movement|choreograph\w*|bodywork)\b/.test(t)) return "visual";
  if (/\b(audio|sound|electronic\w*|synth\w*|sampl\w*)\b/.test(t)) return "audio";
  if (/\b(music|arrang\w*|compos\w*|orchestrat\w*)\b/.test(t)) return "music";
  if (/\bdesign\w*\b|concept|(?:program|show)\s*(?:design|coordinat)/.test(t)) return "design";
  if (/\b(media|videograph\w*|photograph\w*|broadcast|content\s*creat\w*|social\s*media)\b/.test(t)) return "media";
  if (/\b(medical|wellness|athletic\s*train\w*|nurse|\brn\b|\batc\b|\blat\b|physical\s*therap\w*|therapist|sports?\s*med\w*|paramedic|\bemt\b)\b/.test(t)) return "medical";
  if (/\b(treasurer|secretary|registrar|quartermaster|volunteer|chaperone|booster|fundrais\w*|hospitality|logistics|transport\w*|\bdriver\b|seamstress|merchandise|\bintern\b|membership|tour\s*(?:manager|coordinator|assistant|team|director)|staff\s*coordinator|administrative\s*assistant|office\s*(?:manager|coordinator)|chaplain)\b/.test(t)) return "admin";
  if (/\b(directors?|executives?|ceo|president|founders?|managers?|operations?|administrat\w*|board)\b/.test(t)) return "director";
  return "other";
}

const rows = (await db.execute(`SELECT rowid, title FROM corps_staff_assignments WHERE role_type='other'`)).rows;
const counts = {}; let changed = 0;
if (apply) await db.execute("PRAGMA busy_timeout=15000");
for (const r of rows) {
  const nc = normalizeCaption(r.title);
  if (nc !== "other") {
    counts[nc] = (counts[nc] || 0) + 1; changed++;
    if (apply) await db.execute({ sql: "UPDATE corps_staff_assignments SET role_type=? WHERE rowid=?", args: [nc, r.rowid] });
  }
}
console.log(`${apply ? "APPLIED" : "DRY-RUN"}: ${changed}/${rows.length} 'other' rows reclassified ->`, JSON.stringify(counts));
