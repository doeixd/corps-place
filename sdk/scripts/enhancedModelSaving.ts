/**
 * Enhanced Model Saving - Add detailed metrics and analysis to saved models
 *
 * This script adds:
 * 1. Training history (all epochs)
 * 2. Per-caption breakdown
 * 3. Test set predictions
 * 4. Error analysis
 * 5. Comparison to baseline
 *
 * Usage: Import and call from training scripts
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface EpochHistory {
  epoch: number;
  trainLoss: number;
  valMaePoints: number;
  valDeltaMae: number;
  valRecapMae: number;
  valCategoryMae: number;
  valTotalMae: number;
  coverage: number;
  widthNorm: number;
  learningRate: number;
  timestamp: string;
}

export interface CaptionMetrics {
  caption: string;
  deltaMae: number;
  recapMae: number;
  coverage: number;
  width: number;
  vsBaseline: number;
  sampleCount: number;
}

export interface PredictionExample {
  corpsKey: string;
  competitionSlug: string;
  date: string;
  predicted: number[];
  actual: number[];
  error: number[];
  mae: number;
  historyLength: number;
}

export interface ModelReport {
  // Metadata
  modelVersion: string;
  trainedAt: string;
  totalEpochs: number;
  bestEpoch: number;
  trainingDuration: number; // seconds

  // Hyperparameters
  config: Record<string, any>;

  // Performance Summary
  finalMetrics: {
    valMae: number;
    testMae: number;
    coverage: number;
    vsBaseline: number;
  };

  // Training History
  history: EpochHistory[];

  // Caption Breakdown
  captionMetrics: CaptionMetrics[];

  // Error Analysis
  errorAnalysis: {
    byHistoryLength: Array<{
      historyLength: number;
      mae: number;
      coverage: number;
      sampleCount: number;
    }>;
    byDivision: Array<{
      division: string;
      mae: number;
      coverage: number;
      sampleCount: number;
    }>;
  };

  // Test Predictions
  testPredictions: {
    bestExamples: PredictionExample[];  // Top 10 lowest error
    worstExamples: PredictionExample[]; // Top 10 highest error
    randomExamples: PredictionExample[]; // 20 random samples
  };

  // Comparison
  comparison?: {
    baselineModel: string;
    baselineMetrics: Record<string, number>;
    improvement: Record<string, number>;
  };
}

/**
 * Accumulator for building training history during training loop
 */
export class TrainingHistoryAccumulator {
  private history: EpochHistory[] = [];
  private startTime: number = Date.now();

  addEpoch(data: EpochHistory) {
    this.history.push(data);
  }

  getHistory(): EpochHistory[] {
    return this.history;
  }

  getDuration(): number {
    return (Date.now() - this.startTime) / 1000;
  }

  save(filePath: string) {
    fs.writeFileSync(filePath, JSON.stringify(this.history, null, 2));
  }
}

/**
 * Save enhanced model report with all metrics
 */
export function saveEnhancedModelReport(
  modelDir: string,
  report: ModelReport
) {
  const reportPath = path.join(modelDir, "model-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  // Also save CSV for easy analysis
  const historyPath = path.join(modelDir, "training-history.csv");
  const historyCsv = [
    "epoch,trainLoss,valMae,coverage,learningRate",
    ...report.history.map(h =>
      `${h.epoch},${h.trainLoss},${h.valMaePoints},${h.coverage},${h.learningRate}`
    )
  ].join("\n");
  fs.writeFileSync(historyPath, historyCsv);

  // Caption breakdown CSV
  const captionPath = path.join(modelDir, "caption-metrics.csv");
  const captionCsv = [
    "caption,mae,coverage,width,vsBaseline",
    ...report.captionMetrics.map(c =>
      `${c.caption},${c.deltaMae},${c.coverage},${c.width},${c.vsBaseline}`
    )
  ].join("\n");
  fs.writeFileSync(captionPath, captionCsv);

  console.log(`\nSaved enhanced model report to ${reportPath}`);
  console.log(`  - Training history: ${historyPath}`);
  console.log(`  - Caption metrics: ${captionPath}`);
}

/**
 * Load and compare two model reports
 */
export function compareModels(
  modelDir1: string,
  modelDir2: string
): Record<string, any> {
  const report1 = JSON.parse(
    fs.readFileSync(path.join(modelDir1, "model-report.json"), "utf-8")
  ) as ModelReport;

  const report2 = JSON.parse(
    fs.readFileSync(path.join(modelDir2, "model-report.json"), "utf-8")
  ) as ModelReport;

  return {
    model1: {
      version: report1.modelVersion,
      valMae: report1.finalMetrics.valMae,
      testMae: report1.finalMetrics.testMae,
      coverage: report1.finalMetrics.coverage,
    },
    model2: {
      version: report2.modelVersion,
      valMae: report2.finalMetrics.valMae,
      testMae: report2.finalMetrics.testMae,
      coverage: report2.finalMetrics.coverage,
    },
    improvement: {
      valMae: report1.finalMetrics.valMae - report2.finalMetrics.valMae,
      testMae: report1.finalMetrics.testMae - report2.finalMetrics.testMae,
      coverage: report2.finalMetrics.coverage - report1.finalMetrics.coverage,
    },
    captionComparison: report1.captionMetrics.map((c1, i) => ({
      caption: c1.caption,
      model1Mae: c1.deltaMae,
      model2Mae: report2.captionMetrics[i]?.deltaMae,
      improvement: c1.deltaMae - (report2.captionMetrics[i]?.deltaMae ?? 0),
    })),
  };
}

/**
 * Generate markdown summary report
 */
export function generateMarkdownReport(report: ModelReport): string {
  const md = [];

  md.push(`# Model Report: ${report.modelVersion}`);
  md.push(`\nTrained: ${report.trainedAt}`);
  md.push(`Duration: ${(report.trainingDuration / 3600).toFixed(2)} hours`);
  md.push(`Best Epoch: ${report.bestEpoch} / ${report.totalEpochs}`);

  md.push(`\n## Performance Summary\n`);
  md.push(`| Metric | Value |`);
  md.push(`|--------|-------|`);
  md.push(`| Validation MAE | ${report.finalMetrics.valMae.toFixed(4)} pts |`);
  md.push(`| Test MAE | ${report.finalMetrics.testMae.toFixed(4)} pts |`);
  md.push(`| Coverage | ${(report.finalMetrics.coverage * 100).toFixed(1)}% |`);
  md.push(`| vs Baseline | ${report.finalMetrics.vsBaseline.toFixed(2)} pts better |`);

  md.push(`\n## Per-Caption Performance\n`);
  md.push(`| Caption | MAE | Coverage | Width |`);
  md.push(`|---------|-----|----------|-------|`);
  report.captionMetrics.forEach(c => {
    md.push(`| ${c.caption} | ${c.deltaMae.toFixed(3)} | ${(c.coverage * 100).toFixed(1)}% | ${c.width.toFixed(2)} |`);
  });

  md.push(`\n## Error Analysis\n`);
  md.push(`### By History Length\n`);
  md.push(`| History | MAE | Coverage | Samples |`);
  md.push(`|---------|-----|----------|---------|`);
  report.errorAnalysis.byHistoryLength.forEach(h => {
    md.push(`| ${h.historyLength} shows | ${h.mae.toFixed(3)} | ${(h.coverage * 100).toFixed(1)}% | ${h.sampleCount} |`);
  });

  return md.join('\n');
}
