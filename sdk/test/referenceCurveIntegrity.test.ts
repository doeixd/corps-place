// Run with: npx tsx test/referenceCurveIntegrity.test.ts   (from the sdk/ directory)
//
// Integrity guard for the COMMITTED reference curve (src/training/referenceCurvesV4.json).
// This is the file the prediction baseline reads; a corrupt/incomplete column here feeds
// every in-season prediction a wrong caption anchor.
//
// Why a file-level test in addition to the generator's own validation: the corruption that
// motivated this test did NOT come through the generator. The generator's CAPTION_MAP had a
// stale no-hyphen "Visual Analysis" key (DB uses "Visual - Analysis"), so VA silently fell
// through — and the broken 8.8-VA column that shipped was actually a STALE ARTIFACT swept in
// by a bulk "Restore full project tree" commit, never regenerated. A generator-only guard
// can't catch a bad file that bypassed the generator. This test does.
//
// It asserts, on the checked-in JSON:
//   1. every declared caption is present for every curve key (no silent holes), and
//   2. no caption sits anomalously far below its siblings at the same key (the intra-key
//      detector that surfaced VA at ~8.8 while every sibling was ~18).

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CURVE_PATH = path.resolve(process.cwd(), 'src/training/referenceCurvesV4.json');
// Max points a caption may sit below its siblings' mean at the same (rank, pct) key
// before we treat it as corruption. VA was ~9pts low; healthy captions track within ~1-2.
const SIBLING_DROP_LIMIT = 3;
// Require enough siblings for the mean to be meaningful before flagging.
const MIN_SIBLINGS = 4;

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}

type Curve = { version?: string; captions: string[]; curves: Record<string, Record<string, number>> };

const raw = JSON.parse(fs.readFileSync(CURVE_PATH, 'utf8')) as Curve;
const captions = raw.captions;
const curves = raw.curves;
const keys = Object.keys(curves);

console.log(`referenceCurvesV4.json — ${captions.length} captions, ${keys.length} keys`);

check('declares the 8 canonical captions', () => {
  const expected = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'];
  assert.deepEqual([...captions].sort(), [...expected].sort(), `captions = ${captions.join(',')}`);
});

check('every key carries every declared caption (no silent holes)', () => {
  const holes: string[] = [];
  for (const key of keys) {
    const missing = captions.filter((c) => curves[key]![c] === undefined);
    if (missing.length) holes.push(`${key}: missing ${missing.join(',')}`);
  }
  assert.equal(holes.length, 0, `${holes.length} key(s) with missing captions, e.g. ${holes.slice(0, 5).join(' | ')}`);
});

check(`no caption sits >${SIBLING_DROP_LIMIT}pts below its sibling mean (corruption detector)`, () => {
  const anomalies: string[] = [];
  for (const key of keys) {
    const caps = curves[key]!;
    for (const cap of captions) {
      const self = caps[cap];
      if (self === undefined) continue;
      const sibs = captions.filter((c) => c !== cap && caps[c] !== undefined).map((c) => caps[c]!);
      if (sibs.length < MIN_SIBLINGS) continue;
      const mean = sibs.reduce((a, b) => a + b, 0) / sibs.length;
      if (mean - self > SIBLING_DROP_LIMIT) {
        anomalies.push(`${key} ${cap}=${self} is ${(mean - self).toFixed(1)}pts below sibling mean ${mean.toFixed(1)}`);
      }
      // High side catches total-value leakage (an 80-99 total averaged into a
      // subcaption cell), which the generator's range filter now drops upstream.
      if (self - mean > SIBLING_DROP_LIMIT) {
        anomalies.push(`${key} ${cap}=${self} is ${(self - mean).toFixed(1)}pts above sibling mean ${mean.toFixed(1)} (total leak?)`);
      }
    }
  }
  assert.equal(
    anomalies.length,
    0,
    `${anomalies.length} anomalous caption(s), e.g. ${anomalies.slice(0, 8).join(' | ')}`
  );
});

console.log(failures === 0 ? '\nAll reference-curve integrity checks passed.' : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
