// Scan every corps (with a website on file) plus a seed list of drum-corps
// vendors for a merch / ecommerce footprint, and whether it's Shopify.
//
// Effect program: SqlClient (corps reads + merch_* column writes) and the
// Browserbase fallback both come from LAYERS. Targets are scanned with bounded
// concurrency; each scan never fails (errors land in the result), so the batch
// always completes. Persists to the corps table + writes a JSON/Markdown report.
//
// Usage (from sdk/, with BROWSERBASE_API_KEY in repo-root .env):
//   npx tsx scripts/scanMerch.ts --dry-run        # report only, no DB writes
//   npx tsx scripts/scanMerch.ts                  # report + persist to corps table
//   npx tsx scripts/scanMerch.ts --limit 10 --vendors-only --corps-only --concurrency 6

import { Effect, Layer, Ref } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { LibsqlClient } from "@effect/sql-libsql";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadRepoEnv } from "./scriptEnv.js";
import { BrowserbaseServiceLive } from "../src/browserbaseService.js";
import {
  scanTarget,
  VENDOR_SEEDS,
  type MerchScanTarget,
  type MerchScanResult,
} from "../src/merchScan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");
loadRepoEnv(SDK_DIR);

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(f);
const getOpt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = hasFlag("--dry-run");
const vendorsOnly = hasFlag("--vendors-only");
const corpsOnly = hasFlag("--corps-only");
const limit = getOpt("--limit") ? Number(getOpt("--limit")) : undefined;
const concurrency = Math.max(
  1,
  Math.min(getOpt("--concurrency") ? Number(getOpt("--concurrency")) : 4, 16),
);

const DB_URL =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${resolve(SDK_DIR, "dci-relational.db")}`;
const MERCH_COLUMNS = [
  "merch_url TEXT",
  "merch_platform TEXT",
  "has_merch INTEGER",
  "merch_signals TEXT",
  "merch_checked_at TEXT",
];

const flag = (r: MerchScanResult) =>
  r.platform === "shopify"
    ? "🛍️  SHOPIFY"
    : r.hasMerch
      ? `🛒 ${r.platform}`
      : r.error
        ? `⚠️ ${r.error}`
        : "—";

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Idempotent column adds (ignore "duplicate column").
  yield* Effect.forEach(
    MERCH_COLUMNS,
    (col) =>
      sql
        .unsafe(`ALTER TABLE corps ADD COLUMN ${col}`)
        .pipe(Effect.catch(() => Effect.void)),
    { discard: true },
  );

  const targets: MerchScanTarget[] = [];
  if (!vendorsOnly) {
    const rows = yield* sql<{
      corps_key: string;
      name: string;
      website: string;
    }>`
      SELECT corps_key, name, website FROM corps
       WHERE website IS NOT NULL AND TRIM(website) != ''
       ORDER BY (division_name = 'World Class') DESC, name`;
    for (const r of rows)
      targets.push({
        name: r.name,
        kind: "corps",
        corpsKey: r.corps_key,
        website: r.website,
      });
  }
  if (limit !== undefined) targets.splice(limit);
  const corpsCount = targets.length; // everything so far is a corps; vendors appended next
  if (!corpsOnly) targets.push(...VENDOR_SEEDS.map((v) => ({ ...v })));

  const hasBrowserbase = Boolean(process.env.BROWSERBASE_API_KEY);
  yield* Effect.logInfo(
    `Scanning ${targets.length} targets (${corpsCount} corps, ${targets.length - corpsCount} vendors), ` +
      `concurrency=${concurrency}, dryRun=${dryRun}, browserbase=${hasBrowserbase}`,
  );

  const checkedAt = new Date().toISOString();
  const done = yield* Ref.make(0);

  const results = yield* Effect.forEach(
    targets,
    (t) =>
      scanTarget(t, { checkedAt }).pipe(
        Effect.tap((r) =>
          Ref.updateAndGet(done, (n) => n + 1).pipe(
            Effect.flatMap((n) =>
              Effect.logInfo(
                `[${n}/${targets.length}] ${r.name} → ${flag(r)}${r.merchUrl ? ` (${r.merchUrl})` : ""}`,
              ),
            ),
          ),
        ),
      ),
    { concurrency },
  );

  if (!dryRun) {
    const corpsResults = results.filter(
      (r) => r.kind === "corps" && r.corpsKey && !r.error,
    );
    yield* Effect.forEach(
      corpsResults,
      (r) =>
        sql`UPDATE corps
              SET merch_url = ${r.merchUrl}, merch_platform = ${r.platform}, has_merch = ${r.hasMerch ? 1 : 0},
                  merch_signals = ${JSON.stringify(r.signals)}, merch_checked_at = ${r.checkedAt}
            WHERE corps_key = ${r.corpsKey!}`,
      { discard: true },
    );
    yield* Effect.logInfo(
      `Persisted merch data for ${corpsResults.length} corps.`,
    );
  } else {
    yield* Effect.logInfo("Dry run — skipped DB writes.");
  }

  // Report files (effectful fs wrapped in Effect.sync).
  const { jsonPath, mdPath } = yield* Effect.sync(() => {
    const outDir = resolve(SDK_DIR, "results", "merch-scan");
    mkdirSync(outDir, { recursive: true });
    const stamp = checkedAt.replace(/[:.]/g, "-");
    const jsonPath = resolve(outDir, `merch-scan-${stamp}.json`);
    const mdPath = resolve(outDir, `merch-scan-${stamp}.md`);
    writeFileSync(
      jsonPath,
      JSON.stringify({ checkedAt, count: results.length, results }, null, 2),
    );
    writeFileSync(mdPath, renderMarkdown(checkedAt, results));
    return { jsonPath, mdPath };
  });

  const shopify = results.filter((r) => r.platform === "shopify").length;
  const merch = results.filter((r) => r.hasMerch).length;
  const errors = results.filter((r) => r.error).length;
  yield* Effect.logInfo(
    `Wrote ${jsonPath} + ${mdPath}\n=== Summary === scanned=${results.length} hasMerch=${merch} shopify=${shopify} errors=${errors}`,
  );
});

const renderMarkdown = (
  checkedAt: string,
  results: ReadonlyArray<MerchScanResult>,
): string => {
  const lines: string[] = [`# Merch / Shopify scan — ${checkedAt}\n`];
  const byPlatform = new Map<string, number>();
  for (const r of results)
    byPlatform.set(r.platform, (byPlatform.get(r.platform) ?? 0) + 1);
  lines.push("## Platform totals\n");
  for (const [p, n] of [...byPlatform.entries()].sort((a, b) => b[1] - a[1]))
    lines.push(`- **${p}**: ${n}`);
  lines.push("");
  const section = (title: string, kind: "corps" | "vendor") => {
    const rows = results.filter((r) => r.kind === kind);
    if (rows.length === 0) return;
    lines.push(
      `## ${title}\n`,
      "| Name | Platform | Merch? | Merch URL | Signals | Notes |",
      "|---|---|---|---|---|---|",
    );
    for (const r of [...rows].sort((a, b) => a.name.localeCompare(b.name))) {
      const notes = [
        r.passwordProtected ? "password-protected" : "",
        r.parked ? "parked" : "",
        r.fetchVia === "browserbase" ? "via browserbase" : "",
        r.error ?? "",
      ]
        .filter(Boolean)
        .join("; ");
      lines.push(
        `| ${r.name} | ${r.platform} | ${r.hasMerch ? "yes" : "no"} | ${r.merchUrl ? `[link](${r.merchUrl})` : "—"} | ${r.signals.join(", ") || "—"} | ${notes || "—"} |`,
      );
    }
    lines.push("");
  };
  section("Corps", "corps");
  section("Vendors", "vendor");
  return lines.join("\n");
};

const SqlLive = LibsqlClient.layer({ url: DB_URL });
// Always provide the render layer — it renders via local Chromium (free) when
// present, falling back to Browserbase only if a key is set. No key required.
const BrowserbaseLive = BrowserbaseServiceLive;

Effect.runPromise(
  program.pipe(Effect.provide(Layer.mergeAll(SqlLive, BrowserbaseLive))),
).catch((err) => {
  console.error("scanMerch failed:", err);
  process.exitCode = 1;
});
