// Tests for the dark-logo heuristic (src/logoDarkness.ts).
//
// Run with: npx tsx test/logoDarkness.test.ts
//
// Generates synthetic logos (a black mark, a colored mark, fully transparent)
// with sharp and asserts analyzeLogoBytes + isDarkLogo classify them correctly.

import sharp from 'sharp';
import { analyzeLogoBytes, isDarkLogo } from '../src/logoDarkness.js';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`PASS: ${message}`);
  } else {
    failed++;
    console.error(`FAIL: ${message}`);
  }
}

const SIZE = 96;

// Build a PNG where the centered half is filled with [r,g,b,255] and the
// surround is transparent — mimicking a logo mark on a transparent background.
const markPng = (r: number, g: number, b: number): Promise<Buffer> => {
  const data = Buffer.alloc(SIZE * SIZE * 4, 0); // transparent
  const lo = SIZE / 4;
  const hi = (SIZE * 3) / 4;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const i = (y * SIZE + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return sharp(data, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer();
};

const transparentPng = (): Promise<Buffer> =>
  sharp(Buffer.alloc(SIZE * SIZE * 4, 0), { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png()
    .toBuffer();

async function main() {
  // 1. A black mark on transparent → primarily dark.
  const black = await analyzeLogoBytes(await markPng(0, 0, 0));
  assert(black !== null, 'black mark: produces stats');
  assert(!!black && isDarkLogo(black), 'black mark: classified as dark');

  // 2. A saturated red mark → NOT dark (it carries color).
  const red = await analyzeLogoBytes(await markPng(220, 20, 20));
  assert(red !== null, 'red mark: produces stats');
  assert(!!red && !isDarkLogo(red), 'red mark: classified as not-dark');

  // 3. A near-white mark → NOT dark (light ink already reads on dark bg).
  const white = await analyzeLogoBytes(await markPng(240, 240, 240));
  assert(!!white && !isDarkLogo(white), 'white mark: classified as not-dark');

  // 4. A fully transparent image → no opaque pixels → null (skip, not flagged).
  const empty = await analyzeLogoBytes(await transparentPng());
  assert(empty === null, 'transparent image: returns null');

  // 5. A dark-grey mark → dark (neutral + low luminance).
  const grey = await analyzeLogoBytes(await markPng(40, 40, 45));
  assert(!!grey && isDarkLogo(grey), 'dark-grey mark: classified as dark');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('logoDarkness test failed:', error);
  process.exitCode = 1;
});
