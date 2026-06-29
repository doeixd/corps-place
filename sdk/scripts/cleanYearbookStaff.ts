// Clean yearbook-ingested staff assignments (corps_staff_assignments).
//
// The staff history is auto-extracted from DCI yearbook PDFs via OCR + a
// deterministic parser with an LLM fallback. That pipeline leaves four classes
// of error (all observed on the Michael Gaines profile). This script detects and
// (with --apply) fixes the systemic, automatable ones; the rest it reports for
// human review. It is DRY-RUN BY DEFAULT and always writes a JSON report.
//
//   Phase 1  OCR title normalization   — fix broken hyphenation ("Direc- tor" →
//            "Director") + collapse whitespace.                      [--apply writes]
//   Phase 2  Dedup within (staff, corps, season) — drop exact dupes and titles
//            subsumed by a richer one ("Drill Design" ⊂ "Drill Designer";
//            "Creative Director" ⊂ "Creative Director / Visual Designer"). [--apply writes]
//   Phase 3  Inactive/hiatus season — an assignment for a (corps, season) where
//            the corps had ZERO competitive activity AND was active in an earlier
//            AND a later season (a true gap, e.g. SCV 2023). Flank-guarded so the
//            current/future unscored season is never flagged.   [report; --drop-inactive deletes]
//   Phase 4  Sister-corps collision — same person, same season, two corps whose
//            names share a token (e.g. Santa Clara Vanguard vs Vanguard Cadets).
//            Likely misattribution. REPORT ONLY — never auto-fixed.
//
// Usage:
//   npx tsx scripts/cleanYearbookStaff.ts                       # dry-run, all people
//   npx tsx scripts/cleanYearbookStaff.ts --person michael-gaines
//   npx tsx scripts/cleanYearbookStaff.ts --apply               # write phases 1 & 2
//   npx tsx scripts/cleanYearbookStaff.ts --apply --drop-inactive
//
// NOTE: dci-relational.db is single-writer. Do NOT run --apply while a
// scrape/ingest (e.g. scrapeYearbooks --apply) is writing the DB. After applying,
// re-emit the read-model so the site reflects the changes.

import { mkdirSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { LibsqlClient } from "@effect/sql-libsql";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const argv = process.argv.slice(2);
const hasFlag = (f: string) => argv.includes(f);
const argValue = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const APPLY = hasFlag("--apply");
const DROP_INACTIVE = hasFlag("--drop-inactive");
const ONLY_PERSON = argValue("--person");

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Repair OCR damage in a title without altering meaning. Conservative: only
 *  rejoins mid-word hyphen breaks ("Direc- tor" → "Director", left letter + "-"
 *  + spaces + lowercase letter) and collapses runs of whitespace. */
export const normalizeTitle = (raw: string | null | undefined): string =>
  (raw ?? "")
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

/** Comparison key for dedup/subsumption: lowercase, alphanumerics only. */
const cmpKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Significant name tokens for collision detection (len ≥ 4, lowercased). */
const nameTokens = (name: string) =>
  new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 4),
  );

type Assignment = {
  assignment_id: string;
  staff_id: string;
  person_id: string;
  corps_key: string;
  corps_name: string;
  season: string | null;
  title: string | null;
  role_type: string | null;
};

type TitleFix = { assignment_id: string; from: string; to: string };
type Dropped = { assignment_id: string; corps_name: string; season: string | null; title: string; reason: string; kept: string };
type Inactive = { assignment_id: string; person_id: string; corps_name: string; season: string; title: string; activeSeasons: string[] };
type Collision = { person_id: string; season: string; corps: string[]; sharedTokens: string[] };

const main = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ── Load assignments (+ person_id and corps name) ───────────────────────────
  const rows = yield* sql<Assignment>`
    SELECT a.assignment_id, a.staff_id, s.person_id, a.corps_key,
           COALESCE(c.name, a.corps_key) AS corps_name, a.season, a.title, a.role_type
    FROM corps_staff_assignments a
    JOIN corps_staff s ON a.staff_id = s.staff_id
    LEFT JOIN corps c ON a.corps_key = c.corps_key
    ${ONLY_PERSON ? sql`WHERE s.person_id = ${ONLY_PERSON}` : sql``}
  `;
  console.log(`Loaded ${rows.length} assignment(s)${ONLY_PERSON ? ` for ${ONLY_PERSON}` : ""}.`);

  // ── Phase 1: normalize titles (in memory; applied to surviving rows) ────────
  const titleFixes: TitleFix[] = [];
  const norm = new Map<string, string>(); // assignment_id -> normalized title
  for (const r of rows) {
    const fixed = normalizeTitle(r.title);
    norm.set(r.assignment_id, fixed);
    if (r.title != null && fixed !== r.title) titleFixes.push({ assignment_id: r.assignment_id, from: r.title, to: fixed });
  }

  // ── Phase 2: dedup within (staff_id, corps_key, season) ─────────────────────
  const groups = new Map<string, Assignment[]>();
  for (const r of rows) {
    const k = `${r.staff_id}|${r.corps_key}|${r.season ?? ""}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }

  const dropped: Dropped[] = [];
  const droppedIds = new Set<string>();
  const survivors: Assignment[] = [];

  for (const group of groups.values()) {
    // Stable order so "kept" choice is deterministic.
    const sorted = [...group].sort((a, b) => a.assignment_id.localeCompare(b.assignment_id));
    // (a) collapse exact normalized-title dupes
    const byKey = new Map<string, Assignment>();
    for (const r of sorted) {
      const key = cmpKey(norm.get(r.assignment_id)!);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, r);
      } else {
        dropped.push({ assignment_id: r.assignment_id, corps_name: r.corps_name, season: r.season, title: r.title, reason: "exact-duplicate", kept: norm.get(existing.assignment_id)! });
        droppedIds.add(r.assignment_id);
      }
    }
    // (b) drop titles subsumed by a richer sibling (proper substring, len ≥ 5)
    const distinct = [...byKey.values()];
    for (const r of distinct) {
      const key = cmpKey(norm.get(r.assignment_id)!);
      const superset = distinct.find((o) => {
        if (o === r) return false;
        const ok = cmpKey(norm.get(o.assignment_id)!);
        return key.length >= 5 && ok.length > key.length && ok.includes(key);
      });
      if (superset) {
        dropped.push({ assignment_id: r.assignment_id, corps_name: r.corps_name, season: r.season, title: r.title, reason: "subsumed", kept: norm.get(superset.assignment_id)! });
        droppedIds.add(r.assignment_id);
      } else {
        survivors.push(r);
      }
    }
  }

  // ── Phase 3: inactive/hiatus season (flank-guarded) ─────────────────────────
  const corpsKeys = [...new Set(survivors.map((r) => r.corps_key))];
  const activeByCorps = new Map<string, Set<number>>();
  for (const ck of corpsKeys) {
    const seasons = yield* sql<{ season: string }>`
      SELECT DISTINCT c.season AS season
      FROM corps_scores cs JOIN competitions c ON cs.competition_slug = c.slug
      WHERE cs.corps_key = ${ck} AND c.season IS NOT NULL
    `;
    activeByCorps.set(ck, new Set(seasons.map((s) => Number(s.season)).filter((n) => Number.isFinite(n))));
  }

  // League-wide competitive seasons. Excludes dark years where ~no corps competed
  // (2020 COVID cancellation; reduced years) so a "gap" only counts as a hiatus when
  // OTHER corps actually competed that season (SCV 2023 = true; everyone-2020 = false).
  const MIN_CORPS_FOR_REAL_SEASON = 10;
  const seasonCorps = yield* sql<{ season: string; n: number }>`
    SELECT c.season AS season, COUNT(DISTINCT cs.corps_key) AS n
    FROM corps_scores cs JOIN competitions c ON cs.competition_slug = c.slug
    WHERE c.season IS NOT NULL GROUP BY c.season
  `;
  const competitiveSeasons = new Set(
    seasonCorps.filter((s) => s.n >= MIN_CORPS_FOR_REAL_SEASON).map((s) => Number(s.season)),
  );

  const inactive: Inactive[] = [];
  for (const r of survivors) {
    const yr = Number(r.season);
    if (!Number.isFinite(yr)) continue;
    if (!competitiveSeasons.has(yr)) continue; // skip dark/COVID years — not a corps-specific hiatus
    const active = activeByCorps.get(r.corps_key)!;
    if (active.has(yr)) continue;
    const hasEarlier = [...active].some((s) => s < yr);
    const hasLater = [...active].some((s) => s > yr); // flank guard: skip current/future unscored season
    if (hasEarlier && hasLater) {
      inactive.push({ assignment_id: r.assignment_id, person_id: r.person_id, corps_name: r.corps_name, season: r.season!, title: norm.get(r.assignment_id)!, activeSeasons: [...active].sort().map(String) });
    }
  }

  // ── Phase 4: sister-corps collision (report only) ───────────────────────────
  const bySeasonPerson = new Map<string, Assignment[]>();
  for (const r of survivors) {
    if (!r.season) continue;
    const k = `${r.person_id}|${r.season}`;
    (bySeasonPerson.get(k) ?? bySeasonPerson.set(k, []).get(k)!).push(r);
  }
  const collisions: Collision[] = [];
  for (const [k, list] of bySeasonPerson) {
    const corps = [...new Map(list.map((r) => [r.corps_key, r.corps_name])).values()];
    if (corps.length < 2) continue;
    // any pair sharing a significant token?
    const shared = new Set<string>();
    for (let i = 0; i < corps.length; i++)
      for (let j = i + 1; j < corps.length; j++) {
        const ti = nameTokens(corps[i]!);
        for (const t of nameTokens(corps[j]!)) if (ti.has(t)) shared.add(t);
      }
    if (shared.size > 0) {
      const [person_id, season] = k.split("|");
      collisions.push({ person_id: person_id!, season: season!, corps, sharedTokens: [...shared] });
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log(`\n── Findings ──`);
  console.log(`Phase 1  title OCR fixes:        ${titleFixes.length}`);
  console.log(`Phase 2  duplicate rows to drop: ${dropped.length}`);
  console.log(`Phase 3  inactive-season rows:   ${inactive.length}${DROP_INACTIVE ? " (will delete)" : " (report only — pass --drop-inactive to delete)"}`);
  console.log(`Phase 4  collision reviews:      ${collisions.length} (report only)`);

  const sample = <T>(label: string, arr: T[], fmt: (x: T) => string) => {
    if (!arr.length) return;
    console.log(`\n${label}:`);
    for (const x of arr.slice(0, 15)) console.log("  " + fmt(x));
    if (arr.length > 15) console.log(`  …and ${arr.length - 15} more`);
  };
  sample("Title fixes", titleFixes, (f) => `[${f.from}] → [${f.to}]`);
  sample("Drops", dropped, (d) => `${d.corps_name} ${d.season ?? "?"}: drop "${d.title}" (${d.reason}; kept "${d.kept}")`);
  sample("Inactive seasons", inactive, (i) => `${i.person_id} — ${i.corps_name} ${i.season} "${i.title}" (active: ${i.activeSeasons.join(", ")})`);
  sample("Collisions", collisions, (c) => `${c.person_id} ${c.season}: ${c.corps.join(" / ")} (shared: ${c.sharedTokens.join(", ")})`);

  // ── Apply ─────────────────────────────────────────────────────────────────
  if (APPLY) {
    let titleUpdated = 0,
      deleted = 0;
    // Title fixes only for surviving (non-dropped) rows.
    for (const f of titleFixes) {
      if (droppedIds.has(f.assignment_id)) continue;
      yield* sql`UPDATE corps_staff_assignments SET title = ${f.to} WHERE assignment_id = ${f.assignment_id}`;
      titleUpdated++;
    }
    for (const id of droppedIds) {
      yield* sql`DELETE FROM corps_staff_assignments WHERE assignment_id = ${id}`;
      deleted++;
    }
    if (DROP_INACTIVE) {
      for (const i of inactive) {
        yield* sql`DELETE FROM corps_staff_assignments WHERE assignment_id = ${i.assignment_id}`;
        deleted++;
      }
    }
    console.log(`\nAPPLIED: ${titleUpdated} title fix(es), ${deleted} row(s) deleted.`);
    console.log("Re-emit the read-model so the site reflects this: npx tsx scripts/emitReadModel.ts --only staff");
  } else {
    console.log(`\nDRY-RUN — no changes written. Re-run with --apply to write phases 1 & 2.`);
  }

  // ── Persist report ──────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = "results/staff-clean";
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/clean-${ONLY_PERSON ? ONLY_PERSON + "-" : ""}${stamp}.json`;
  writeFileSync(path, JSON.stringify({ applied: APPLY, dropInactive: DROP_INACTIVE, onlyPerson: ONLY_PERSON ?? null, counts: { titleFixes: titleFixes.length, dropped: dropped.length, inactive: inactive.length, collisions: collisions.length }, titleFixes, dropped, inactive, collisions }, null, 2));
  console.log(`\nReport: sdk/${path}`);
});

const SqlLayer = LibsqlClient.layer({ url: "file:./dci-relational.db" });

Effect.runPromise(main.pipe(Effect.provide(SqlLayer))).catch((error) => {
  console.error("cleanYearbookStaff failed:", error);
  process.exitCode = 1;
});
