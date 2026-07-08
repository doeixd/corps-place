// Run with: npx tsx test/v9FeatureParity.test.ts   (from the sdk/ directory)
//
// Guards the parity contract between the V9 subcaption *training data*
// (ml_sequence_rows_v9_subcaption) and the *feature-index map / model input width*
// declared in src/training/v9FeatureModes.ts.
//
// These tests exist because the working-tree sequence builder
// (src/buildMlSequencesV9Subcaption.ts) emits only the 169-feature base vector,
// while the deployed model was trained on the 212-feature layout
// (169 base + 10 cold-start features [169..178] + 33 caption-fingerprint features
// [179..211]). When the nightly refresh regenerates the current season with the
// stale builder, in-season rows come out 169-long and inference silently feeds the
// model zeros for the cold-start block — a covariate shift on every in-season
// prediction. See findings in the audit for details.

import assert from 'node:assert/strict';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import {
  V9_RAW_STATIC_DIM,
  V9_COLD_START_STATIC_OFFSET,
  V9_CAPTION_FINGERPRINT_START,
  V9_CAPTION_FINGERPRINT_DIM,
  V9_FEATURE_INDICES,
} from '../src/training/v9FeatureModes.js';

const dbUrl = () =>
  process.env.DCI_RELATIONAL_DB_URL ??
  `file:${path.resolve(process.cwd(), 'dci-relational.db')}`;

const CURRENT_SEASON = process.env.V9_CURRENT_SEASON ?? '2026';

let failures = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`  ok  - ${name}`);
  } catch (error) {
    failures++;
    console.error(`  FAIL - ${name}`);
    console.error(`         ${(error as Error).message.split('\n').join('\n         ')}`);
  }
};

async function staticLenByLen(db: Client): Promise<Map<number, number>> {
  const res = await db.execute(
    `SELECT json_array_length(x_static_json) AS len, COUNT(*) AS n
     FROM ml_sequence_rows_v9_subcaption GROUP BY len`
  );
  const map = new Map<number, number>();
  for (const row of res.rows) map.set(Number(row.len), Number(row.n));
  return map;
}

async function main() {
  console.log('v9FeatureParity');

  // ---- 1. Feature-index map is internally self-consistent ---------------------
  await test('v9FeatureModes constants are self-consistent', () => {
    assert.equal(
      V9_RAW_STATIC_DIM,
      V9_CAPTION_FINGERPRINT_START + V9_CAPTION_FINGERPRINT_DIM,
      'RAW_STATIC_DIM must equal fingerprintStart + fingerprintDim'
    );
    assert.equal(V9_RAW_STATIC_DIM, 212, 'deployed model expects a 212-wide static vector');
    assert.ok(
      V9_COLD_START_STATIC_OFFSET < V9_CAPTION_FINGERPRINT_START,
      'cold-start block must sit before the fingerprint block'
    );
    for (const [key, idx] of Object.entries(V9_FEATURE_INDICES)) {
      assert.ok(
        idx >= 0 && idx < V9_RAW_STATIC_DIM,
        `V9_FEATURE_INDICES.${key} = ${idx} is out of [0, ${V9_RAW_STATIC_DIM})`
      );
    }
  });

  const db = createClient({ url: dbUrl() });
  try {
    const byLen = await staticLenByLen(db);
    const lens = Array.from(byLen.entries()).map(([len, n]) => `${len}:${n}`).join(', ');
    console.log(`  info- static-length histogram -> ${lens}`);

    // ---- 2. EVERY stored row matches the model's input width -----------------
    // This is the core parity invariant. It currently FAILS on the
    // stale-builder current-season rows, which is the point.
    await test('all ml_sequence_rows_v9_subcaption rows are V9_RAW_STATIC_DIM wide', () => {
      const bad = Array.from(byLen.entries()).filter(([len]) => len !== V9_RAW_STATIC_DIM);
      assert.equal(
        bad.length,
        0,
        `found rows whose x_static width != ${V9_RAW_STATIC_DIM}: ` +
          bad.map(([len, n]) => `${n} rows of width ${len}`).join('; ') +
          `. The stale 169-feature builder was used — regenerate with the ` +
          `212-feature builder (cold-start + caption-fingerprint tail).`
      );
    });

    // ---- 3. Historical seasons are the trusted 212-wide reference ------------
    await test('historical (non-current) rows are all 212 wide', async () => {
      const res = await db.execute({
        sql: `SELECT DISTINCT json_array_length(x_static_json) AS len
              FROM ml_sequence_rows_v9_subcaption WHERE season != ?`,
        args: [CURRENT_SEASON],
      });
      const lensH = res.rows.map((r) => Number(r.len));
      assert.deepEqual(
        lensH,
        [V9_RAW_STATIC_DIM],
        `historical rows should all be ${V9_RAW_STATIC_DIM} wide, got ${JSON.stringify(lensH)}`
      );
    });

    // ---- 4. Current-season rows must match history (regression guard) --------
    await test(`current-season (${CURRENT_SEASON}) rows match the 212 layout`, async () => {
      const res = await db.execute({
        sql: `SELECT json_array_length(x_static_json) AS len, COUNT(*) AS n
              FROM ml_sequence_rows_v9_subcaption WHERE season = ? GROUP BY len`,
        args: [CURRENT_SEASON],
      });
      if (res.rows.length === 0) {
        console.log(`  info- no ${CURRENT_SEASON} rows present; skipping`);
        return;
      }
      const wrong = res.rows.filter((r) => Number(r.len) !== V9_RAW_STATIC_DIM);
      assert.equal(
        wrong.length,
        0,
        `current-season rows are ${wrong.map((r) => `${r.n}x width ${r.len}`).join(', ')} — ` +
          `in-season predictions template off these and feed the model a truncated vector.`
      );
    });

    // ---- 5. pastShowsCount index actually points at the count feature --------
    // The training vector puts pastShows.length/40 at index 136 (a multiple of
    // 1/40); index 168 holds a subcaption EMA score. This asserts the constant
    // points at the count-like feature. Currently FAILS (constant = 168).
    await test('V9_FEATURE_INDICES.pastShowsCount points at the count-like feature', async () => {
      const idx = Math.trunc(V9_FEATURE_INDICES.pastShowsCount);
      const res = await db.execute({
        sql: `SELECT json_extract(x_static_json, '$[${idx}]') AS v
              FROM ml_sequence_rows_v9_subcaption
              WHERE json_array_length(x_static_json) = ?
              LIMIT 500`,
        args: [V9_RAW_STATIC_DIM],
      });
      const vals = res.rows
        .map((r) => Number(r.v))
        .filter((v) => Number.isFinite(v));
      assert.ok(vals.length > 0, 'no sample values read');
      // pastShows.length/40 is always an exact multiple of 1/40 (0.025).
      const nonCountLike = vals.filter((v) => Math.abs(v * 40 - Math.round(v * 40)) > 1e-6);
      assert.equal(
        nonCountLike.length,
        0,
        `index ${idx} holds non-count values (e.g. ${nonCountLike.slice(0, 3).join(', ')}); ` +
          `pastShows.length/40 lives at index 136, not ${idx}.`
      );
    });

    // ---- 6. Cold-start block is genuinely populated in history --------------
    // percentThrough lives at COLD_START_OFFSET+9 (=178). If the whole block
    // were zero the fingerprint growth computation would silently degrade.
    await test('cold-start percentThrough (idx 178) is populated in historical rows', async () => {
      const idx = Math.trunc(V9_COLD_START_STATIC_OFFSET + 9);
      const res = await db.execute({
        sql: `SELECT MAX(CAST(json_extract(x_static_json, '$[${idx}]') AS REAL)) AS max
              FROM ml_sequence_rows_v9_subcaption
              WHERE json_array_length(x_static_json) = ? AND season != ?`,
        args: [V9_RAW_STATIC_DIM, CURRENT_SEASON],
      });
      const max = Number(res.rows[0]?.max ?? 0);
      assert.ok(
        max > 0,
        `cold-start percentThrough at idx ${idx} is all-zero in history (max=${max}) — ` +
          `layout drift or an unpopulated block.`
      );
    });
  } finally {
    db.close();
  }

  console.log(failures === 0 ? '\nAll parity checks passed.' : `\n${failures} parity check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
