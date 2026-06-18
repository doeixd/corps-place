#!/usr/bin/env node
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const maxOutputGb = Number(process.env.MAX_BUILD_OUTPUT_GB ?? 1.5);
const forbidden = ['.output/public/yearbook', '.tanstack/start/build/client-dist/yearbook'];

const sizeOf = (path) => {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOf(join(path, entry.name));
  }
  return total;
};

let failed = false;
for (const path of forbidden) {
  if (existsSync(path)) {
    console.error(`[build-output-check] forbidden build payload exists: ${path}`);
    failed = true;
  }
}

const outputBytes = sizeOf('.output');
const outputGb = outputBytes / 1024 / 1024 / 1024;
if (outputBytes > 0 && outputGb > maxOutputGb) {
  console.error(
    `[build-output-check] .output is ${outputGb.toFixed(2)} GiB; limit is ${maxOutputGb} GiB. ` +
      'Large data probably leaked into the runtime image.'
  );
  failed = true;
}

if (failed) process.exit(1);
if (outputBytes > 0) {
  console.log(
    `[build-output-check] .output ${outputGb.toFixed(2)} GiB; no yearbook payload copied`
  );
}
