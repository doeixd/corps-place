// One-off, sourced curation of the Michael Gaines staff profile.
//
// The general cleaner (cleanYearbookStaff.ts) fixes systemic OCR/dup/hiatus noise
// but CANNOT recover history that was never ingested or undo a corps
// misattribution. This script does that for Michael Gaines specifically, from
// verified sources. It is DRY-RUN BY DEFAULT and IDEMPOTENT (it rebuilds his
// assignment set declaratively, so re-running produces the same result).
//
// Corrections (vs. what the yearbook ingest left):
//   • ADD  The Cavaliers 1998–2011 — Drill Designer / Visual Coordinator; on the
//          design team for all 7 of their DCI World Championships (was MISSING).
//   • ADD  Cavaliers color-guard membership 1987–1990 as a "performed" affiliation.
//   • MOVE 2017 / 2019 / 2022 Creative Director from "Vanguard Cadets" → Santa
//          Clara Vanguard (misattribution: he was SCV/VMAPA Creative Director from
//          2017); ADD the missing 2018 (designed SCV's championship "Babylon").
//   • DROP Santa Clara Vanguard 2023 — the corps was on hiatus that season.
//   • KEEP/dedup SCV 2024–2026 (Visual Designer) and Memphis Blues 2023 (Drill
//          Designer), collapsing the "Drill Design"/OCR duplicates.
//
// Sources:
//   https://michaelgaines.com/bio/                (1998–2011 Cavaliers; 7 titles; CG 1987–90)
//   https://www.scvanguard.org/staff/michael-gaines/
//   https://www.dci.org/hall-of-fame/michael%20gaines/
//   https://www.drumcorpsplanet.com/2017/04/santa-clara-vanguard-welcomes-michael-gaines-as-creative-director/
//   https://www.dci.org/news/behind-the-return-of-santa-clara-vanguard-to-the-2024-dci-tour/  (2023 hiatus, 2024 return)
//
// Usage:
//   npx tsx scripts/fixMichaelGaines.ts            # dry-run
//   npx tsx scripts/fixMichaelGaines.ts --apply    # write (single transaction)
// After --apply, a FULL read-model emit + the normal publish path is needed to reach
// the live site (a partial `--only staff` emit does NOT flip the live A/B pointer).
//
// NOTE: single-writer DB — don't --apply while a scrape/ingest is writing.

import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const APPLY = process.argv.includes("--apply");

const PERSON = "michael-gaines";
const SOURCE = "https://michaelgaines.com/bio/";

// corps_key values (verified against the corps table)
const SCV = "001j000000h3xwcaav"; // Santa Clara Vanguard (World Class)
const CADETS = "001j000000iwxakaa1"; // Vanguard Cadets (Open Class) — misattribution source
const MEMPHIS = "0015b00002byuh0aap"; // Memphis Blues (Open Class)
const CAV = "001j000000iwxafaa1"; // The Cavaliers (World Class)
const PHOTO = "https://www.scvanguard.org/wp-content/uploads/2022/07/michaelg.png";

const staffId = (corpsKey: string) => `${corpsKey}:${PERSON}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// All staff_ids whose assignments we own/rebuild (Cadets included so the
// misattributed rows are removed; Cavaliers will be created).
const OWNED_STAFF_IDS = [SCV, CADETS, MEMPHIS, CAV].map(staffId);

type Target = { corpsKey: string; season: number; title: string; role: string };

// The declarative, correct assignment set.
const TARGETS: Target[] = [
  // The Cavaliers — drill designer / visual coordinator, 1998–2011 (7 titles).
  ...Array.from({ length: 2011 - 1998 + 1 }, (_, i) => ({
    corpsKey: CAV,
    season: 1998 + i,
    title: "Drill Designer / Visual Coordinator",
    role: "visual",
  })),
  // Santa Clara Vanguard — Creative Director era (competitive seasons only;
  // 2020 cancelled, 2021 no SCV corps, 2023 hiatus → intentionally omitted).
  { corpsKey: SCV, season: 2017, title: "Creative Director", role: "director" },
  { corpsKey: SCV, season: 2018, title: "Creative Director / Visual Designer", role: "director" },
  { corpsKey: SCV, season: 2019, title: "Creative Director", role: "director" },
  { corpsKey: SCV, season: 2022, title: "Director of Programs / Visual Designer / Creative Director", role: "director" },
  // SCV — Visual Designer, post-return (kept from ingest, deduped).
  { corpsKey: SCV, season: 2024, title: "Visual Designer", role: "visual" },
  { corpsKey: SCV, season: 2025, title: "Visual Designer", role: "visual" },
  { corpsKey: SCV, season: 2026, title: "Visual Designer", role: "visual" },
  // Memphis Blues — kept from ingest, deduped to the richer title.
  { corpsKey: MEMPHIS, season: 2023, title: "Drill Designer", role: "visual" },
];

const main = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Current state (for the dry-run diff).
  const before = yield* sql<{ corps_key: string; season: string | null; title: string | null }>`
    SELECT a.corps_key, a.season, a.title
    FROM corps_staff_assignments a JOIN corps_staff s ON a.staff_id = s.staff_id
    WHERE s.person_id = ${PERSON} ORDER BY a.corps_key, a.season
  `;
  const nameFor = new Map<string, string>();
  for (const ck of [SCV, CADETS, MEMPHIS, CAV]) {
    const r = yield* sql<{ name: string }>`SELECT name FROM corps WHERE corps_key = ${ck} LIMIT 1`;
    nameFor.set(ck, r[0]?.name ?? ck);
  }

  console.log(`── BEFORE (${before.length} assignment rows) ──`);
  for (const b of before) console.log(`  ${nameFor.get(b.corps_key) ?? b.corps_key} ${b.season ?? "?"}: ${b.title ?? "(null)"}`);

  console.log(`\n── AFTER (${TARGETS.length} assignment rows) ──`);
  for (const t of TARGETS) console.log(`  ${nameFor.get(t.corpsKey)} ${t.season}: ${t.title}`);
  console.log(`  + performed affiliation: ${nameFor.get(CAV)} color guard 1987–1990`);

  if (!APPLY) {
    console.log(`\nDRY-RUN — no changes written. Re-run with --apply.`);
    return;
  }

  // Idempotent rebuild, in one transaction.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // 1) Ensure a corps_staff row exists for The Cavaliers staff_id.
      yield* sql`
        INSERT INTO corps_staff (staff_id, given_name, family_name, display_name, default_title, photo_url, person_id)
        VALUES (${staffId(CAV)}, 'Michael', 'Gaines', 'Michael Gaines', 'Drill Designer / Visual Coordinator', ${PHOTO}, ${PERSON})
        ON CONFLICT(staff_id) DO UPDATE SET person_id = ${PERSON}
      `;

      // 2) Remove all assignments we own, then reinsert the correct set.
      for (const sid of OWNED_STAFF_IDS) {
        yield* sql`DELETE FROM corps_staff_assignments WHERE staff_id = ${sid}`;
      }
      for (const t of TARGETS) {
        const id = `fix-${PERSON}:${t.corpsKey}:${t.season}:${slug(t.title)}`;
        yield* sql`
          INSERT INTO corps_staff_assignments
            (assignment_id, staff_id, corps_key, season, title, role_type, start_year, end_year, notes, links_json)
          VALUES (${id}, ${staffId(t.corpsKey)}, ${t.corpsKey}, ${String(t.season)}, ${t.title}, ${t.role},
                  ${t.season}, ${t.season}, ${"manual-curation: " + SOURCE}, ${JSON.stringify([SOURCE])})
        `;
      }

      // 3) Cavaliers color-guard membership 1987–1990 as a "performed" affiliation.
      yield* sql`
        INSERT INTO corps_staff_affiliations
          (affiliation_id, staff_id, related_corps_key, relation_type, notes, since_season, through_season)
        VALUES (${`fix-${PERSON}:performed:cavaliers`}, ${staffId(CAV)}, ${CAV}, 'performed',
                ${"manual-curation: color guard member; " + SOURCE}, '1987', '1990')
        ON CONFLICT(affiliation_id) DO UPDATE SET since_season='1987', through_season='1990'
      `;
    }),
  );

  console.log(
    `\nAPPLIED to dci-relational.db.\n` +
      `To publish to the live site, run a FULL read-model emit (a partial --only emit\n` +
      `writes .partial.db and does NOT flip the live A/B pointer):\n` +
      `  npx tsx scripts/emitReadModel.ts   # then the normal push:data / redeploy publish path`,
  );
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("fixMichaelGaines failed:", error);
  process.exitCode = 1;
});
