// Tests for the color derivation (src/corpsColors.ts).
//
// Run with: npx tsx test/corpsColors.test.ts

import {
  corpsPalette,
  hexToRgb,
  hexToOklch,
  oklchToRgb,
  normalizeHex,
  rgbToOklch,
} from '../src/corpsColors.js';

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

// hex parse
assert(JSON.stringify(hexToRgb('#ff0000')) === '[255,0,0]', 'hexToRgb red');
assert(hexToRgb('nope') === null, 'hexToRgb rejects garbage');

// round-trip hex → oklch → rgb stays close (±2 per channel for quantization).
for (const hex of ['#3b6fd4', '#c81e1e', '#10b981', '#000000', '#ffffff']) {
  const [r, g, b] = hexToRgb(hex)!;
  const [r2, g2, b2] = oklchToRgb(rgbToOklch(r, g, b));
  const close = Math.abs(r - r2) <= 2 && Math.abs(g - g2) <= 2 && Math.abs(b - b2) <= 2;
  assert(close, `oklch round-trip ${hex} → [${r2},${g2},${b2}]`);
}

// normalizeHex
assert(normalizeHex('#ABC') === '#aabbcc', 'normalizeHex expands shorthand + lowercases');
assert(normalizeHex('00FF00') === '#00ff00', 'normalizeHex adds # prefix');
assert(normalizeHex('xyz') === null, 'normalizeHex rejects non-hex');

// palette: dark-mode accent is lighter than light-mode accent (legible on surface).
const light = corpsPalette({ primary: '#c81e1e', secondary: null }, 'light');
const dark = corpsPalette({ primary: '#c81e1e', secondary: null }, 'dark');
const lOf = (css: string) => parseFloat(css.replace('oklch(', ''));
assert(lOf(dark.accent) > lOf(light.accent), 'dark accent lighter than light accent');
assert(light.accent.startsWith('oklch('), 'palette emits oklch() literals');
assert(light.chart2 !== light.chart, 'secondary chart color differs from primary');

// fallback: null colors still yield a full palette (site primary).
const fb = corpsPalette(null, 'light');
assert(!!hexToOklch('#3b6fd4') && fb.accent.startsWith('oklch('), 'null colors → fallback palette');

// contrast: the chosen foreground always sits far in lightness from its accent
// fill (accents are normalized to a fixed lightness per mode, so the fg is picked
// against the *normalized* accent, not the raw brand color).
for (const hex of ['#ffe000', '#101080', '#c81e1e', '#10b981']) {
  for (const mode of ['light', 'dark'] as const) {
    const p = corpsPalette({ primary: hex, secondary: null }, mode);
    const fgL = lOf(p.accentFg);
    const isExtreme = fgL < 0.2 || fgL > 0.9; // either near-black or near-white text
    assert(isExtreme, `${hex} ${mode}: accentFg is a contrast extreme (L=${fgL})`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
