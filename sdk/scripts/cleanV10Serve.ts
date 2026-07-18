// Clean-v10 direct-feed serving (Phase A3). Feeds a clean-v10-contract feature
// row (from ml_sequence_rows_v10_serving_clean, built by the dev3 clean-data
// pipeline) DIRECTLY to the identity-agnostic ensemble — exactly mirroring the
// eval feed in replayFinal2Baseline.ts (static[212] + 8 trend slopes, judge
// context masked, scales zeroed, baseline from the rank-baseline block). This is
// the serving path that reproduces the model's TRAINED contract (recap ~0.30),
// unlike buildV9PredictionFeatures which reconstructs v9-contract features.
//
// For a corps at a target event we use the clean row whose target IS that event
// (leakage-safe: its features use only pre-event data). Producing that row for an
// UNSCORED future event is Phase A2 (extend the clean-v10 builder); here we prove
// the feed by serving scored shadow shows from their own clean rows.
import { createClient } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { maskV9JudgeContext } from '../src/training/v9FeatureModes.js';

const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
const SEQ_LEN = 15;
const FEAT_DIM = 101;
const STATIC_DIM = 212;
const PADDING_INDEX = 3;
const CAPTION_SCALE = 20;

const arg = (flag: string, def?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
};

const eventSlug = arg('--event')!;
const dbUrl = arg('--db', 'file:./dci-relational.db')!;
const templateTable = arg('--template-table', 'ml_sequence_rows_v10_serving_clean')!;
if (!/^[A-Za-z0-9_]+$/.test(templateTable)) throw new Error(`bad --template-table ${templateTable}`);
const ensembleDirs = (arg('--ensemble-dirs') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const outPath = arg('--output');
// --as-of <date>: forecast the event from each corps' latest clean row BEFORE this
// date (the realistic future-event path — no row built for the target event). When
// unset, use the row whose target IS the event (the leakage-safe proof path).
const asOf = arg('--as-of');

async function main() {
  const db = createClient({ url: dbUrl });
  const { loadV9SubcaptionModel } = await import('../src/training/v9SubcaptionInference.js');
  const members = [];
  for (const d of ensembleDirs) members.push(await loadV9SubcaptionModel(d));
  if (!members.length) throw new Error('pass --ensemble-dirs a,b,c');

  // Two modes: proof (row whose target IS the event) or --as-of (each lineup
  // corps' latest clean row strictly before the event date — the realistic
  // future-event path).
  let rowsRes;
  if (asOf) {
    const lineup = await db.execute({
      sql: `SELECT DISTINCT corps_key FROM corps_scores WHERE competition_slug = ?`,
      args: [eventSlug],
    });
    const picked: any[] = [];
    for (const l of lineup.rows as any[]) {
      const r = await db.execute({
        sql: `SELECT corps_key, division_name, x_sequence_json, x_static_json, y_recap_json, y_total
              FROM ${templateTable} WHERE corps_key = ? AND competition_date < ?
              ORDER BY competition_date DESC LIMIT 1`,
        args: [l.corps_key, asOf],
      });
      if (r.rows[0]) picked.push(r.rows[0]);
    }
    rowsRes = { rows: picked };
  } else {
    rowsRes = await db.execute({
      sql: `SELECT corps_key, division_name, x_sequence_json, x_static_json, y_recap_json, y_total
            FROM ${templateTable} WHERE competition_slug = ?`,
      args: [eventSlug],
    });
  }

  const predictions: any[] = [];
  for (const r of rowsRes.rows as any[]) {
    const rawSequence = JSON.parse(r.x_sequence_json) as number[][];
    const staticRaw = JSON.parse(r.x_static_json) as number[];
    if (rawSequence.length !== SEQ_LEN || staticRaw.length !== STATIC_DIM) continue;
    const mask = rawSequence.map((step) => step[PADDING_INDEX] !== 1);
    const sequence = rawSequence.map((step) =>
      step[PADDING_INDEX] === 1 ? new Array<number>(FEAT_DIM).fill(0) : step
    );
    // Trend slopes (8): per-caption slope over this corps' last ≤3 observed recaps.
    // The stored sequence carries the recap history in its RECAP block; but the
    // simplest faithful source is the row's own trend already baked into training.
    // Reconstruct from the sequence recap channel (offset 21, stride 4, +2 = p50).
    const recapHist: number[][] = Array.from({ length: 8 }, () => []);
    for (let s = 0; s < sequence.length; s++) {
      if (!mask[s]) continue;
      for (let c = 0; c < 8; c++) {
        const v = sequence[s]![21 + c * 4 + 2];
        if (typeof v === 'number') recapHist[c]!.push(v * CAPTION_SCALE);
      }
    }
    const trendSlopes = recapHist.map((vals) => {
      const last = vals.slice(-3);
      return last.length >= 2 ? (last.at(-1)! - last[0]!) / (last.length - 1) / 0.1 : 0;
    });
    const staticFeatures = [...staticRaw, ...trendSlopes];
    maskV9JudgeContext(staticFeatures); // agnostic
    // Baseline exactly as the eval feed: the corps' last-observed recap from the
    // sequence's recap channel; dev3 curve-anchor fallback (rank-baseline block)
    // only when that is all-zero (first-ever appearance).
    const maskArr = mask.map((v) => (v ? 1 : 0));
    const lastValid = maskArr.lastIndexOf(1);
    const baseline = CAPTIONS.map((_, i) =>
      lastValid >= 0 ? (sequence[lastValid]?.[21 + i * 4 + 2] ?? 0) * CAPTION_SCALE : 0
    );
    if (baseline.every((v) => v === 0)) {
      for (let i = 0; i < 8; i++) baseline[i] = (staticFeatures[121 + i] ?? 0) * CAPTION_SCALE;
    }
    const historyLen = Math.max(0, mask.filter(Boolean).length - 1);

    const perMember = members.map((m) =>
      m.predictOne({
        sequence,
        sequenceMask: mask,
        staticFeatures,
        judgeIndices: new Array(8).fill(0),
        corpsId: 0,
        agnosticShowId: 0,
        baselineRecap: baseline,
        historyLen,
        judgeBiasScale: 0,
        corpsScale: 0,
      })
    );
    const caps = CAPTIONS.map((cap) =>
      perMember.reduce((s, p) => s + p.captions[cap].p50, 0) / perMember.length
    );
    const total = caps[0]! + caps[1]! + (caps[2]! + caps[3]! + caps[4]!) / 2 + (caps[5]! + caps[6]! + caps[7]!) / 2;
    predictions.push({
      corps_key: r.corps_key,
      division: r.division_name,
      total,
      ...Object.fromEntries(CAPTIONS.map((c, i) => [c, Number(caps[i]!.toFixed(3))])),
    });
  }
  members.forEach((m) => m.dispose());
  const out = { event: eventSlug, model_dir: `clean-v10-ensemble:${members.length}`, predictions };
  if (outPath) fs.writeFileSync(path.resolve(process.cwd(), outPath), JSON.stringify(out, null, 2));
  console.log(`clean-v10 serve: ${predictions.length} corps for ${eventSlug}`);
}
main();
