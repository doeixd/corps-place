// Staff identity resolution + review CLI (docs/staff-scraping-plan.md §4.3 / M6).
//
// `staff_id` is per-source (one per person-per-corps; within a corps the scraper already
// collapses a person across seasons into one staff_id). `person_id` is the CANONICAL
// grouping the /staff profile rolls up by. This CLI assigns person_id conservatively:
//
//   - Default run: assign person_id = slug(name). A name shared across corps (collision)
//     is SPLIT by default (slug, slug-2, …) and each pair is enqueued in corps_staff_review
//     as `needs-review` — we NEVER auto-merge across corps without evidence.
//   - --auto-merge: for each unresolved review pair, run compareStaffMembersWithClaude;
//     merge ONLY on samePerson && confidence ≥ threshold && a corroborating signal
//     (shared photo_url, shared link, or strong bio overlap). Otherwise leave split.
//   - --list / --merge A B / --split A B: inspect & apply manual decisions.
//
// Usage (from sdk/):
//   npx tsx scripts/resolveStaffIdentity.ts                 # assign + queue (dry-run unless --apply)
//   npx tsx scripts/resolveStaffIdentity.ts --apply
//   npx tsx scripts/resolveStaffIdentity.ts --auto-merge --apply --confidence 0.85
//   npx tsx scripts/resolveStaffIdentity.ts --list
//   npx tsx scripts/resolveStaffIdentity.ts --merge <staffIdA> <staffIdB> --apply

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { ensureStaffSchema, makeStaffPersonId, upsertStaffReview } from "../src/relational.js";
import { compareStaffMembersWithClaude } from "../src/scraperClaude.js";
import type { CorpsStaffMember } from "../src/relational.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const getOpt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const apply = hasFlag("--apply");
const autoMerge = hasFlag("--auto-merge");
const list = hasFlag("--list");
const mergePair = hasFlag("--merge") ? [args[args.indexOf("--merge") + 1]!, args[args.indexOf("--merge") + 2]!] : null;
const splitPair = hasFlag("--split") ? [args[args.indexOf("--split") + 1]!, args[args.indexOf("--split") + 2]!] : null;
const confThreshold = Number(getOpt("--confidence") ?? 0.8);
const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;

interface StaffRow {
  staff_id: string;
  display_name: string | null;
  person_id: string | null;
  biography: string | null;
  photo_url: string | null;
}

/** Canonical (un-suffixed) person_id shared by a merged group. */
const baseOf = (personId: string) => personId.replace(/-\d+$/, "");

const corpsOf = (staffId: string) => staffId.split(":")[0] ?? staffId;

// ---- corroboration (deterministic, no photo-hash) ---------------------------
const tokens = (s: string | null) =>
  new Set((s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length > 3));
const bioOverlap = (a: string | null, b: string | null): number => {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size < 4 || tb.size < 4) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size);
};
const corroborated = (a: StaffRow, b: StaffRow): boolean =>
  (Boolean(a.photo_url) && a.photo_url === b.photo_url) || bioOverlap(a.biography, b.biography) >= 0.5;

// ---- person_id mutation -----------------------------------------------------
const setPersonId = (sql: SqlClient.SqlClient, staffId: string, personId: string) =>
  sql`UPDATE corps_staff SET person_id=${personId} WHERE staff_id=${staffId}`.pipe(Effect.asVoid);

/** Reconstruct a minimal CorpsStaffMember (for the LLM comparator) from the DB. */
const loadMember = (sql: SqlClient.SqlClient, row: StaffRow): Effect.Effect<CorpsStaffMember> =>
  Effect.gen(function* () {
    const a = yield* sql<{ corps_key: string; corps_name: string | null; season: string | null; title: string | null; role_type: string | null }>`
      SELECT corps_key, corps_name, season, title, role_type FROM corps_staff_assignments WHERE staff_id=${row.staff_id}`;
    return {
      staffId: row.staff_id,
      givenName: null,
      familyName: null,
      displayName: row.display_name,
      defaultTitle: a[0]?.title ?? null,
      biography: row.biography,
      photoUrl: row.photo_url,
      externalLinks: [],
      affiliations: [],
      assignments: a.map((x) => ({
        assignmentId: null, corpsKey: x.corps_key, corpsName: x.corps_name, season: x.season,
        title: x.title, roleType: x.role_type, startYear: null, endYear: null,
        startDate: null, endDate: null, notes: null, links: [],
      })),
      metadata: undefined,
    };
  });

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureStaffSchema; // ensure person_id column + review table exist

  if (list) {
    const rows = yield* sql<{ review_id: string; left_staff_id: string; right_staff_id: string; same_person: number | null; confidence: string | null; action: string | null }>`
      SELECT review_id, left_staff_id, right_staff_id, same_person, confidence, action
        FROM corps_staff_review WHERE resolved=0 ORDER BY review_id`;
    yield* Effect.logInfo(`${rows.length} unresolved review pairs:`);
    for (const r of rows) console.log(`  ${r.review_id}  same=${r.same_person} conf=${r.confidence} action=${r.action}`);
    return;
  }

  if (mergePair || splitPair) {
    const [a, b] = (mergePair ?? splitPair)!;
    const rows = yield* sql<StaffRow>`SELECT staff_id, display_name, person_id, biography, photo_url FROM corps_staff WHERE staff_id IN (${a}, ${b})`;
    if (rows.length < 2) return yield* Effect.logError(`both staff_ids must exist: ${a}, ${b}`);
    const canonical = baseOf(rows[0]!.person_id ?? makeStaffPersonId(rows[0]!.display_name) ?? a);
    if (apply) {
      if (mergePair) {
        // Merge: both share the canonical (un-suffixed) person_id.
        yield* setPersonId(sql, a, canonical);
        yield* setPersonId(sql, b, canonical);
      } else {
        // Split: ensure distinct person_ids.
        yield* setPersonId(sql, a, canonical);
        yield* setPersonId(sql, b, `${canonical}-2`);
      }
      yield* upsertStaffReview(sql, {
        leftStaffId: a, rightStaffId: b, samePerson: Boolean(mergePair),
        action: mergePair ? "merge" : "keep-separate", resolved: true, decidedBy: "manual",
      });
    }
    yield* Effect.logInfo(`${apply ? "applied" : "[dry-run]"} ${mergePair ? "merge" : "split"} ${a} / ${b}`);
    return;
  }

  // ---- default: assign person_id + queue cross-corps collisions ----
  const all = yield* sql<StaffRow>`SELECT staff_id, display_name, person_id, biography, photo_url FROM corps_staff`;
  const taken = new Set(all.filter((r) => r.person_id).map((r) => r.person_id!));
  const nextFree = (slug: string): string => {
    if (!taken.has(slug)) return slug;
    for (let i = 2; ; i++) if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
  };

  // Group unassigned rows by base slug.
  const bySlug = new Map<string, StaffRow[]>();
  for (const r of all.filter((r) => !r.person_id)) {
    const slug = makeStaffPersonId(r.display_name);
    if (!slug) continue;
    (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug)!).push(r);
  }

  let assigned = 0;
  let queued = 0;
  for (const [slug, group] of bySlug) {
    const collidesExisting = taken.has(slug); // an already-resolved row holds this slug
    const sorted = [...group].sort((a, b) => a.staff_id.localeCompare(b.staff_id));
    const assignedIds: { staffId: string; personId: string }[] = [];
    for (const r of sorted) {
      const pid = nextFree(slug);
      taken.add(pid);
      if (apply) yield* setPersonId(sql, r.staff_id, pid);
      assignedIds.push({ staffId: r.staff_id, personId: pid });
      assigned++;
    }
    // Already-resolved rows holding this base slug (from a prior run / other corps).
    // They must be paired against the new rows too, else an incremental cross-corps
    // collision is split but never surfaced for review (#3).
    const existingHolders = all
      .filter((r) => r.person_id && baseOf(r.person_id) === slug)
      .map((r) => r.staff_id);
    // Candidate identities to cross-pair: the freshly-assigned rows + existing holders.
    const candidates = [
      ...assignedIds.map((a) => a.staffId),
      ...existingHolders,
    ];
    const distinctCorps = new Set(candidates.map((id) => corpsOf(id)));
    if (distinctCorps.size > 1) {
      // Enqueue needs-review for each cross-corps pair (conservative: stays split).
      // Skip pairs where BOTH sides are pre-existing holders (already adjudicated).
      const isNew = new Set(assignedIds.map((a) => a.staffId));
      for (let i = 0; i < candidates.length; i++)
        for (let j = i + 1; j < candidates.length; j++) {
          if (corpsOf(candidates[i]!) === corpsOf(candidates[j]!)) continue;
          if (!isNew.has(candidates[i]!) && !isNew.has(candidates[j]!)) continue;
          if (apply)
            yield* upsertStaffReview(sql, {
              leftStaffId: candidates[i]!, rightStaffId: candidates[j]!,
              samePerson: null, action: "needs-review", confidence: "unknown",
              rationale: `same name slug "${slug}" across corps — split by default`,
            });
          queued++;
        }
    }
  }
  yield* Effect.logInfo(`${apply ? "applied" : "[dry-run]"} assign: ${assigned} person_ids, ${queued} review pairs queued`);

  // ---- optional: LLM auto-merge of queued pairs ----
  if (autoMerge) {
    const pairs = yield* sql<{ left_staff_id: string; right_staff_id: string }>`
      SELECT left_staff_id, right_staff_id FROM corps_staff_review WHERE resolved=0 AND action='needs-review'`;
    let merged = 0;
    for (const p of pairs) {
      const rows = yield* sql<StaffRow>`SELECT staff_id, display_name, person_id, biography, photo_url FROM corps_staff WHERE staff_id IN (${p.left_staff_id}, ${p.right_staff_id})`;
      if (rows.length < 2) continue;
      const [ra, rb] = rows;
      const ma = yield* loadMember(sql, ra!);
      const mb = yield* loadMember(sql, rb!);
      const cmp = yield* compareStaffMembersWithClaude(ma, mb).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!cmp) continue;
      const ok = cmp.samePerson && cmp.confidence >= confThreshold && cmp.recommendedAction !== "keep-separate" && corroborated(ra!, rb!);
      if (ok && apply) {
        const canonical = baseOf(ra!.person_id ?? makeStaffPersonId(ra!.display_name) ?? p.left_staff_id);
        yield* setPersonId(sql, p.left_staff_id, canonical);
        yield* setPersonId(sql, p.right_staff_id, canonical);
        merged++;
      }
      if (apply)
        yield* upsertStaffReview(sql, {
          leftStaffId: p.left_staff_id, rightStaffId: p.right_staff_id, samePerson: cmp.samePerson,
          confidence: String(cmp.confidence), action: ok ? "merge" : "needs-review",
          rationale: cmp.rationale, resolved: ok, decidedBy: "claude",
        });
      yield* Effect.logInfo(`  cmp ${p.left_staff_id} ~ ${p.right_staff_id}: same=${cmp.samePerson} conf=${cmp.confidence} corrob=${corroborated(ra!, rb!)} → ${ok ? "MERGE" : "keep-split"}`);
    }
    yield* Effect.logInfo(`${apply ? "applied" : "[dry-run]"} auto-merge: ${merged} merged of ${pairs.length} pairs`);
  }
});

Effect.runPromise(program.pipe(Effect.provide(LibsqlClient.layer({ url: DB_URL }))))
  .then(() => { console.log("Done."); process.exit(0); })
  .catch((err) => { console.error("resolveStaffIdentity failed:", err); process.exit(1); });
