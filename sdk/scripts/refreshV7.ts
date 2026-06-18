// scripts/refreshV7.ts
import { execSync } from "child_process";

/**
 * MASTER REFRESH SCRIPT FOR V7 MODEL
 * 
 * This script automates the full data pipeline:
 * 1. Ingest new 2024 scores
 * 2. Compute Elo ratings (Judge/Corps)
 * 3. Build Show Aggregates (Comparative Context)
 * 4. Regenerate ML Sequences
 */

function runCommand(command: string) {
  console.log(`\n>>> EXECUTING: ${command}`);
  try {
    execSync(command, { stdio: "inherit" });
  } catch (error) {
    console.error(`\n!!! ERROR executing ${command}`);
    process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const fineTune = argv.includes("--fine-tune");
  const modelDir = argv.indexOf("--model-dir") >= 0 ? argv[argv.indexOf("--model-dir") + 1] : "models/v7_curriculum/best";

  const startTime = Date.now();
  console.log("====================================================");
  console.log("   V7 PRODUCTION PIPELINE REFRESH   ");
  if (fineTune) console.log(`   (WITH FINE-TUNING FROM: ${modelDir})    `);
  console.log("====================================================");

  // 1. Ingest latest 2024 data
  runCommand("npx tsx scripts/reingest2024.ts");

  // 2. Refresh dynamic metrics (Elo)
  runCommand("npx tsx scripts/computeEloRatingsV7.ts");

  // 3. Refresh comparative context (Aggregates)
  runCommand("npx tsx scripts/buildShowAggregatesV7.ts");

  // 4. Update the ML training/inference table
  runCommand("npx tsx scripts/buildMlSequencesV7All.ts");

  // 5. Optional Fine-Tuning
  if (fineTune) {
    console.log("\n>>> STARTING FINE-TUNING...");
    // Fine-tune for 10 epochs with a lower learning rate
    runCommand(`npx tsx src/training/trainModelV7.ts --load-model ${modelDir} --epochs 10 --lr 0.0001 --warmup-epochs 0 --trial-id fine_tune_refresh`);
  }

  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  console.log("\n====================================================");
  console.log(`   REFRESH COMPLETE in ${duration} minutes   `);
  console.log("====================================================");
  console.log("\nUsage:");
  console.log("  npx tsx scripts/refreshV7.ts                 # Data only");
  console.log("  npx tsx scripts/refreshV7.ts --fine-tune     # Data + 10 Fine-tune epochs");
}

main().catch(console.error);
