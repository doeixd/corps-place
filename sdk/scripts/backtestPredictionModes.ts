// Backtest: which multi-week prediction strategy is most accurate?
//
// Replays the (complete) 2025 season: freeze knowledge at a cutoff date, predict
// every scored World/Open show AFTER the cutoff for every corps with observed
// history BEFORE it, and score each strategy against the actual totals.
//
// Modes:
//   curve       — SHIPPED approach: model with inputs frozen at the corps' last
//                 pre-cutoff show (baselineRecap = last recap), plus additive
//                 reference-curve growth from last-show %-through to target.
//   target      — train-consistent inference: baselineRecap (and the static rank-
//                 baseline slots) rebuilt from the reference curve AT THE TARGET
//                 percent-through — matching how y_residuals were computed in
//                 training (actual − curve(target %)).
//   ar          — autoregressive rollout: step through the corps' actual
//                 intermediate show dates, feeding each predicted recap back into
//                 the sequence (context features carried/patched — future field
//                 context is unknowable, which is AR's real-world handicap).
//   curveonly   — control: reference curve alone, no model.
//   persist     — control: the corps' last observed total, flat (the old bug).
//
// Usage (from sdk/):
//   vp exec tsx scripts/backtestPredictionModes.ts --cutoffs 2025-07-01,2025-07-15,2025-07-30
//   vp exec tsx scripts/backtestPredictionModes.ts --cutoffs 2025-07-01 --sample 40
import { createClient, type Client } from '@libsql/client';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildV9PredictionFeatures } from '../src/training/v9PredictionFeatures.js';
import { findLatestV9SubcaptionModelDir } from '../src/training/v9ModelPaths.js';
import { V9_FEATURE_INDICES } from '../src/training/v9FeatureModes.js';

const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
type Caption = (typeof CAPTIONS)[number];
const SEASON = '2025';
const DIVISIONS = ['World Class', 'Open Class'];

// ── Reference curves (same artifact training used) ───────────────────────────
const REFERENCE_CURVES: { curves: Record<string, Record<string, number>> } = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/training/referenceCurvesV4.json'), 'utf-8')
);
function curveBaseline(rank: number, pct: number, caption: string): number {
  const r = rank < 1 || !Number.isFinite(rank) ? 12 : Math.round(rank);
  const bucket = Math.round(Math.max(0, Math.min(100, pct)) / 5) * 5;
  const c = REFERENCE_CURVES.curves;
  return (
    c[`${r}-${bucket}`]?.[caption] ?? c[`${r}-50`]?.[caption] ?? c[`12-${bucket}`]?.[caption] ?? 15
  );
}
const curveVector = (rank: number, pct: number) =>
  CAPTIONS.map((cap) => curveBaseline(rank, pct, cap));
const totalOf = (caps: number[]) =>
  caps[0] + caps[1] + (caps[2] + caps[3] + caps[4]) / 2 + (caps[5] + caps[6] + caps[7]) / 2;

// ── Data plumbing ─────────────────────────────────────────────────────────────
type ShowRow = {
  corps_key: string;
  division_name: string;
  competition_slug: string;
  competition_date: string;
  y_total: number;
  pct: number;
};

async function loadSeasonRows(db: Client): Promise<ShowRow[]> {
  const res = await db.execute({
    sql: `SELECT m.corps_key, m.division_name, m.competition_slug, m.competition_date, m.y_total,
                 COALESCE(c.percent_through, 50) AS pct
          FROM ml_sequence_rows_v9_subcaption m
          LEFT JOIN competitions c ON c.slug = m.competition_slug
          WHERE m.season = ? ORDER BY m.competition_date`,
    args: [SEASON],
  });
  return res.rows.map((r: any) => ({
    corps_key: String(r.corps_key),
    division_name: String(r.division_name),
    competition_slug: String(r.competition_slug),
    competition_date: String(r.competition_date),
    y_total: Number(r.y_total),
    pct: Number(r.pct),
  }));
}

/** Overall rank at cutoff: same-division corps ordered by last observed total. */
function ranksAtCutoff(rows: ShowRow[], cutoff: string): Map<string, number> {
  const last = new Map<string, ShowRow>();
  for (const r of rows) if (r.competition_date < cutoff) last.set(r.corps_key, r);
  const ranks = new Map<string, number>();
  for (const div of DIVISIONS) {
    const corps = [...last.values()].filter((r) => r.division_name === div);
    corps.sort((a, b) => b.y_total - a.y_total);
    corps.forEach((r, i) => ranks.set(r.corps_key, i + 1));
  }
  return ranks;
}

// ── Sequence-step synthesis for AR rollout ────────────────────────────────────
// Clone the last real step and patch what's computable for a simulated show; the
// field-context features (gaps, percentile, perf order, opponents, judges) are
// carried over — unknowable pre-show, which is AR's structural handicap.
const normalizeScore = (s: number) => Math.max(0, Math.min(1, s / 100));
function synthesizeStep(
  lastStep: number[],
  prevDate: string,
  date: string,
  pct: number,
  predictedTotal: number,
  stepIdx: number,
  seqLen: number
): number[] {
  const step = [...lastStep];
  const days = Math.max(0, (Date.parse(date) - Date.parse(prevDate)) / 86_400_000);
  step[0] = pct / 100;
  step[1] = Math.min(days, 14) / 14;
  step[2] = (stepIdx + 1) / seqLen;
  step[3] = 0; // not padding
  const d = new Date(date);
  const dayOfYear = (d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86_400_000;
  const rad = (dayOfYear / 366) * 2 * Math.PI;
  step[7] = Math.sin(rad);
  step[8] = Math.cos(rad);
  step[10] = normalizeScore(predictedTotal);
  return step;
}

// ── Per-mode predictors ───────────────────────────────────────────────────────
type Ctx = {
  db: Client;
  model: any;
  ranks: Map<string, number>;
  cutoff: string;
  histByCorps: Map<string, ShowRow[]>; // pre-cutoff rows, date-ordered
  futureByCorps: Map<string, ShowRow[]>; // post-cutoff rows, date-ordered
};

async function featuresAtCutoff(ctx: Ctx, corpsKey: string, division: string, targetPct: number) {
  return buildV9PredictionFeatures(ctx.db, {
    mode: 'panel_unknown',
    corpsKey,
    division,
    targetDate: ctx.cutoff, // history strictly before the cutoff — no leakage
    percentThrough: targetPct,
    season: SEASON,
    keepKnownLineupContext: true,
  });
}

function runModel(ctx: Ctx, features: any, override?: { baselineRecap?: number[] }) {
  const prediction = ctx.model.predictOne({
    sequence: features.sequence,
    staticFeatures: features.staticFeatures,
    judgeIndices: features.judgeIndices,
    corpsId: features.corpsId,
    baselineRecap: override?.baselineRecap ?? features.baselineRecap,
    historyLen: features.observedHistoryLen,
    judgeBiasScale: features.judgeBiasScale,
    corpsScale: features.corpsScale,
    agnosticShowId: features.agnosticShowId,
  });
  return CAPTIONS.map((cap) => prediction.captions[cap].p50);
}

async function predictCurve(ctx: Ctx, t: ShowRow): Promise<number> {
  const hist = ctx.histByCorps.get(t.corps_key)!;
  const lastPct = hist[hist.length - 1].pct;
  const features = await featuresAtCutoff(ctx, t.corps_key, t.division_name, t.pct);
  const caps = runModel(ctx, features);
  const rank = ctx.ranks.get(t.corps_key) ?? 12;
  const grown = caps.map((v, i) =>
    Math.min(
      20,
      Math.max(0, v + Math.max(0, curveBaseline(rank, t.pct, CAPTIONS[i]) - curveBaseline(rank, lastPct, CAPTIONS[i])))
    )
  );
  return totalOf(grown);
}

async function predictTarget(ctx: Ctx, t: ShowRow): Promise<number> {
  const features = await featuresAtCutoff(ctx, t.corps_key, t.division_name, t.pct);
  const rank = ctx.ranks.get(t.corps_key) ?? 12;
  const curveCaps = curveVector(rank, t.pct);
  // Train-consistent: static rank-baseline slots hold curve(target %)/20 too.
  const staticFeatures = [...features.staticFeatures];
  for (let i = 0; i < CAPTIONS.length; i++) {
    staticFeatures[V9_FEATURE_INDICES.rankBaselineStart + i] = curveCaps[i] / 20;
  }
  const caps = runModel(ctx, { ...features, staticFeatures }, { baselineRecap: curveCaps });
  return totalOf(caps.map((v) => Math.min(20, Math.max(0, v))));
}

async function predictAr(ctx: Ctx, t: ShowRow): Promise<number> {
  const hist = ctx.histByCorps.get(t.corps_key)!;
  const steps = (ctx.futureByCorps.get(t.corps_key) ?? []).filter(
    (r) => r.competition_date <= t.competition_date
  );
  const features = await featuresAtCutoff(ctx, t.corps_key, t.division_name, t.pct);
  const rank = ctx.ranks.get(t.corps_key) ?? 12;
  let sequence = features.sequence.map((s: number[]) => [...s]);
  let staticFeatures = [...features.staticFeatures];
  let prevDate = hist[hist.length - 1].competition_date;
  let lastCaps: number[] | null = null;
  for (const step of steps) {
    const curveCaps = curveVector(rank, step.pct);
    const stat = [...staticFeatures];
    for (let i = 0; i < CAPTIONS.length; i++) {
      stat[V9_FEATURE_INDICES.rankBaselineStart + i] = curveCaps[i] / 20;
    }
    stat[V9_FEATURE_INDICES.showsRemaining] = Math.max(0, 1 - step.pct / 100);
    const caps = runModel(
      ctx,
      { ...features, sequence, staticFeatures: stat },
      { baselineRecap: curveCaps }
    );
    lastCaps = caps;
    if (step.competition_date === t.competition_date) break;
    // Feed the prediction back: shift the window, append a synthesized step.
    const lastReal = sequence.filter((s: number[]) => s[3] !== 1).pop() ?? sequence[sequence.length - 1];
    const synth = synthesizeStep(
      lastReal,
      prevDate,
      step.competition_date,
      step.pct,
      totalOf(caps),
      sequence.length - 1,
      sequence.length
    );
    sequence = [...sequence.slice(1), synth];
    prevDate = step.competition_date;
  }
  return lastCaps ? totalOf(lastCaps.map((v) => Math.min(20, Math.max(0, v)))) : NaN;
}

// ── Harness ───────────────────────────────────────────────────────────────────
const MODES = ['curve', 'target', 'ar', 'curveonly', 'persist'] as const;
type Mode = (typeof MODES)[number];

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cutoffs = (arg('cutoffs') ?? '2025-07-01,2025-07-15,2025-07-30').split(',');
  const sample = arg('sample') ? Number(arg('sample')) : undefined;

  const db = createClient({ url: `file:${path.resolve(process.cwd(), 'dci-relational.db')}` });
  const modelDir = findLatestV9SubcaptionModelDir();
  if (!modelDir) throw new Error('no model dir found');
  console.log(`model: ${modelDir}`);
  const { loadV9SubcaptionModel } = await import('../src/training/v9SubcaptionInference.js');
  const model = await loadV9SubcaptionModel(modelDir);

  const rows = await loadSeasonRows(db);
  console.log(`season rows: ${rows.length}`);

  const results: Array<{
    cutoff: string;
    mode: Mode;
    corps: string;
    show: string;
    date: string;
    horizonDays: number;
    predicted: number;
    actual: number;
  }> = [];

  for (const cutoff of cutoffs) {
    const histByCorps = new Map<string, ShowRow[]>();
    const futureByCorps = new Map<string, ShowRow[]>();
    for (const r of rows) {
      const m = r.competition_date < cutoff ? histByCorps : futureByCorps;
      const arr = m.get(r.corps_key) ?? [];
      arr.push(r);
      m.set(r.corps_key, arr);
    }
    const ranks = ranksAtCutoff(rows, cutoff);
    const ctx: Ctx = { db, model, ranks, cutoff, histByCorps, futureByCorps };

    let targets = rows.filter(
      (r) => r.competition_date >= cutoff && (histByCorps.get(r.corps_key)?.length ?? 0) > 0
    );
    if (sample) targets = targets.filter((_, i) => i % Math.ceil(targets.length / sample) === 0);
    console.log(`cutoff ${cutoff}: ${targets.length} (corps, show) targets`);

    let done = 0;
    for (const t of targets) {
      const hist = histByCorps.get(t.corps_key)!;
      const horizonDays = Math.round(
        (Date.parse(t.competition_date) - Date.parse(cutoff)) / 86_400_000
      );
      const rank = ranks.get(t.corps_key) ?? 12;
      const preds: Record<Mode, number> = {
        curve: await predictCurve(ctx, t),
        target: await predictTarget(ctx, t),
        ar: await predictAr(ctx, t),
        curveonly: totalOf(curveVector(rank, t.pct)),
        persist: hist[hist.length - 1].y_total,
      };
      for (const mode of MODES) {
        if (!Number.isFinite(preds[mode])) continue;
        results.push({
          cutoff,
          mode,
          corps: t.corps_key,
          show: t.competition_slug,
          date: t.competition_date,
          horizonDays,
          predicted: Number(preds[mode].toFixed(3)),
          actual: t.y_total,
        });
      }
      done++;
      if (done % 40 === 0) console.log(`  ${done}/${targets.length}`);
    }
  }

  // ── Scoring ────────────────────────────────────────────────────────────────
  const bucketOf = (d: number) => (d <= 7 ? '0-7d' : d <= 21 ? '8-21d' : '22d+');
  const table: Record<string, { n: number; sumAbs: number }> = {};
  for (const r of results) {
    for (const key of [
      `${r.cutoff}|${r.mode}|ALL`,
      `${r.cutoff}|${r.mode}|${bucketOf(r.horizonDays)}`,
    ]) {
      (table[key] ??= { n: 0, sumAbs: 0 });
      table[key].n++;
      table[key].sumAbs += Math.abs(r.predicted - r.actual);
    }
  }

  // Pairwise rank accuracy per show (same-division corps pairs).
  const rankAcc: Record<string, { ok: number; n: number }> = {};
  const byShow = new Map<string, typeof results>();
  for (const r of results) {
    const k = `${r.cutoff}|${r.mode}|${r.show}`;
    (byShow.get(k) ?? byShow.set(k, []).get(k)!).push(r);
  }
  for (const [key, list] of byShow) {
    const [cutoff, mode] = key.split('|');
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.actual === b.actual) continue;
        const k = `${cutoff}|${mode}`;
        (rankAcc[k] ??= { ok: 0, n: 0 });
        rankAcc[k].n++;
        if (Math.sign(a.predicted - b.predicted) === Math.sign(a.actual - b.actual)) rankAcc[k].ok++;
      }
  }

  console.log('\n=== MAE (points) ===');
  console.log('cutoff      mode       ALL     0-7d    8-21d   22d+    pairwise-rank');
  for (const cutoff of cutoffs) {
    for (const mode of MODES) {
      const cell = (b: string) => {
        const e = table[`${cutoff}|${mode}|${b}`];
        return e ? (e.sumAbs / e.n).toFixed(2).padStart(6) : '     —';
      };
      const ra = rankAcc[`${cutoff}|${mode}`];
      const raStr = ra ? `${((100 * ra.ok) / ra.n).toFixed(1)}%` : '—';
      console.log(
        `${cutoff}  ${mode.padEnd(9)} ${cell('ALL')} ${cell('0-7d')} ${cell('8-21d')} ${cell('22d+')}   ${raStr}`
      );
    }
    console.log('');
  }

  const out = path.resolve(process.cwd(), `results/backtest-prediction-modes-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ cutoffs, results }, null, 1));
  console.log(`wrote ${out} (${results.length} rows)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
