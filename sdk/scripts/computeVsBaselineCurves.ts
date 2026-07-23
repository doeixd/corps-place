// DISPLAY-ONLY division-aware reference curves for the /vs comparison chart.
//
// This is the DISPLAY sibling of computeReferenceCurvesV4.ts. That script emits
// src/training/referenceCurvesV4.json, which is on the MODEL-SERVING path and is
// World-Class-only under plain `rank-bucket` keys — DO NOT touch it here.
//
// This script emits src/readModel/vsBaselineCurves.json: the SAME clean source
// (the `clean_reference_curve_metric_scores` VIEW), but keyed BY DIVISION so the
// /vs baseline picker can offer a real "World 5th place" vs "Open 5th place"
// line (Open Class scores sit distinctly lower; forcing OC corps onto the WC
// baseline was wrong). Verified pre-clamp: cross-division mixing was NOT the
// inversion source (the served curve was already WC-only) — the residual
// deep-field non-monotonicity is handled by a per-division clamp at DISPLAY time
// in buildVsBaselineCurve (the artifact stays honest).
//
// Rank caps are chosen where each division's data is actually real (see
// DATA_QUALITY_NOTES.md §11e): World Class 1–20 (ranks 1–7 fully populated,
// 8–20 thin but present), Open Class 1–10 (1–6 well populated, 7–10 thin). Deep
// buckets are linearly interpolated within a (division, rank, caption), matching
// the model-serving generator's fill so a rank never renders a hole.
import Database from 'better-sqlite3';
import * as fs from 'node:fs';

const DB_PATH = process.env.CURVE_DB_PATH ?? './dci-relational.db';
const OUT_PATH = process.env.VS_BASELINE_OUT_PATH ?? './src/readModel/vsBaselineCurves.json';

const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;

// Per-division max rank the picker will offer (real-data cap; see header).
const DIVISION_MAX_RANK: Record<string, number> = {
  'World Class': 20,
  'Open Class': 10,
};

const BUCKETS = Array.from({ length: 21 }, (_, i) => i * 5); // 0,5,…,100

function buildDivision(
  rows: { rank: number; bucket: number; slug: string; score: number }[],
  maxRank: number
): { lookup: Record<string, Record<string, number>>; matchedPerSlug: Record<string, number> } {
  const curves: Record<string, Record<string, { sum: number; count: number }>> = {};
  const matchedPerSlug: Record<string, number> = {};
  for (const row of rows) {
    if (row.rank < 1 || row.rank > maxRank) continue;
    matchedPerSlug[row.slug] = (matchedPerSlug[row.slug] ?? 0) + 1;
    const key = `${row.rank}-${row.bucket}`;
    (curves[key] ??= {});
    (curves[key][row.slug] ??= { sum: 0, count: 0 });
    curves[key][row.slug]!.sum += row.score;
    curves[key][row.slug]!.count += 1;
  }

  const lookup: Record<string, Record<string, number>> = {};
  for (const [key, caps] of Object.entries(curves)) {
    lookup[key] = {};
    for (const [cap, d] of Object.entries(caps)) lookup[key][cap] = Number((d.sum / d.count).toFixed(3));
  }

  const ranks = Array.from({ length: maxRank }, (_, i) => i + 1);
  const getVal = (r: number, b: number, c: string) => lookup[`${r}-${b}`]?.[c];

  // Linear interpolation within (rank, caption) across buckets (forward/back fill
  // at the ends). Identical strategy to the model-serving generator.
  for (const rank of ranks) {
    for (const cap of CAPTIONS) {
      const points: [number, number][] = [];
      for (const b of BUCKETS) {
        const v = getVal(rank, b, cap);
        if (v !== undefined) points.push([b, v]);
      }
      if (points.length === 0) continue;
      for (const b of BUCKETS) {
        const key = `${rank}-${b}`;
        (lookup[key] ??= {});
        if (lookup[key][cap] !== undefined) continue;
        let lo = -1, hi = -1;
        for (let i = points.length - 1; i >= 0; i--) if (points[i]![0] < b) { lo = i; break; }
        for (let i = 0; i < points.length; i++) if (points[i]![0] > b) { hi = i; break; }
        let val: number;
        if (lo !== -1 && hi !== -1) {
          const [p1, v1] = points[lo]!; const [p2, v2] = points[hi]!;
          val = v1 + (v2 - v1) * ((b - p1) / (p2 - p1));
        } else if (lo !== -1) val = points[lo]![1];
        else val = points[hi]![1];
        lookup[key][cap] = Number(val.toFixed(3));
      }
    }
  }

  // Clone any rank with NO data at all from the nearest present rank, so the whole
  // [1,maxRank] range resolves (defensive; both divisions have data everywhere in
  // range today).
  const rankHasData = (r: number) => BUCKETS.some((b) => lookup[`${r}-${b}`]?.GE1 !== undefined);
  for (let r = 1; r <= maxRank; r++) {
    if (rankHasData(r)) continue;
    let src = -1;
    for (let d = 1; d < maxRank && src < 0; d++) {
      if (r - d >= 1 && rankHasData(r - d)) src = r - d;
      else if (r + d <= maxRank && rankHasData(r + d)) src = r + d;
    }
    if (src < 0) continue;
    for (const b of BUCKETS) { const f = lookup[`${src}-${b}`]; if (f) lookup[`${r}-${b}`] = { ...f }; }
  }

  // Drop keys outside [1,maxRank].
  for (const key of Object.keys(lookup)) {
    const r = Number(key.split('-')[0]);
    if (!Number.isFinite(r) || r < 1 || r > maxRank) delete lookup[key];
  }
  return { lookup, matchedPerSlug };
}

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  console.log('Computing DIVISION-AWARE /vs baseline curves from', DB_PATH);

  const all = db.prepare(`
    SELECT division_name AS div, rank_bucket AS rank, percent_bucket AS bucket,
           metric_name AS slug, score
    FROM clean_reference_curve_metric_scores
    WHERE metric_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
      AND rank_bucket BETWEEN 1 AND 25
      AND score IS NOT NULL
      AND division_name IN ('World Class','Open Class')
  `).all() as { div: string; rank: number; bucket: number; slug: string; score: number }[];

  const byDiv: Record<string, typeof all> = {};
  for (const r of all) (byDiv[r.div] ??= []).push(r);

  const curves: Record<string, Record<string, Record<string, number>>> = {};
  const problems: string[] = [];
  for (const [div, maxRank] of Object.entries(DIVISION_MAX_RANK)) {
    const rows = byDiv[div] ?? [];
    if (!rows.length) { problems.push(`division "${div}" has 0 source rows`); continue; }
    const { lookup, matchedPerSlug } = buildDivision(rows, maxRank);
    for (const cap of CAPTIONS)
      if (!matchedPerSlug[cap]) problems.push(`${div}: caption "${cap}" matched 0 rows`);
    for (const [key, caps] of Object.entries(lookup)) {
      const missing = CAPTIONS.filter((c) => caps[c] === undefined);
      if (missing.length) problems.push(`${div} key ${key} missing: ${missing.join(',')}`);
    }
    curves[div] = lookup;
    console.log(`  ${div}: ranks 1–${maxRank}, ${Object.keys(lookup).length} keys`);
  }

  if (problems.length) {
    console.error(`\n❌ VS baseline validation FAILED (${problems.length}) — NOT writing ${OUT_PATH}:`);
    for (const p of problems.slice(0, 20)) console.error('   - ' + p);
    process.exit(1);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    version: 'vs-baseline-v1',
    captions: [...CAPTIONS],
    maxRank: DIVISION_MAX_RANK,
    curves,
  }, null, 2));
  console.log(`Saved ${OUT_PATH}`);

  // Sanity: WC rank 5 @ 50% total vs OC rank 5 @ 50% total.
  const totalOf = (c: Record<string, number>) =>
    c.GE1 + c.GE2 + (c.VP + c.VA + c.CG) / 2 + (c.MB + c.MA + c.MP) / 2;
  const wc5 = curves['World Class']?.['5-50'];
  const oc5 = curves['Open Class']?.['5-50'];
  if (wc5 && oc5)
    console.log(`Sanity: WC 5th @50%=${totalOf(wc5).toFixed(1)}, OC 5th @50%=${totalOf(oc5).toFixed(1)} (OC should be lower)`);
}

main();
