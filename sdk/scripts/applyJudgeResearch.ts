// Ingest web-researched judge bios/photos into the `judges` table (fill-if-empty). HIGH/MEDIUM
// only; photo verified+cached via MediaService (ownerType:'judge'). Re-runnable; --apply writes.
// Usage: npx tsx scripts/applyJudgeResearch.ts [--file results/staff-research/batch-judges.json] [--apply]
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadRepoEnv } from "./scriptEnv.js";
import { verifyImageUrl } from "../src/staffImage.js";
import { makeMediaServiceLayer, MediaService } from "../src/mediaService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const file = resolve(SDK_DIR, args.includes("--file") ? args[args.indexOf("--file") + 1]! : "results/staff-research/batch-judges.json");
const DB_URL = process.env.DCI_RELATIONAL_DB_URL ?? `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const MEDIA_CACHE_URL = process.env.MEDIA_CACHE_DB_URL ?? `file:${resolve(SDK_DIR, "media-cache.db")}`;

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (apply) yield* sql`PRAGMA busy_timeout=15000`;
  const recs = JSON.parse(readFileSync(file, "utf8")) as any[];
  let bios = 0, photos = 0, skipped = 0;
  for (const r of recs) {
    if ((r.confidence ?? "").toUpperCase() === "LOW" || !r.judge_id) { skipped++; continue; }
    const cur = yield* sql<{ biography: string | null; photo_url: string | null }>`SELECT biography, photo_url FROM judges WHERE judge_id=${r.judge_id}`;
    if (cur.length === 0) { skipped++; continue; }
    const bio = (r.bio ?? "").trim();
    if (bio.length >= 40 && (cur[0]!.biography ?? "").trim().length < 40) {
      if (apply) yield* sql`UPDATE judges SET biography=${bio} WHERE judge_id=${r.judge_id}`;
      bios++;
    }
    if (r.photo_url && /^https?:\/\//.test(r.photo_url) && !(cur[0]!.photo_url ?? "").trim()) {
      const v = yield* verifyImageUrl(r.photo_url);
      if (v.ok) {
        if (apply) {
          const media = yield* MediaService;
          yield* media.cache({ ownerType: "judge", ownerId: r.judge_id, role: "headshot", sourceUrl: r.photo_url, title: `${r.display_name} headshot`, attribution: "web research" }).pipe(Effect.orElseSucceed(() => undefined));
          yield* sql`UPDATE judges SET photo_url=${r.photo_url} WHERE judge_id=${r.judge_id}`;
        }
        photos++;
      }
    }
  }
  yield* Effect.logInfo(`${apply ? "APPLIED" : "(dry-run)"}: ${bios} bios, ${photos} photos, ${skipped} skipped.`);
});

const SqlLayer = LibsqlClient.layer({ url: DB_URL });
const MediaLayer = makeMediaServiceLayer({ cacheDbUrl: MEDIA_CACHE_URL }).pipe(Layer.provide(SqlLayer));
Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(SqlLayer, MediaLayer)))).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
