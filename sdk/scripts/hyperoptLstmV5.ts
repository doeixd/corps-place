import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Hyperparameter Search for LSTM V5
 *
 * Performs grid/random search over hyperparameter space and identifies
 * best configurations based on validation loss.
 */

// Search space
const SEARCH_SPACE = {
  lstm1_units: [48, 64, 96],
  lstm2_units: [24, 32, 48],
  dropout_lstm: [0.2, 0.3, 0.4],
  recurrent_dropout: [0.2, 0.3, 0.4],
  dropout_dense1: [0.3, 0.4, 0.5],
  dropout_dense2: [0.2, 0.3, 0.4],
  l2_reg: [0.00001, 0.0001, 0.001],
  learning_rate: [0.0001, 0.0003, 0.0005, 0.001],
  batch_size: [16, 32, 64],
};

const RESULTS_DIR = "./results";
const RESULTS_FILE = path.join(RESULTS_DIR, "lstm-hyperparam-search.json");
const LOG_CSV = path.join(RESULTS_DIR, "lstm-v5-training-log.csv");

// Config
const MAX_TRIALS = parseInt(process.env.MAX_TRIALS || "50", 10);
const QUICK_EPOCHS = 50; // Run quick trials for faster search
const QUICK_PATIENCE = 10;
const SEARCH_MODE = process.env.SEARCH_MODE || "random"; // 'grid' or 'random'

interface TrialConfig {
  lstm1_units: number;
  lstm2_units: number;
  dropout_lstm: number;
  recurrent_dropout: number;
  dropout_dense1: number;
  dropout_dense2: number;
  l2_reg: number;
  learning_rate: number;
  batch_size: number;
}

interface TrialResult {
  trialId: number;
  config: TrialConfig;
  finalValLoss: number;
  finalTrainLoss: number;
  epochsCompleted: number;
  status: "success" | "failed" | "pruned";
  errorMessage?: string;
}

function ensureResultsDir() {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function generateRandomConfig(): TrialConfig {
  return {
    lstm1_units: randomChoice(SEARCH_SPACE.lstm1_units),
    lstm2_units: randomChoice(SEARCH_SPACE.lstm2_units),
    dropout_lstm: randomChoice(SEARCH_SPACE.dropout_lstm),
    recurrent_dropout: randomChoice(SEARCH_SPACE.recurrent_dropout),
    dropout_dense1: randomChoice(SEARCH_SPACE.dropout_dense1),
    dropout_dense2: randomChoice(SEARCH_SPACE.dropout_dense2),
    l2_reg: randomChoice(SEARCH_SPACE.l2_reg),
    learning_rate: randomChoice(SEARCH_SPACE.learning_rate),
    batch_size: randomChoice(SEARCH_SPACE.batch_size),
  };
}

function* generateGridConfigs(): Generator<TrialConfig> {
  for (const lstm1 of SEARCH_SPACE.lstm1_units) {
    for (const lstm2 of SEARCH_SPACE.lstm2_units) {
      for (const dropout of SEARCH_SPACE.dropout_lstm) {
        for (const recDropout of SEARCH_SPACE.recurrent_dropout) {
          for (const drop1 of SEARCH_SPACE.dropout_dense1) {
            for (const drop2 of SEARCH_SPACE.dropout_dense2) {
              for (const l2 of SEARCH_SPACE.l2_reg) {
                for (const lr of SEARCH_SPACE.learning_rate) {
                  for (const batch of SEARCH_SPACE.batch_size) {
                    yield {
                      lstm1_units: lstm1,
                      lstm2_units: lstm2,
                      dropout_lstm: dropout,
                      recurrent_dropout: recDropout,
                      dropout_dense1: drop1,
                      dropout_dense2: drop2,
                      l2_reg: l2,
                      learning_rate: lr,
                      batch_size: batch,
                    };
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

async function runTrial(trialId: number, config: TrialConfig): Promise<TrialResult> {
  console.log(`\n=== Trial ${trialId} ===`);
  console.log(JSON.stringify(config, null, 2));

  const args = [
    "tsx",
    "src/training/trainModelV5.ts",
    "--epochs",
    QUICK_EPOCHS.toString(),
    "--patience",
    QUICK_PATIENCE.toString(),
    "--lstm1-units",
    config.lstm1_units.toString(),
    "--lstm2-units",
    config.lstm2_units.toString(),
    "--dropout-lstm",
    config.dropout_lstm.toString(),
    "--recurrent-dropout",
    config.recurrent_dropout.toString(),
    "--dropout-dense1",
    config.dropout_dense1.toString(),
    "--dropout-dense2",
    config.dropout_dense2.toString(),
    "--l2-reg",
    config.l2_reg.toString(),
    "--lr",
    config.learning_rate.toString(),
    "--batch",
    config.batch_size.toString(),
    "--log-csv",
    LOG_CSV,
    "--trial-id",
    `trial_${trialId}`,
  ];

  return new Promise((resolve) => {
    const child = spawn("npx", args, {
      stdio: "inherit",
      shell: true,
    });

    child.on("error", (error) => {
      console.error(`Trial ${trialId} failed to start:`, error);
      resolve({
        trialId,
        config,
        finalValLoss: Infinity,
        finalTrainLoss: Infinity,
        epochsCompleted: 0,
        status: "failed",
        errorMessage: error.message,
      });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        console.error(`Trial ${trialId} exited with code ${code}`);
        resolve({
          trialId,
          config,
          finalValLoss: Infinity,
          finalTrainLoss: Infinity,
          epochsCompleted: 0,
          status: "failed",
          errorMessage: `Exit code ${code}`,
        });
        return;
      }

      // Parse last line from CSV to get final losses
      try {
        const csvContent = fs.readFileSync(LOG_CSV, "utf-8");
        const lines = csvContent.trim().split("\n");
        const lastLine = lines[lines.length - 1]!;
        const parts = lastLine.split(",");

        // CSV format: trial_id,epoch,train_loss,val_loss,learning_rate,elapsed_sec,lstm1_units,lstm2_units,dropout,batch_size
        const finalTrainLoss = parseFloat(parts[2]!);
        const finalValLoss = parseFloat(parts[3]!);
        const epochsCompleted = parseInt(parts[1]!, 10);

        console.log(`Trial ${trialId} completed: val_loss=${finalValLoss.toFixed(6)}`);

        resolve({
          trialId,
          config,
          finalValLoss,
          finalTrainLoss,
          epochsCompleted,
          status: "success",
        });
      } catch (error) {
        console.error(`Trial ${trialId} completed but failed to parse results:`, error);
        resolve({
          trialId,
          config,
          finalValLoss: Infinity,
          finalTrainLoss: Infinity,
          epochsCompleted: 0,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });
  });
}

async function main() {
  ensureResultsDir();

  console.log("=".repeat(60));
  console.log("LSTM V5 Hyperparameter Search");
  console.log("=".repeat(60));
  console.log(`Search mode: ${SEARCH_MODE}`);
  console.log(`Max trials: ${MAX_TRIALS}`);
  console.log(`Quick epochs: ${QUICK_EPOCHS}`);
  console.log(`Results will be saved to: ${RESULTS_FILE}`);
  console.log("=".repeat(60));

  // Clear previous log CSV
  if (fs.existsSync(LOG_CSV)) {
    console.log(`Clearing previous training log: ${LOG_CSV}`);
    fs.unlinkSync(LOG_CSV);
  }

  const results: TrialResult[] = [];
  let bestValLoss = Infinity;
  let bestTrialId = -1;

  if (SEARCH_MODE === "grid") {
    // Grid search
    const configGen = generateGridConfigs();
    let trialNum = 0;

    for (const config of configGen) {
      if (trialNum >= MAX_TRIALS) break;

      const result = await runTrial(trialNum, config);
      results.push(result);

      if (result.status === "success" && result.finalValLoss < bestValLoss) {
        bestValLoss = result.finalValLoss;
        bestTrialId = result.trialId;
        console.log(`\n🎯 New best! Trial ${bestTrialId} with val_loss=${bestValLoss.toFixed(6)}\n`);
      }

      // Save intermediate results
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
      trialNum++;
    }
  } else {
    // Random search
    const seenConfigs = new Set<string>();

    for (let i = 0; i < MAX_TRIALS; i++) {
      let config = generateRandomConfig();
      let configKey = JSON.stringify(config);

      // Avoid duplicate configs
      let attempts = 0;
      while (seenConfigs.has(configKey) && attempts < 10) {
        config = generateRandomConfig();
        configKey = JSON.stringify(config);
        attempts++;
      }

      seenConfigs.add(configKey);

      const result = await runTrial(i, config);
      results.push(result);

      if (result.status === "success" && result.finalValLoss < bestValLoss) {
        bestValLoss = result.finalValLoss;
        bestTrialId = result.trialId;
        console.log(`\n🎯 New best! Trial ${bestTrialId} with val_loss=${bestValLoss.toFixed(6)}\n`);
      }

      // Early pruning: if val_loss > 1.5x best after 20 epochs, skip (future enhancement)

      // Save intermediate results
      fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Hyperparameter Search Complete");
  console.log("=".repeat(60));

  // Sort by val_loss
  const successfulTrials = results.filter((r) => r.status === "success");
  successfulTrials.sort((a, b) => a.finalValLoss - b.finalValLoss);

  console.log(`\nTop 5 configurations:`);
  for (let i = 0; i < Math.min(5, successfulTrials.length); i++) {
    const trial = successfulTrials[i]!;
    console.log(`\n#${i + 1} - Trial ${trial.trialId}: val_loss=${trial.finalValLoss.toFixed(6)}`);
    console.log(JSON.stringify(trial.config, null, 2));
  }

  // Save best hyperparameters
  if (successfulTrials.length > 0) {
    const bestTrial = successfulTrials[0]!;
    const bestHyperparams = {
      best_trial_id: bestTrial.trialId,
      best_val_loss: bestTrial.finalValLoss,
      config: bestTrial.config,
      timestamp: new Date().toISOString(),
    };

    const bestParamsFile = path.join(RESULTS_DIR, "lstm-best-hyperparams.json");
    fs.writeFileSync(bestParamsFile, JSON.stringify(bestHyperparams, null, 2));
    console.log(`\n✅ Best hyperparameters saved to: ${bestParamsFile}`);
  }

  console.log(`\n📊 Full results saved to: ${RESULTS_FILE}`);
  console.log(`📈 Training logs saved to: ${LOG_CSV}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});
