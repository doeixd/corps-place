#!/usr/bin/env node
/**
 * Split yearbook PDFs over GitHub's 100 MB file limit into numbered parts.
 * Run once locally when adding new oversized PDFs; commit the .partNNN files only.
 */
import { createReadStream, createWriteStream, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';

const CHUNK_BYTES = 90 * 1024 * 1024;
const MAX_BYTES = 100 * 1024 * 1024;
const YEARBOOK_DIR = join(dirname(fileURLToPath(import.meta.url)), '../data/yearbook');

async function splitFile(filePath) {
  const { size } = statSync(filePath);
  if (size <= MAX_BYTES) return false;

  const base = filePath;
  let part = 1;
  let offset = 0;

  while (offset < size) {
    const end = Math.min(offset + CHUNK_BYTES, size);
    const partPath = `${base}.part${String(part).padStart(3, '0')}`;
    const rs = createReadStream(base, { start: offset, end: end - 1 });
    const ws = createWriteStream(partPath);
    await finished(rs.pipe(ws));
    console.log(`  wrote ${partPath} (${end - offset} bytes)`);
    offset = end;
    part += 1;
  }

  return true;
}

const pdfs = readdirSync(YEARBOOK_DIR).filter(
  (name) => name.endsWith('.pdf') && !name.includes('.part')
);
let splitCount = 0;

for (const name of pdfs) {
  const path = join(YEARBOOK_DIR, name);
  const { size } = statSync(path);
  if (size <= MAX_BYTES) continue;
  console.log(`splitting ${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  if (await splitFile(path)) splitCount += 1;
}

console.log(splitCount === 0 ? 'no oversized PDFs found' : `split ${splitCount} file(s)`);
