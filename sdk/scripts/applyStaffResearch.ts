// S2 ingest — load web-researched staff bios/photos (written by research subagents as JSON
// files) into the candidate store. Each input file is an array of:
//   { person_id, display_name, bio?, photo_url?, sources: string[], confidence: HIGH|MEDIUM|LOW }
// Only HIGH/MEDIUM are written (LOW = unconfirmed identity, skipped). Bio/photo become dated
// candidates (source_kind='web-research', source_date=now → newest, so they win as current),
// the prior corps_staff value is preserved as a legacy candidate, and the photo is verified +
// cached before use. Re-runnable; --apply writes. See docs/staff-quality-plan.md S2.
//
// Usage:  npx tsx scripts/applyStaffResearch.ts [--dir results/staff-research] [--apply]
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { loadRepoEnv } from "./scriptEnv.js";
import { verifyImageUrl } from "../src/staffImage.js";
import { makeMediaServiceLayer, MediaService } from "../src/mediaService.js";
import { ensureStaffSchema } from "../src/relational.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dir = resolve(SDK_DIR, args.includes("--dir") ? args[args.indexOf("--dir") + 1]! : "results/staff-research");
const BIO_MIN = 40;
const nowIso = new Date().toISOString();
const ISO_EPOCH = "1970-01-01T00:00:00.000Z";

interface Researched {
  person_id: string;
  display_name?: string;
  bio?: string | null;
  photo_url?: string | null;
  sources?: string[];
  confidence?: string;
}

const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const MEDIA_CACHE_URL = process.env.MEDIA_CACHE_DB_URL ?? `file:${resolve(SDK_DIR, "media-cache.db")}`;

const recordCandidate = (sql: SqlClient.SqlClient, staffId: string, personId: string | null, kind: "bio" | "photo", value: string, sourceUrl: string) =>
  Effect.gen(function* () {
    const cur = yield* sql<{ v: string | null }>`SELECT ${kind === "bio" ? sql`biography` : sql`photo_url`} AS v FROM corps_staff WHERE staff_id=${staffId}`;
    const existing = (cur[0]?.v ?? "").trim();
    if (existing && existing !== value)
      yield* sql`INSERT OR IGNORE INTO staff_profile_candidates (staff_id,kind,source_url,person_id,value,source_kind,char_len,source_date,fetched_at,is_current)
        VALUES (${staffId},${kind},${"legacy://" + staffId},${personId},${existing},${"legacy"},${existing.length},${ISO_EPOCH},${nowIso},0)`.pipe(Effect.orElseSucceed(() => undefined));
    yield* sql`INSERT INTO staff_profile_candidates (staff_id,kind,source_url,person_id,value,source_kind,char_len,source_date,fetched_at,is_current)
      VALUES (${staffId},${kind},${sourceUrl},${personId},${value},${"web-research"},${value.length},${nowIso},${nowIso},0)
      ON CONFLICT(staff_id,kind,source_url) DO UPDATE SET value=excluded.value,char_len=excluded.char_len,source_date=excluded.source_date,fetched_at=excluded.fetched_at`.pipe(Effect.orElseSucceed(() => undefined));
    const top = yield* sql<{ value: string; source_url: string }>`SELECT value,source_url FROM staff_profile_candidates WHERE staff_id=${staffId} AND kind=${kind} ORDER BY source_date DESC, char_len DESC LIMIT 1`;
    if (top[0]) {
      yield* sql`UPDATE staff_profile_candidates SET is_current=0 WHERE staff_id=${staffId} AND kind=${kind}`;
      yield* sql`UPDATE staff_profile_candidates SET is_current=1 WHERE staff_id=${staffId} AND kind=${kind} AND source_url=${top[0].source_url}`;
      if (kind === "bio") yield* sql`UPDATE corps_staff SET biography=${top[0].value} WHERE staff_id=${staffId}`;
      else yield* sql`UPDATE corps_staff SET photo_url=${top[0].value} WHERE staff_id=${staffId}`;
    }
  });

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureStaffSchema;
  if (apply) yield* sql`PRAGMA busy_timeout=15000`;

  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
  const recs: Researched[] = [];
  for (const f of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (Array.isArray(parsed)) recs.push(...parsed);
    } catch (e) { yield* Effect.logWarning(`skip ${f}: ${String(e)}`); }
  }
  yield* Effect.logInfo(`Loaded ${recs.length} researched records from ${files.length} files. ${apply ? "APPLY" : "dry-run"}`);

  let bios = 0, photos = 0, skipped = 0;
  for (const r of recs) {
    const conf = (r.confidence ?? "").toUpperCase();
    if (conf === "LOW" || !r.person_id) { skipped++; continue; }
    // Resolve the person's staff rows; write to ALL rows so the read model rep-picks it.
    const rows = yield* sql<{ staff_id: string; person_id: string | null }>`SELECT staff_id, person_id FROM corps_staff WHERE person_id=${r.person_id}`;
    if (rows.length === 0) { skipped++; continue; }
    const src = (r.sources && r.sources[0]) || "web-research";

    let verifiedPhoto: string | null = null;
    if (r.photo_url && /^https?:\/\//.test(r.photo_url)) {
      const v = yield* verifyImageUrl(r.photo_url);
      verifiedPhoto = v.ok ? r.photo_url : null;
    }
    const bio = (r.bio ?? "").trim();
    const hasBio = bio.length >= BIO_MIN;

    for (const row of rows) {
      if (apply && hasBio) yield* recordCandidate(sql, row.staff_id, row.person_id, "bio", bio, src);
      if (apply && verifiedPhoto) {
        const media = yield* MediaService;
        yield* media.cache({ ownerType: "staff", ownerId: row.staff_id, role: "headshot", sourceUrl: verifiedPhoto, title: `${r.display_name ?? r.person_id} headshot`, attribution: "web research", metadata: { source: src } }).pipe(Effect.orElseSucceed(() => undefined));
        yield* recordCandidate(sql, row.staff_id, row.person_id, "photo", verifiedPhoto, src);
      }
    }
    if (hasBio) bios++;
    if (verifiedPhoto) photos++;
  }
  yield* Effect.logInfo(`${apply ? "APPLIED" : "(dry-run)"}: ${bios} bios, ${photos} photos, ${skipped} skipped (low-confidence/no-rows).`);
});

const SqlLayer = LibsqlClient.layer({ url: DB_URL });
const MediaLayer = makeMediaServiceLayer({ cacheDbUrl: MEDIA_CACHE_URL }).pipe(Layer.provide(SqlLayer));
Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(SqlLayer, MediaLayer))))
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
