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
import {
  saveEventPredictionRun,
  ensureEventPredictionTables,
} from '../src/training/v9EventPredictionDb.js';

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
const saveDb = process.argv.includes('--save-db');
const season = arg('--season', '2026')!;
// Stamp the run at --as-of noon (matches predictEventRecap's scrubber convention).
const asOfStamp = () => (asOf ? `${asOf}T12:00:00.000Z` : new Date().toISOString());
// --as-of <date>: forecast the event from each corps' latest clean row BEFORE this
// date (the realistic future-event path — no row built for the target event). When
// unset, use the row whose target IS the event (the leakage-safe proof path).
const asOf = arg('--as-of');
// Light residual-bias calibration (the ONLY correction V10 needs — its clean-v10
// contract bakes in the seasonal projection final2 patched with the full stack).
// Keyed by `${division}|${debut|sparse|established}`; offset ADDED to the total.
const biasCalPath = arg('--bias-calibration', 'scripts/cleanV10BiasCalibration.json');
let biasCal: Record<string, number> = {};
try {
  biasCal = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), biasCalPath!), 'utf-8'));
} catch {
  /* no calibration → raw totals */
}
const historyBucket = (nonPadSteps: number) =>
  nonPadSteps === 0 ? 'debut' : nonPadSteps <= 2 ? 'sparse' : 'established';

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
    const avgAt = (cap: (typeof CAPTIONS)[number], q: 'p10' | 'p50' | 'p90') =>
      perMember.reduce((s, p) => s + p.captions[cap][q], 0) / perMember.length;
    const caps = CAPTIONS.map((cap) => avgAt(cap, 'p50'));
    // Caption uncertainty bands from the ensemble's p10/p90 spread (offset from p50).
    // Raw ensemble spread understates true predictive intervals — a history/division
    // interval-scale calibration (4f) should widen these; scale=1 for now.
    const intervals = Object.fromEntries(
      CAPTIONS.map((cap) => [
        cap,
        {
          low_offset: Number((avgAt(cap, 'p10') - avgAt(cap, 'p50')).toFixed(3)),
          high_offset: Number((avgAt(cap, 'p90') - avgAt(cap, 'p50')).toFixed(3)),
        },
      ])
    );
    const rawTotal =
      caps[0]! + caps[1]! + (caps[2]! + caps[3]! + caps[4]!) / 2 + (caps[5]! + caps[6]! + caps[7]!) / 2;
    const bucket = historyBucket(mask.filter(Boolean).length);
    const total = rawTotal + (biasCal[`${r.division_name}|${bucket}`] ?? 0);
    const ge = caps[0]! + caps[1]!;
    const visual = (caps[2]! + caps[3]! + caps[4]!) / 2;
    const music = (caps[5]! + caps[6]! + caps[7]!) / 2;
    predictions.push({
      corps_key: r.corps_key,
      division: r.division_name,
      total: Number(total.toFixed(3)),
      GE: Number(ge.toFixed(3)),
      Visual: Number(visual.toFixed(3)),
      Music: Number(music.toFixed(3)),
      template_source: 'clean_v10_inference',
      intervals,
      ...Object.fromEntries(CAPTIONS.map((c, i) => [c, Number(caps[i]!.toFixed(3))])),
    });
  }
  members.forEach((m) => m.dispose());

  // corps display names, then rank by total desc.
  const names = new Map<string, string>();
  if (predictions.length) {
    const keys = predictions.map((p) => String(p.corps_key));
    const res = await db.execute({
      sql: `SELECT corps_key, name FROM corps WHERE corps_key IN (${keys.map(() => '?').join(',')})`,
      args: keys,
    });
    for (const row of res.rows as any[]) names.set(String(row.corps_key), String(row.name));
  }
  predictions.sort((a, b) => (b.total as number) - (a.total as number));
  predictions.forEach((p, i) => {
    (p as any).rank = i + 1;
    (p as any).corps = names.get(String(p.corps_key)) ?? String(p.corps_key);
  });

  const modelDir = `clean-v10-ensemble:${members.length}`;
  const out = {
    generated_at: asOfStamp(),
    model_dir: modelDir,
    event: { slug: eventSlug, season, start_date: asOf ?? null },
    competition: { slug: eventSlug },
    readiness: {
      mode: 'clean_v10_inference',
      percent_through: 0,
      lineup_rows: predictions.length,
      matched_corps_keys: predictions.length,
      judge_assignments: 0,
    },
    builder_version: 'clean-v10-serve',
    predictions,
  };
  if (outPath) fs.writeFileSync(path.resolve(process.cwd(), outPath), JSON.stringify(out, null, 2));
  if (saveDb) {
    await ensureEventPredictionTables(db);
    const id = await saveEventPredictionRun(db, out as any);
    console.log(`clean-v10 serve: saved prediction run ${id}`);
  }
  console.log(`clean-v10 serve: ${predictions.length} corps for ${eventSlug}`);
}
main();
