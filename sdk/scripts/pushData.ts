// Push data artifacts to R2 (replaces the Turso read-model sync).
//
// Usage (run from sdk/):
//   npx tsx scripts/pushData.ts                 # all datasets
//   npx tsx scripts/pushData.ts read-model      # one or more by name
//   npx tsx scripts/pushData.ts relational media-cache
//
// Datasets: read-model, relational, media-cache (see src/dataSync.ts).
// Credentials/endpoint load from the repo-root .env (R2_ENDPOINT, R2_BUCKET,
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).
import { loadEnv } from "./loadEnv.js";
loadEnv();

import { DATASETS, resolveDatasets, uploadDataset } from "../src/dataSync.js";

const main = async () => {
  const names = resolveDatasets(process.argv.slice(2));
  console.error(`[push-data] datasets: ${names.join(", ")}`);
  for (const name of names) {
    await uploadDataset(DATASETS[name]);
  }
  console.error("[push-data] complete.");
};

main().catch((err) => {
  console.error("[push-data] FAILED:", err?.message ?? err);
  process.exit(1);
});
