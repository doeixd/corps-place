import * as fs from 'node:fs';
import * as path from 'node:path';
import * as v8 from 'node:v8';

const MODEL_DIR = process.argv[2] || 'models/v9_subcaption_fixed/v9_prod_fingerprint_preseason_final2_1779976626982';
const WARMUP_RUNS = 5;
const BENCH_RUNS = 50;
const BATCH_SIZES = [1, 4, 16, 64];

const fmt = (n: number, unit = '') => `${n.toFixed(2)}${unit}`;
const fmtMs = (n: number) => fmt(n, ' ms');
const fmtMb = (n: number) => fmt(n, ' MB');
const median = (arr: number[]) => {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const p95 = (arr: number[]) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length * 0.95)]!;
};

const getRssMb = () => process.memoryUsage.rss() / 1024 / 1024;
const getHeapMb = () => {
  const s = v8.getHeapStatistics();
  return { used: s.used_heap_size / 1024 / 1024, total: s.total_heap_size / 1024 / 1024 };
};

const measureFileSizes = () => {
  const resolved = path.resolve(MODEL_DIR);
  const checkpoint = fs.existsSync(path.join(resolved, 'model.json'))
    ? resolved
    : path.join(resolved, 'best_composite');

  const modelJson = path.join(checkpoint, 'model.json');
  const weightsBin = path.join(checkpoint, 'weights.bin');

  const mjSize = fs.statSync(modelJson).size;
  const wSize = fs.statSync(weightsBin).size;

  console.log('\n=== Model File Sizes ===');
  console.log(`  model.json:  ${fmtMb(mjSize / 1024 / 1024)} (${mjSize.toLocaleString()} bytes)`);
  console.log(`  weights.bin: ${fmtMb(wSize / 1024 / 1024)} (${wSize.toLocaleString()} bytes)`);
  console.log(`  Total:       ${fmtMb((mjSize + wSize) / 1024 / 1024)}`);

  const allDirs = fs.readdirSync(resolved).filter((d) => {
    try { return fs.statSync(path.join(resolved, d)).isDirectory() && fs.existsSync(path.join(resolved, d, 'weights.bin')); } catch { return false; }
  });
  let totalAll = mjSize + wSize;
  for (const d of allDirs) {
    totalAll += fs.statSync(path.join(resolved, d, 'weights.bin')).size;
    totalAll += fs.statSync(path.join(resolved, d, 'model.json')).size;
  }
  console.log(`  All checkpoints on disk: ${fmtMb(totalAll / 1024 / 1024)} (${allDirs.length + 1} copies)`);
};

async function main() {
  console.log('=== V9 Subcaption Model Benchmark ===');
  console.log(`Model: ${MODEL_DIR}`);
  console.log(`Node: ${process.version}, Platform: ${process.platform}/${process.arch}`);
  console.log(`Baseline RSS: ${fmtMb(getRssMb())}`);
  console.log(`Baseline Heap: ${fmtMb(getHeapMb().used)} / ${fmtMb(getHeapMb().total)}`);

  measureFileSizes();

  const rssBefore = getRssMb();
  const heapBefore = getHeapMb();

  console.log('\n=== Model Loading ===');
  const loadStart = performance.now();
  const { loadV9SubcaptionModel } = await import('../src/training/v9SubcaptionInference.js');
  const importTime = performance.now() - loadStart;
  console.log(`  Module import time: ${fmtMs(importTime)}`);
  console.log(`  RSS after import: ${fmtMb(getRssMb())} (+${fmtMb(getRssMb() - rssBefore)})`);

  const loadStart2 = performance.now();
  const model = await loadV9SubcaptionModel(MODEL_DIR);
  const loadTime = performance.now() - loadStart2;

  const rssAfterLoad = getRssMb();
  const heapAfterLoad = getHeapMb();

  console.log(`  Model load time: ${fmtMs(loadTime)}`);
  console.log(`  RSS after load: ${fmtMb(rssAfterLoad)} (+${fmtMb(rssAfterLoad - rssBefore)})`);
  console.log(`  Heap used: ${fmtMb(heapAfterLoad.used)} (+${fmtMb(heapAfterLoad.used - heapBefore.used)})`);
  console.log(`  Heap total: ${fmtMb(heapAfterLoad.total)} (+${fmtMb(heapAfterLoad.total - heapBefore.total)})`);
  console.log(`  Static dim: ${model.staticFeatureDim}`);

  const makeInput = () => {
    const seq = Array.from({ length: 15 }, () => Array.from({ length: 101 }, () => Math.random() * 2 - 1));
    return {
      sequence: seq,
      staticFeatures: Array.from({ length: model.staticFeatureDim }, () => Math.random()),
      judgeIndices: [1, 2, 3, 4, 5, 6, 7, 8],
      corpsId: 42,
      agnosticShowId: 10,
      baselineRecap: [15, 15, 15, 15, 15, 15, 15, 15],
      historyLen: 5,
      judgeBiasScale: 1,
      corpsScale: 1,
    };
  };

  console.log('\n=== Warmup ===');
  for (let i = 0; i < WARMUP_RUNS; i++) {
    model.predictOne(makeInput());
  }
  console.log(`  ${WARMUP_RUNS} warmup predictions done`);
  console.log(`  RSS after warmup: ${fmtMb(getRssMb())}`);

  console.log(`\n=== Single Inference Latency (${BENCH_RUNS} runs) ===`);
  const latencies: number[] = [];
  for (let i = 0; i < BENCH_RUNS; i++) {
    const input = makeInput();
    const t0 = performance.now();
    model.predictOne(input);
    latencies.push(performance.now() - t0);
  }
  console.log(`  Mean:   ${fmtMs(latencies.reduce((a, b) => a + b, 0) / latencies.length)}`);
  console.log(`  Median: ${fmtMs(median(latencies))}`);
  console.log(`  P95:    ${fmtMs(p95(latencies))}`);
  console.log(`  Min:    ${fmtMs(Math.min(...latencies))}`);
  console.log(`  Max:    ${fmtMs(Math.max(...latencies))}`);
  console.log(`  RSS after bench: ${fmtMb(getRssMb())}`);

  console.log(`\n=== Batch Throughput (sequential predictOne) ===`);
  for (const batchSize of BATCH_SIZES) {
    const inputs = Array.from({ length: batchSize }, () => makeInput());
    const t0 = performance.now();
    for (const input of inputs) model.predictOne(input);
    const elapsed = performance.now() - t0;
    const perSec = (batchSize / elapsed) * 1000;
    console.log(`  Batch ${String(batchSize).padStart(3)}: ${fmtMs(elapsed)} total, ${fmtMs(elapsed / batchSize)}/pred, ${fmt(perSec, '/s')}`);
  }

  console.log('\n=== Memory Summary ===');
  const rssFinal = getRssMb();
  const heapFinal = getHeapMb();
  const mem = process.memoryUsage();
  console.log(`  RSS:           ${fmtMb(rssFinal)}`);
  console.log(`  Heap used:     ${fmtMb(heapFinal.used)}`);
  console.log(`  Heap total:    ${fmtMb(heapFinal.total)}`);
  console.log(`  External:      ${fmtMb(mem.external / 1024 / 1024)}`);
  console.log(`  ArrayBuffers:  ${fmtMb(mem.arrayBuffers / 1024 / 1024)}`);
  console.log(`  Delta RSS (load): +${fmtMb(rssAfterLoad - rssBefore)}`);

  model.dispose();
  console.log(`\n  After dispose: RSS ${fmtMb(getRssMb())}, Heap ${fmtMb(getHeapMb().used)}`);
  console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
