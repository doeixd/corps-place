// Merge duplicate corps_keys so a corps stops appearing twice in score/ranking/
// event tables. A corps can end up with two corps_keys in corps_scores — a
// Salesforce-style/orphan key (e.g. "0010a...", "001j...", "0") and a slug key
// (e.g. "bushwackers-drum-corps"). See docs/corps-key-merge.md for the full writeup.
//
// Canonical = the key whose `corps` row has a non-empty slug (tiebreak: status
// 'Active', then most corps_scores rows). The other key(s) are orphans, merged in.
//
// SAFETY: a corps is only merged when its shared-event score rows are EXACT
// duplicates (same division/round/total) — otherwise it's skipped and reported,
// so a merge never deletes real, differing data.
//
// Per table: collision-delete on competition_slug (else season), then remap the
// rest; singleton tables (no competition/season) delete the orphan if a canonical
// row exists, else remap.
//
// Usage:  vp exec tsx scripts/mergeDuplicateCorpsKeys.ts            # dry run
//         vp exec tsx scripts/mergeDuplicateCorpsKeys.ts --apply    # execute
import Database from "better-sqlite3";

const apply = process.argv.includes("--apply");
const db = new Database("dci-relational.db");

const tablesWithCorpsKey = (
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
)
  .map((r) => r.name)
  .filter((t) => db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name='corps_key'`).get());

const collisionCol = (t: string): string | null => {
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map(
    (r) => r.name
  );
  if (cols.includes("competition_slug")) return "competition_slug";
  if (cols.includes("season")) return "season";
  return null;
};

const meta = (key: string) =>
  db.prepare("SELECT slug, status FROM corps WHERE corps_key=?").get(key) as
    | { slug: string | null; status: string | null }
    | undefined;
const scoreCount = (key: string) =>
  (db.prepare("SELECT COUNT(*) c FROM corps_scores WHERE corps_key=?").get(key) as { c: number }).c;

// A Salesforce-style record id ("0010a00001...", "001j0000...") or the junk "0"
// placeholder — never the human-facing canonical when a real slug key exists.
const isIdStyle = (k: string) => k === "0" || (/^0/.test(k) && /^[0-9a-z]{14,20}$/i.test(k));

const chooseCanonical = (keys: string[]): { canonical: string | null; reason: string } => {
  const withSlug = keys.filter((k) => (meta(k)?.slug ?? "").trim() !== "");
  let cands = withSlug.length ? withSlug : keys;
  if (cands.length > 1) {
    const active = cands.filter((k) => (meta(k)?.status ?? "") === "Active");
    if (active.length) cands = active;
  }
  if (cands.length === 1) return { canonical: cands[0], reason: withSlug.length ? "slug" : "active" };
  // Prefer a real slug key over a Salesforce-id / "0" key.
  const slugStyle = cands.filter((k) => !isIdStyle(k));
  if (slugStyle.length === 1) return { canonical: slugStyle[0], reason: "slug-style" };
  if (slugStyle.length > 1) cands = slugStyle;
  // Prefer the slug WITHOUT a "the-" prefix ("concord-voices-blue-devils" over
  // "the-concord-voices-blue-devils") when that's the only difference.
  const noThe = cands.filter((k) => !/^the-/.test(k));
  if (noThe.length === 1) return { canonical: noThe[0], reason: "no-the-prefix" };
  cands.sort((a, b) => scoreCount(b) - scoreCount(a));
  if (scoreCount(cands[0]) === scoreCount(cands[1])) return { canonical: null, reason: "ambiguous" };
  return { canonical: cands[0], reason: "score-count" };
};

// Returns the count of orphan corps_scores rows in a SHARED competition whose
// (division_name, round, total_score) does NOT match a canonical row — i.e. real
// differing data we must not delete. >0 ⇒ unsafe to merge automatically.
const unsafeRows = (orphan: string, canonical: string): number =>
  (
    db
      .prepare(
        `SELECT COUNT(*) c FROM corps_scores o
         WHERE o.corps_key=?
           AND o.competition_slug IN (SELECT competition_slug FROM corps_scores WHERE corps_key=?)
           AND NOT EXISTS (
             SELECT 1 FROM corps_scores c
             WHERE c.corps_key=? AND c.competition_slug=o.competition_slug
               AND IFNULL(c.division_name,'')=IFNULL(o.division_name,'')
               AND IFNULL(c.total_score,-1)=IFNULL(o.total_score,-1))`
      )
      .get(orphan, canonical, canonical) as { c: number }
  ).c;

const dupCorps = db
  .prepare(
    `SELECT corps_name FROM corps_scores GROUP BY corps_name HAVING COUNT(DISTINCT corps_key) > 1`
  )
  .all() as { corps_name: string }[];

let totalDel = 0;
let totalRemap = 0;
const skipped: string[] = [];
const merged: string[] = [];

const run = db.transaction(() => {
  for (const { corps_name } of dupCorps) {
    const keys = (
      db.prepare("SELECT DISTINCT corps_key FROM corps_scores WHERE corps_name=?").all(corps_name) as {
        corps_key: string;
      }[]
    ).map((r) => r.corps_key);
    const { canonical, reason } = chooseCanonical(keys);
    if (!canonical) {
      skipped.push(`${corps_name} — ambiguous canonical (${keys.join(", ")})`);
      continue;
    }
    const orphans = keys.filter((k) => k !== canonical);
    const unsafe = orphans.reduce((n, o) => n + unsafeRows(o, canonical), 0);
    if (unsafe > 0) {
      skipped.push(`${corps_name} — ${unsafe} differing shared-event rows (canonical ${canonical})`);
      continue;
    }
    merged.push(`${corps_name} → ${canonical} (${reason}); orphans: ${orphans.join(", ")}`);
    console.log(`\n${corps_name}: canonical=${canonical} (${reason}); orphans=${orphans.join(", ")}`);
    for (const orphan of orphans) {
      for (const t of tablesWithCorpsKey) {
        const orphanRows = (
          db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE corps_key=?`).get(orphan) as { c: number }
        ).c;
        if (!orphanRows) continue;
        const col = collisionCol(t);
        if (col) {
          const wouldDel = (
            db
              .prepare(
                `SELECT COUNT(*) c FROM "${t}" WHERE corps_key=? AND "${col}" IN (SELECT "${col}" FROM "${t}" WHERE corps_key=?)`
              )
              .get(orphan, canonical) as { c: number }
          ).c;
          if (apply) {
            db.prepare(
              `DELETE FROM "${t}" WHERE corps_key=? AND "${col}" IN (SELECT "${col}" FROM "${t}" WHERE corps_key=?)`
            ).run(orphan, canonical);
            db.prepare(`UPDATE "${t}" SET corps_key=? WHERE corps_key=?`).run(canonical, orphan);
          }
          totalDel += wouldDel;
          totalRemap += orphanRows - wouldDel;
          console.log(`  ${t}: del ${wouldDel}, remap ${orphanRows - wouldDel}`);
        } else {
          const canonExists =
            (db.prepare(`SELECT COUNT(*) c FROM "${t}" WHERE corps_key=?`).get(canonical) as {
              c: number;
            }).c > 0;
          if (apply) {
            if (canonExists) db.prepare(`DELETE FROM "${t}" WHERE corps_key=?`).run(orphan);
            else db.prepare(`UPDATE "${t}" SET corps_key=? WHERE corps_key=?`).run(canonical, orphan);
          }
          if (canonExists) totalDel += orphanRows;
          else totalRemap += orphanRows;
          console.log(`  ${t}: ${canonExists ? "del" : "remap"} ${orphanRows} (singleton)`);
        }
      }
    }
  }
  if (!apply) throw new Error("DRY_RUN_ROLLBACK");
});

// FK enforcement off for the controlled merge (must be set outside the
// transaction). The end state has no dangling refs from the merge — every orphan
// reference is deleted or remapped to the canonical. We compare foreign_key_check
// before vs after so PRE-EXISTING violations (e.g. event_participants rows for
// corps that never had a corps record) don't cause a false failure.
const fkBefore = apply ? (db.pragma("foreign_key_check") as unknown[]).length : 0;
if (apply) db.pragma("foreign_keys = OFF");
try {
  run();
} catch (e: any) {
  if (e?.message !== "DRY_RUN_ROLLBACK") throw e;
} finally {
  if (apply) db.pragma("foreign_keys = ON");
}
if (apply) {
  const fkAfter = (db.pragma("foreign_key_check") as unknown[]).length;
  if (fkAfter > fkBefore) {
    console.error(`\nFK violations INCREASED by the merge: ${fkBefore} → ${fkAfter}`);
    process.exitCode = 1;
  } else {
    console.log(`\nforeign_key_check: no new violations (${fkBefore} pre-existing).`);
  }
}

console.log(`\n${apply ? "APPLIED" : "DRY RUN (no writes)"} — merged ${merged.length} corps, deleted ${totalDel}, remapped ${totalRemap}`);
if (skipped.length) console.log(`\nSKIPPED (review manually):\n  ${skipped.join("\n  ")}`);
db.close();
