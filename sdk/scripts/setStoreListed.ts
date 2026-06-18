// Toggle a merch store's `listed` flag (curated opt-out). An unlisted store and
// its products vanish from the merch surface on the next emit without data loss.
//
// Usage (from sdk/):
//   npx tsx scripts/setStoreListed.ts --store <store_id> --listed 0   # hide
//   npx tsx scripts/setStoreListed.ts --store <store_id> --listed 1   # show
//   npx tsx scripts/setStoreListed.ts --list-hidden                   # show opted-out

import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const getOpt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const storeId = getOpt("--store");
const listedRaw = getOpt("--listed");
const listHidden = args.includes("--list-hidden");
const DB_URL =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${resolve(SDK_DIR, "dci-relational.db")}`;

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql
    .unsafe(
      `ALTER TABLE merch_stores ADD COLUMN listed INTEGER NOT NULL DEFAULT 1`,
    )
    .pipe(Effect.catch(() => Effect.void));

  if (listHidden) {
    const rows = yield* sql<{ store_id: string; name: string }>`
      SELECT store_id, name FROM merch_stores WHERE COALESCE(listed, 1) = 0 ORDER BY name`;
    yield* Effect.logInfo(`${rows.length} hidden store(s):`);
    for (const r of rows) yield* Effect.logInfo(`  ${r.store_id}  ${r.name}`);
    return;
  }

  if (!storeId || (listedRaw !== "0" && listedRaw !== "1")) {
    yield* Effect.logError(
      "Usage: --store <store_id> --listed 0|1   (or --list-hidden)",
    );
    return;
  }

  const listed = listedRaw === "1" ? 1 : 0;
  const res =
    yield* sql`UPDATE merch_stores SET listed = ${listed} WHERE store_id = ${storeId}`;
  const changed = (res as { rowsAffected?: number }).rowsAffected ?? 0;
  yield* Effect.logInfo(
    changed > 0
      ? `Set ${storeId} listed=${listed}. Re-emit the read-model to publish.`
      : `No store with store_id=${storeId}.`,
  );
});

Effect.runPromise(
  program.pipe(Effect.provide(LibsqlClient.layer({ url: DB_URL }))),
).catch((err) => {
  console.error("setStoreListed failed:", err);
  process.exitCode = 1;
});
