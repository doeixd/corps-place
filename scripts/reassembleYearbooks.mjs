#!/usr/bin/env node
/**
 * Reassemble split yearbook PDF parts before serving (Docker build / local dev).
 * Idempotent: skips when the target PDF already exists.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const YEARBOOK_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/yearbook');

function partGroups() {
  const groups = new Map();

  for (const name of readdirSync(YEARBOOK_DIR)) {
    const match = name.match(/^(.+\.pdf)\.part(\d{3})$/);
    if (!match) continue;
    const [, base, partNum] = match;
    const parts = groups.get(base) ?? [];
    parts.push({ name, partNum: Number(partNum) });
    groups.set(base, parts);
  }

  return groups;
}

function assemble(base, parts) {
  const outPath = join(YEARBOOK_DIR, base);
  if (existsSync(outPath)) {
    unlinkSync(outPath);
  }

  parts.sort((a, b) => a.partNum - b.partNum);
  const chunks = parts.map((part) => readFileSync(join(YEARBOOK_DIR, part.name)));
  writeFileSync(outPath, Buffer.concat(chunks));
  console.log(`[yearbook] assembled ${base} from ${parts.length} part(s)`);
}

const groups = partGroups();
if (groups.size === 0) {
  console.log('[yearbook] no split parts found');
} else {
  for (const [base, parts] of groups) {
    assemble(base, parts);
  }
}
