#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const minFreeGb = Number(process.env.BUILD_MIN_FREE_GB ?? process.env.MIN_FREE_GB ?? 10);
const pathToCheck = process.env.BUILD_DISK_PATH ?? process.cwd();

if (process.env.SKIP_DISK_SPACE_CHECK === 'true') {
  process.exit(0);
}

if (process.platform === 'win32') {
  console.warn('[disk-check] skipping on Windows; df is not available');
  process.exit(0);
}

const output = execFileSync('df', ['-Pk', pathToCheck], { encoding: 'utf8' }).trim().split('\n');
const fields = output.at(-1)?.trim().split(/\s+/);
const availableKb = Number(fields?.[3]);

if (!Number.isFinite(availableKb)) {
  console.warn(`[disk-check] could not parse df output for ${pathToCheck}`);
  process.exit(0);
}

const availableGb = availableKb / 1024 / 1024;
if (availableGb < minFreeGb) {
  console.error(
    `[disk-check] refusing to build: ${availableGb.toFixed(1)} GiB free, need at least ${minFreeGb} GiB.\n` +
      'Clean old build artifacts/Docker cache or lower BUILD_MIN_FREE_GB intentionally.'
  );
  process.exit(1);
}

console.log(`[disk-check] ${availableGb.toFixed(1)} GiB free; threshold ${minFreeGb} GiB`);
