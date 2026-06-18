import * as fs from "node:fs";

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    a: get("--a")!,
    b: get("--b")!,
    bootstrap: Number(get("--bootstrap", "1000")),
  };
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values: number[], avg: number) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function normalCdf(x: number) {
  // Abramowitz and Stegun approximation for erf
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - prob : prob;
}

function bootstrapCi(diffs: number[], nSamples: number) {
  const means: number[] = [];
  for (let i = 0; i < nSamples; i++) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j++) {
      const idx = Math.floor(Math.random() * diffs.length);
      sum += diffs[idx]!;
    }
    means.push(sum / diffs.length);
  }
  means.sort((a, b) => a - b);
  const lower = means[Math.floor(0.025 * means.length)]!;
  const upper = means[Math.floor(0.975 * means.length)]!;
  return { lower, upper };
}

function main() {
  const args = parseArgs();
  if (!args.a || !args.b) throw new Error("--a and --b are required");

  const aFile = JSON.parse(fs.readFileSync(args.a, "utf-8")) as { absErrors?: number[]; errors?: number[] };
  const bFile = JSON.parse(fs.readFileSync(args.b, "utf-8")) as { absErrors?: number[]; errors?: number[] };

  const aErrors = aFile.absErrors ?? aFile.errors ?? [];
  const bErrors = bFile.absErrors ?? bFile.errors ?? [];

  if (aErrors.length === 0 || bErrors.length === 0) {
    throw new Error("Input files must contain errors or absErrors arrays.");
  }
  if (aErrors.length !== bErrors.length) {
    throw new Error("Inputs must have the same number of errors for paired comparison.");
  }

  const diffs = aErrors.map((value, idx) => value - bErrors[idx]!);
  const meanA = mean(aErrors);
  const meanB = mean(bErrors);
  const meanDiff = mean(diffs);
  const stdDiff = std(diffs, meanDiff);
  const tStat = stdDiff === 0 ? 0 : meanDiff / (stdDiff / Math.sqrt(diffs.length));
  const pValue = 2 * (1 - normalCdf(Math.abs(tStat)));
  const ci = bootstrapCi(diffs, args.bootstrap);

  console.log("Paired comparison (A - B)");
  console.log(`n=${diffs.length}`);
  console.log(`meanA=${meanA.toFixed(6)} meanB=${meanB.toFixed(6)}`);
  console.log(`meanDiff=${meanDiff.toFixed(6)} t=${tStat.toFixed(4)} p=${pValue.toFixed(6)}`);
  console.log(`bootstrap95%=[${ci.lower.toFixed(6)}, ${ci.upper.toFixed(6)}]`);
}

main();
