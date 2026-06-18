// Warm the prod image cache for every merch product image — the "ingest all the
// images" step. We don't write the cache DB directly (it's the prod container's
// bind-mounted /data/corps-place/media-cache.db); instead we ask the live image
// proxy for each image, which fetches the bytes server-side (no browser referrer,
// so hot-link-protected hosts succeed) and stores them durably. Idempotent: a
// second run is all cache hits.
//
// It also reports any image hosts that 404 — those aren't in the proxy allowlist
// yet (app/lib/media.ts IMAGE_CDN_SUFFIXES) and need adding.
//
// Usage (from sdk/):
//   npx tsx scripts/warmMerchImages.ts                       # warms https://drumcorps.app
//   MERCH_WARM_BASE=https://dev.drumcorps.app npx tsx scripts/warmMerchImages.ts
//   npx tsx scripts/warmMerchImages.ts --concurrency 12

import { createClient } from "@libsql/client";
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
const base = (process.env.MERCH_WARM_BASE ?? "https://drumcorps.app").replace(
  /\/$/,
  "",
);
const concurrency = Math.max(
  1,
  Math.min(getOpt("--concurrency") ? Number(getOpt("--concurrency")) : 8, 24),
);
// The widths the UI actually requests, so we prime the exact variant keys:
// product cards use 400 (1x) + 800 (2x); the detail page uses 720 (main image)
// and 96 (carousel thumbnails).
const WIDTHS = [400, 800, 720, 96];

const DB_URL =
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${resolve(SDK_DIR, "dci-relational.db")}`;

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "(unparseable)";
  }
};

async function main() {
  const db = createClient({ url: DB_URL });
  const { rows } = await db.execute(
    "SELECT DISTINCT image_url FROM merch_products WHERE image_url IS NOT NULL AND image_url != ''",
  );
  const urls = rows.map((r) => String(r.image_url));
  const jobs = urls.flatMap((u) => WIDTHS.map((w) => ({ u, w })));
  console.log(
    `[warm] ${urls.length} images × ${WIDTHS.length} widths = ${jobs.length} requests → ${base}`,
  );

  let ok = 0;
  let fail = 0;
  const failHosts = new Map<string, number>();

  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { u, w } = jobs[next++];
      const target = `${base}/api/media?u=${encodeURIComponent(u)}&w=${w}`;
      try {
        const res = await fetch(target);
        if (res.ok) {
          ok++;
          // Drain so the connection frees up; we don't need the bytes.
          await res.arrayBuffer();
        } else {
          fail++;
          failHosts.set(hostOf(u), (failHosts.get(hostOf(u)) ?? 0) + 1);
        }
      } catch {
        fail++;
        failHosts.set(hostOf(u), (failHosts.get(hostOf(u)) ?? 0) + 1);
      }
      if ((ok + fail) % 250 === 0)
        console.log(`[warm] ${ok + fail}/${jobs.length} (ok=${ok} fail=${fail})`);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  console.log(`[warm] done: ok=${ok} fail=${fail}`);
  if (failHosts.size > 0) {
    const ranked = [...failHosts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(
      "[warm] hosts with failures (likely not in the proxy allowlist):",
    );
    for (const [host, n] of ranked) console.log(`  ${n.toString().padStart(5)}  ${host}`);
  }
}

main().catch((err) => {
  console.error("warmMerchImages failed:", err);
  process.exitCode = 1;
});
