// Pull data artifacts from R2 (replaces the Turso read-model sync).
//
// Usage (run from sdk/):
//   npx tsx scripts/pullData.ts                 # all datasets
//   npx tsx scripts/pullData.ts read-model      # one or more by name
//   npx tsx scripts/pullData.ts relational
//
// For `read-model` the file is installed into the inactive A/B slot and the
// `.active` pointer is flipped last, so a running server hot-swaps with no
// downtime. Other datasets are written to their resolved local path atomically.
// Credentials/endpoint load from the repo-root .env (R2_ENDPOINT, R2_BUCKET,
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).
import { loadEnv } from "./loadEnv.js";
loadEnv();

import { DATASETS, resolveDatasets, downloadDataset } from "../src/dataSync.js";

const main = async () => {
  const names = resolveDatasets(process.argv.slice(2));
  console.error(`[pull-data] datasets: ${names.join(", ")}`);
  for (const name of names) {
    await downloadDataset(DATASETS[name]);
  }
  console.error("[pull-data] complete.");
};

main().catch((err) => {
  console.error("[pull-data] FAILED:", err?.message ?? err);
  process.exit(1);
});
