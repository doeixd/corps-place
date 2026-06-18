import * as fs from "node:fs";

const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;
const OUTPUT_STRIDE = 3;

type Caption = (typeof CAPTIONS)[number];

type RawEntry = {
  corps_key: string;
  predicted?: Partial<Record<Caption, number>>;
  outputs?: number[]; // expected [GE1_p10, GE1_p50, GE1_p90, ...]
};

type InputFile = {
  entries: RawEntry[];
};

type OutputFile = {
  entries: Array<{ corps_key: string; predicted: Partial<Record<Caption, number>> }>;
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (k: string, def?: string) => {
    const idx = argv.indexOf(k);
    return idx >= 0 ? argv[idx + 1] : def;
  };
  return {
    input: get("--input")!,
    out: get("--out", "./bayesian-preds.json")!,
  };
}

function outputsToPredicted(outputs: number[]) {
  const predicted: Partial<Record<Caption, number>> = {};
  for (let i = 0; i < CAPTIONS.length; i++) {
    const idx = i * OUTPUT_STRIDE + 1;
    predicted[CAPTIONS[i]!] = outputs[idx] ?? outputs[i * OUTPUT_STRIDE] ?? 0;
  }
  return predicted;
}

function main() {
  const args = parseArgs();
  if (!args.input) throw new Error("--input is required");

  const payload = JSON.parse(fs.readFileSync(args.input, "utf-8")) as InputFile;
  const outputEntries: OutputFile["entries"] = [];

  for (const entry of payload.entries) {
    if (!entry.corps_key) continue;
    if (entry.predicted) {
      outputEntries.push({ corps_key: entry.corps_key, predicted: entry.predicted });
      continue;
    }
    if (entry.outputs && entry.outputs.length >= CAPTIONS.length * OUTPUT_STRIDE) {
      outputEntries.push({ corps_key: entry.corps_key, predicted: outputsToPredicted(entry.outputs) });
      continue;
    }
  }

  const output: OutputFile = { entries: outputEntries };
  fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outputEntries.length} prediction entries to ${args.out}`);
}

main();
