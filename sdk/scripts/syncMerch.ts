// Merch refresh pipeline — seed stores → ingest products → emit read-model.
// Designed to run on the box (or a dedicated ingest container) where the 3.4 GB
// dci-relational.db lives. See docs/MERCH_DEPLOY.md for the full deployment model.
//
// Modes:
//   (local, default)  emit a local JSON snapshot (dev box / inspection)
//   --publish <env>   emit the read-model, push it to R2, then redeploy the app
//                     via the Coolify API so it pulls the new generation on boot
//
// Usage (from sdk/):
//   npx tsx scripts/syncMerch.ts                          # seed→ingest→local emit
//   npx tsx scripts/syncMerch.ts --scan                  # + re-detect platforms first
//   npx tsx scripts/syncMerch.ts --publish prod          # ...→ emit → push R2 → redeploy prod
//   npx tsx scripts/syncMerch.ts --publish dev --no-restart
//
// Merch rides the read-model (emit writes rm_merch_* tables; the app reads them via
// MerchDirectoryService.readOrBuild), so --publish makes it live in prod. The read-model
// is distributed via R2 (scripts/pushData.ts ↔ pullData.ts), not Turso. See
// docs/MERCH_DEPLOY.md.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = resolve(__dirname, "..");

const args = process.argv.slice(2);
const withScan = args.includes("--scan");
const noRestart = args.includes("--no-restart");
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const publishEnv = opt("--publish") as "prod" | "dev" | undefined;
const snapshot = opt("--snapshot") ?? "../public/read-model";

if (publishEnv && publishEnv !== "prod" && publishEnv !== "dev") {
  console.error(`--publish must be 'prod' or 'dev' (got '${publishEnv}')`);
  process.exit(2);
}

const run = (
  label: string,
  scriptArgs: string[],
  env: NodeJS.ProcessEnv = process.env,
) => {
  console.log(`\n=== syncMerch: ${label} ===`);
  execFileSync("npx", ["tsx", ...scriptArgs], {
    cwd: SDK_DIR,
    stdio: "inherit",
    env,
  });
};

// Per-env Coolify app UUID, overridable via env. Defaults match the live box
// (DEPLOYMENT_REALITY.md §3); override if those ever change.
const publishConfig = (envName: "prod" | "dev") => {
  const isProd = envName === "prod";
  const appUuid =
    process.env[isProd ? "COOLIFY_PROD_APP_UUID" : "COOLIFY_DEV_APP_UUID"] ??
    (isProd ? "if4odqr9tkybb0uezey95mid" : "mjx3xnpbm0bpwo80ts6t2mys");
  return { appUuid };
};

const redeployViaCoolify = async (appUuid: string) => {
  const apiUrl = process.env.COOLIFY_API_URL ?? "http://localhost:8000";
  const apiToken = process.env.COOLIFY_API_TOKEN;
  if (!apiToken) {
    console.warn(
      "\n⚠️ COOLIFY_API_TOKEN not set — skipping redeploy. The read-model was pushed to R2,\n" +
        "   but the app picks up the new generation when it boots (entrypoint pull) or on its\n" +
        "   next scheduled pull. Redeploy/restart the app manually to pick it up immediately.",
    );
    return;
  }
  const url = `${apiUrl}/api/v1/deploy?uuid=${encodeURIComponent(appUuid)}&force=true`;
  console.log(
    `\n=== syncMerch: redeploy ${appUuid} via Coolify (${apiUrl}) ===`,
  );
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `Coolify redeploy failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  console.log(
    "redeploy triggered — zero-downtime rollout picks up the new read-model generation.",
  );
};

const main = async () => {
  if (withScan)
    run("detect platforms (scan)", [
      "scripts/scanMerch.ts",
      "--concurrency",
      "6",
    ]);
  run("seed stores", ["scripts/seedMerchStores.ts"]);
  run("ingest products", ["scripts/ingestMerch.ts", "--concurrency", "6"]);
  // Regenerate the image-host allowlist from the fresh catalog (app/lib/
  // merch-image-hosts.generated.ts). Commit it so a code deploy picks it up —
  // new stores' image hosts otherwise can't proxy. warmMerchImages reports gaps.
  run("gen image-host allowlist", ["scripts/genMerchImageHosts.ts"]);

  if (!publishEnv) {
    run("emit read-model (local snapshot)", [
      "scripts/emitReadModel.ts",
      "--json-snapshot",
      snapshot,
    ]);
    console.log("\nsyncMerch: done (local snapshot).");
    return;
  }

  const { appUuid } = publishConfig(publishEnv);
  run("emit read-model", ["scripts/emitReadModel.ts", "--json-snapshot", snapshot]);
  run("push read-model → R2", ["scripts/pushData.ts", "read-model"]);
  if (!noRestart) await redeployViaCoolify(appUuid);
  console.log(`\nsyncMerch: done (published → ${publishEnv}).`);
};

main().catch((err) => {
  console.error("\nsyncMerch failed:", (err as Error)?.message ?? err);
  process.exitCode = 1;
});
