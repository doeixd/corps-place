// Seed the merch_stores table from the merch scan (docs/plans/MERCH_PLAN.md §21 M0).
//
// Effect program: corps stores come from the corps.merch_* columns (SqlClient);
// vendor stores (VENDOR_SEEDS) are classified on the fly with scanTarget (Effect,
// Browserbase fallback via layer). cart_capability is derived from the platform.
//
// Usage (from sdk/, with BROWSERBASE_API_KEY in repo-root .env):
//   npx tsx scripts/seedMerchStores.ts            # upsert merch_stores
//   npx tsx scripts/seedMerchStores.ts --dry-run  # log only

import { Effect, Layer } from "effect";
import * as Match from "effect/Match";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadRepoEnv } from "./scriptEnv.js";
import { BrowserbaseServiceLive } from "../src/browserbaseService.js";
import {
  scanTarget,
  VENDOR_SEEDS,
  type MerchPlatform,
} from "../src/merchScan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const dryRun = process.argv.includes("--dry-run");
const DB_URL =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${resolve(SDK_DIR, "dci-relational.db")}`;

/** Platforms we can build a pre-filled cart link for → 'prefill', else 'link'. */
const cartCapability = (
  platform: MerchPlatform | string | null,
): "prefill" | "link" =>
  Match.value(platform).pipe(
    Match.when("shopify", () => "prefill" as const),
    Match.when("woocommerce", () => "prefill" as const),
    Match.when("bigcommerce", () => "prefill" as const),
    Match.when("bigcartel", () => "prefill" as const),
    Match.orElse(() => "link" as const),
  );

/** Ensure a stored URL has a scheme so downstream new URL() never throws. */
const ensureScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

const vendorSlug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

interface StoreRow {
  store_id: string;
  corps_key: string | null;
  name: string;
  kind: "corps" | "vendor";
  platform: string | null;
  store_url: string;
  cart_capability: "prefill" | "link";
}

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS merch_stores (
    store_id TEXT PRIMARY KEY, corps_key TEXT, name TEXT NOT NULL, kind TEXT NOT NULL,
    platform TEXT, store_url TEXT NOT NULL, cart_capability TEXT, cart_url_template TEXT,
    product_count INTEGER DEFAULT 0, last_synced_at TEXT, sync_status TEXT,
    listed INTEGER NOT NULL DEFAULT 1
  )`;
  // Self-heal DBs created before `listed` existed (ignore "duplicate column").
  yield* sql
    .unsafe(
      `ALTER TABLE merch_stores ADD COLUMN listed INTEGER NOT NULL DEFAULT 1`,
    )
    .pipe(Effect.catch(() => Effect.void));

  const stores: StoreRow[] = [];

  // --- Corps stores: from the scan columns -------------------------------
  const corpsRows = yield* sql<{
    corps_key: string;
    name: string;
    website: string | null;
    merch_url: string | null;
    merch_platform: string | null;
  }>`SELECT corps_key, name, website, merch_url, merch_platform
       FROM corps WHERE has_merch = 1 AND merch_platform IS NOT NULL`;
  for (const r of corpsRows) {
    const storeUrl = r.merch_url ?? r.website;
    if (!storeUrl) continue; // invariant: store_url NOT NULL
    stores.push({
      store_id: r.corps_key,
      corps_key: r.corps_key,
      name: r.name,
      kind: "corps",
      platform: r.merch_platform,
      store_url: ensureScheme(storeUrl),
      cart_capability: cartCapability(r.merch_platform),
    });
  }

  // --- Vendor stores: classify on the fly (scanTarget Effect) ------------
  const vendorResults = yield* Effect.forEach(
    VENDOR_SEEDS,
    (v) => scanTarget(v),
    { concurrency: 4 },
  );
  for (let i = 0; i < VENDOR_SEEDS.length; i++) {
    const vendor = VENDOR_SEEDS[i]!;
    const result = vendorResults[i]!;
    if (!result.hasMerch || result.platform === "none") {
      yield* Effect.logInfo(`  skip vendor (no merch): ${vendor.name}`);
      continue;
    }
    stores.push({
      store_id: vendorSlug(vendor.name),
      corps_key: null,
      name: vendor.name,
      kind: "vendor",
      platform: result.platform,
      store_url: ensureScheme(result.merchUrl ?? result.finalUrl ?? vendor.website),
      cart_capability: cartCapability(result.platform),
    });
  }

  yield* Effect.logInfo(
    `Seeding ${stores.length} merch stores (dryRun=${dryRun}).`,
  );
  for (const s of stores) {
    yield* Effect.logInfo(
      `  [${s.kind}] ${s.name} — ${s.platform} → ${s.cart_capability} (${s.store_url})`,
    );
  }

  if (dryRun) {
    yield* Effect.logInfo("Dry run — no writes.");
    return;
  }

  yield* Effect.forEach(
    stores,
    (s) =>
      sql`INSERT INTO merch_stores
            (store_id, corps_key, name, kind, platform, store_url, cart_capability, product_count, sync_status)
          VALUES (${s.store_id}, ${s.corps_key}, ${s.name}, ${s.kind}, ${s.platform}, ${s.store_url}, ${s.cart_capability}, 0, 'pending')
          ON CONFLICT(store_id) DO UPDATE SET
            corps_key = excluded.corps_key, name = excluded.name, kind = excluded.kind,
            platform = excluded.platform, store_url = excluded.store_url, cart_capability = excluded.cart_capability`,
    { discard: true },
  );
  yield* Effect.logInfo(`Upserted ${stores.length} merch_stores rows.`);
});

const SqlLive = LibsqlClient.layer({ url: DB_URL });
const BrowserbaseLive = process.env.BROWSERBASE_API_KEY
  ? BrowserbaseServiceLive
  : Layer.empty;

Effect.runPromise(
  program.pipe(Effect.provide(Layer.mergeAll(SqlLive, BrowserbaseLive))),
).catch((err) => {
  console.error("seedMerchStores failed:", err);
  process.exitCode = 1;
});
