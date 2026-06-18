// Tests for logo color extraction (src/logoColors.ts).
//
// Run with: npx tsx test/logoColors.test.ts
//
// Generates synthetic logos with sharp and asserts extractLogoColors picks the
// brand hues (and returns null for monochrome/empty marks).

import sharp from 'sharp';
import { extractLogoColors } from '../src/logoColors.js';
import { hexToRgb } from '../src/corpsColors.js';

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

// PNG with the centered half split into two quadrants of colors a and b (b
// optional) on a transparent surround — mimicking a two-color logo mark.
const markPng = (a: [number, number, number], b?: [number, number, number]): Promise<Buffer> => {
  const data = Buffer.alloc(SIZE * SIZE * 4, 0);
  const lo = SIZE / 4;
  const hi = (SIZE * 3) / 4;
  const mid = SIZE / 2;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const i = (y * SIZE + x) * 4;
      const [r, g, bl] = b && x >= mid ? b : a;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = bl;
      data[i + 3] = 255;
    }
  }
  return sharp(data, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer();
};

const transparentPng = (): Promise<Buffer> =>
  sharp(Buffer.alloc(SIZE * SIZE * 4, 0), { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png()
    .toBuffer();

// Hue of a hex, for asserting the extracted color is in the right family.
const hueOf = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex)!;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d === 0) return -1;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
};

async function main() {
  // 1. Single red mark → primary in the red family, no secondary.
  const red = await extractLogoColors(await markPng([220, 20, 20]));
  assert(red !== null, 'red mark: extracts colors');
  const rh = red ? hueOf(red.primary) : -1;
  assert(rh < 20 || rh > 340, `red mark: primary is red (hue ${rh.toFixed(0)})`);
  assert(!!red && red.secondary === null, 'red mark: no secondary (single hue)');

  // 2. Red + blue mark → two colors, distinct hues.
  const rb = await extractLogoColors(await markPng([220, 20, 20], [20, 40, 220]));
  assert(!!rb && rb.secondary !== null, 'red+blue mark: extracts a secondary');
  if (rb && rb.secondary) {
    const gap = Math.abs(hueOf(rb.primary) - hueOf(rb.secondary));
    assert(Math.min(gap, 360 - gap) > 40, 'red+blue mark: primary/secondary hues distinct');
  }

  // 3. Black mark → null (no brand hue).
  const black = await extractLogoColors(await markPng([0, 0, 0]));
  assert(black === null, 'black mark: returns null');

  // 4. Grey mark → null (low saturation).
  const grey = await extractLogoColors(await markPng([130, 130, 135]));
  assert(grey === null, 'grey mark: returns null');

  // 5. Transparent → null.
  const empty = await extractLogoColors(await transparentPng());
  assert(empty === null, 'transparent image: returns null');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('logoColors test failed:', error);
  process.exitCode = 1;
});
