
import Database from 'better-sqlite3';
import * as fs from 'node:fs';

const DB_PATH = process.env.CURVE_DB_PATH ?? './dci-relational.db';
const OUT_PATH = process.env.CURVE_OUT_PATH ?? './src/training/referenceCurvesV4.json';

// The 8 canonical caption slugs, in output order.
const CAPTIONS = ["GE1", "GE2", "VP", "VA", "CG", "MB", "MA", "MP"] as const;

// Source: the `clean_reference_curve_metric_scores` VIEW (the domain semantic
// layer), NOT raw `caption_scores`. The view already does the cleaning we used to
// (badly) approximate here — see DATA_QUALITY_NOTES.md §11:
//   - `domain_caption_aliases` normalizes caption names → slug (handles the
//     "Visual - Analysis" vs "Visual Analysis" drift via a table, not a typo-prone
//     hardcoded map — this is what silently dropped VA before).
//   - `domain_divisions.is_model_division` + `domain_event_exclusion_patterns`
//     drop I&E / individual / showcase rows (the 80-99 "total leakage").
//   - per-caption min/max bounds + `total_score > 0` drop zeros / DNP panels.
//   - `ABS(caption_total - total_score) <= 0.05` keeps only rows whose 8 captions
//     actually sum to the total — a real integrity gate, not a heuristic.
//   - `rank_bucket` is the clamped [1,25] competition-division rank.
// Backtested strictly better than the old raw+filter curve (target, curve, and
// pairwise-rank all improved). We keep this generator's guards below as the
// complementary safety net regardless of source.

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  console.log('Computing V4 Reference Curves (Rank/Pct/Caption) from', DB_PATH);

  // 1. Fetch from the clean view. metric_name is already the slug; rank_bucket is
  // the clamped [1,25] rank; percent_bucket is the 5-pt bucket; rows are already
  // cleaned + sum-reconciled. World Class only, to match the legacy v4 lookup keys.
  const rows = db.prepare(`
    SELECT rank_bucket AS rank, percent_bucket AS bucket, metric_name AS slug, score
    FROM clean_reference_curve_metric_scores
    WHERE division_name = 'World Class'
      AND metric_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
      AND rank_bucket BETWEEN 1 AND 25
      AND score IS NOT NULL
  `).all() as { rank: number, bucket: number, slug: string, score: number }[];

  // 2. Aggregate. Key: "RANK-BUCKET" -> { GE1: {sum, count}, GE2: ... }
  const curves: Record<string, Record<string, { sum: number, count: number }>> = {};

  // Track rows per caption. Zero for any caption ⇒ the view stopped emitting it
  // (alias/table drift) — asserted below instead of shipping a hole.
  const matchedPerSlug: Record<string, number> = {};

  for (const row of rows) {
    const slug = row.slug;
    matchedPerSlug[slug] = (matchedPerSlug[slug] ?? 0) + 1;

    const key = `${row.rank}-${row.bucket}`;
    if (!curves[key]) curves[key] = {};
    if (!curves[key][slug]) curves[key][slug] = { sum: 0, count: 0 };
    curves[key][slug].sum += row.score;
    curves[key][slug].count += 1;
  }

  // 3. Compute Averages & Interpolate
  // Structure: { "1-0": { GE1: 15.2, ... }, ... }
  const finalLookup: Record<string, Record<string, number>> = {};

  // Fill computed averages
  for (const [key, caps] of Object.entries(curves)) {
    finalLookup[key] = {};
    for (const [cap, data] of Object.entries(caps)) {
      finalLookup[key][cap] = Number((data.sum / data.count).toFixed(3));
    }
  }

  // 4. Fallback / Interpolation logic (Basic global fill for now)
  // Just ensure we have valid JSON structure. Real interpolation happens at consumption or we can fill gaps here.
  // The plan asked to "Implement interpolation for sparse buckets".
  // Let's do simple linear interpolation for missing buckets 0..100 for ranks 1..25

  const ranks = Array.from({ length: 25 }, (_, i) => i + 1);
  const buckets = Array.from({ length: 21 }, (_, i) => i * 5); // 0, 5 ... 100
  const captions = [...CAPTIONS];

  // Helper to get value
  const getVal = (r: number, b: number, c: string) => finalLookup[`${r}-${b}`]?.[c];

  // First pass: Fill exact missing with previous value (forward fill) or global defaults
  // Better: Gather all known points for (rank, caption) and interpolate.

  // Let's stick to generating the sparse lookup for now to match the "raw" reference curves,
  // and handle sophisticated fallback in the consumer (or a simplified version here).
  // Actually, generating a dense lookup is safer for the training script.

  for (const rank of ranks) {
    for (const cap of captions) {
      // Collect valid points [pct, score]
      const points: [number, number][] = [];
      for (const b of buckets) {
        const val = getVal(rank, b, cap);
        if (val !== undefined) points.push([b, val]);
      }

      if (points.length === 0) continue; // No data for this rank/caption

      // Interpolate for all buckets
      for (const b of buckets) {
        const key = `${rank}-${b}`;
        if (!finalLookup[key]) finalLookup[key] = {};
        if (finalLookup[key][cap] !== undefined) continue; // Already exists

        // Find nearest neighbors
        // Simple strategy: Linear interpolation
        let lower = -1, upper = -1;

        // Find lower bound
        for (let i = points.length - 1; i >= 0; i--) {
          if (points[i]![0] < b) {
            lower = i;
            break;
          }
        }

        // Find upper bound
        for (let i = 0; i < points.length; i++) {
          if (points[i]![0] > b) {
            upper = i;
            break;
          }
        }

        let val: number;
        if (lower !== -1 && upper !== -1) {
          const [p1, v1] = points[lower]!;
          const [p2, v2] = points[upper]!;
          val = v1 + (v2 - v1) * ((b - p1) / (p2 - p1));
        } else if (lower !== -1) {
          val = points[lower]![1]; // Forward fill
        } else if (upper !== -1) {
          val = points[upper]![1]; // Backward fill
        } else {
          val = 0; // Should not happen given check above
        }

        finalLookup[key][cap] = Number(val.toFixed(3));
      }
    }
  }

  // 4a0. Drop keys outside the consumer's lookup range. v9Baselines clamps rank
  // to [1,25] (selectRank → Math.max(1, Math.min(25, …))), so any rank>25 cell —
  // incl. the sparse "100-*" unranked sentinels and thin rank 26-40 raw rows —
  // is NEVER read. Keeping them only bloats the file and trips sanity checks on
  // noise. Restrict output to the ranks that are actually used.
  const MAX_RANK = 25;
  for (const key of Object.keys(finalLookup)) {
    const rank = Number(key.split('-')[0]);
    if (!Number.isFinite(rank) || rank < 1 || rank > MAX_RANK) delete finalLookup[key];
  }

  // 4a0b. Guarantee full [1,25] rank coverage. The consumer (`v9Baselines.ts`
  // `selectRank`) CLAMPS the lookup rank to [1,25], but the data can be sparse at
  // the deep field — e.g. no World-Class corps has ever placed 25th (max field is
  // 24), so there's no rank-25 row. A clamped rank-25 lookup would then miss every
  // fallback and hit the hard-coded 15 default (a garbage baseline for all 8
  // captions). Clone the nearest present rank into any missing rank so the whole
  // clamp range always resolves. (Rank 25 ≈ rank 24 — both deep field.)
  {
    const buckets = Array.from({ length: 21 }, (_, i) => i * 5);
    const rankHasData = (r: number) => buckets.some((b) => finalLookup[`${r}-${b}`]);
    for (let r = 1; r <= MAX_RANK; r++) {
      if (rankHasData(r)) continue;
      // nearest present rank (prefer lower/adjacent)
      let src = -1;
      for (let d = 1; d < MAX_RANK && src < 0; d++) {
        if (r - d >= 1 && rankHasData(r - d)) src = r - d;
        else if (r + d <= MAX_RANK && rankHasData(r + d)) src = r + d;
      }
      if (src < 0) continue; // no data anywhere — the guard will reject
      for (const b of buckets) {
        const from = finalLookup[`${src}-${b}`];
        if (from) finalLookup[`${r}-${b}`] = { ...from };
      }
      console.log(`Filled missing rank ${r} from nearest rank ${src} (deep-field clamp coverage).`);
    }
  }

  // 4a. Fill any residual hole (e.g. the sparse rank-100 sentinel key) with the
  // key's sibling mean, so a caption is never absent for a key that exists. VA≈
  // its siblings, so the mean is the right anchor; this is the last line of
  // defense before the completeness guard below.
  for (const [key, caps] of Object.entries(finalLookup)) {
    const missing = captions.filter((c) => caps[c] === undefined);
    if (!missing.length) continue;
    const present = captions.filter((c) => caps[c] !== undefined).map((c) => caps[c]!);
    if (!present.length) continue; // nothing to anchor to — leave for the guard to reject
    const mean = Number((present.reduce((a, b) => a + b, 0) / present.length).toFixed(3));
    for (const c of missing) caps[c] = mean;
  }

  // 4b. Fail-loud validation — refuse to write a corrupt/incomplete curve.
  // This is the guard that would have stopped the VA regression at the source.
  const problems: string[] = [];

  // (a) Every mapped caption must have matched source rows. Zero = name drift.
  for (const cap of captions) {
    if (!matchedPerSlug[cap]) {
      problems.push(
        `caption "${cap}" matched 0 rows from clean_reference_curve_metric_scores — the view/alias table likely drifted`
      );
    }
  }

  // (b) Every curve key must carry every caption (no silent holes).
  for (const [key, caps] of Object.entries(finalLookup)) {
    const missing = captions.filter((c) => caps[c] === undefined);
    if (missing.length) problems.push(`key ${key} missing captions: ${missing.join(',')}`);
  }

  // (c) No caption may sit anomalously far below its siblings at the same key
  // (the intra-key detector that surfaced the corruption). VA at ~8.8 while
  // every sibling was ~18 is exactly this.
  for (const [key, caps] of Object.entries(finalLookup)) {
    for (const cap of captions) {
      const self = caps[cap];
      const sibs = captions.filter((c) => c !== cap && caps[c] !== undefined).map((c) => caps[c]!);
      if (self === undefined || sibs.length < 4) continue;
      const sibMean = sibs.reduce((a, b) => a + b, 0) / sibs.length;
      if (sibMean - self > 3) {
        problems.push(`key ${key} caption ${cap}=${self} is ${(sibMean - self).toFixed(1)}pts BELOW sibling mean ${sibMean.toFixed(1)}`);
      }
      if (self - sibMean > 3) {
        problems.push(`key ${key} caption ${cap}=${self} is ${(self - sibMean).toFixed(1)}pts ABOVE sibling mean ${sibMean.toFixed(1)} (total-value leakage?)`);
      }
    }
  }

  if (problems.length) {
    console.error(`\n❌ Reference-curve validation FAILED (${problems.length} problem(s)) — NOT writing ${OUT_PATH}:`);
    for (const p of problems.slice(0, 20)) console.error('   - ' + p);
    if (problems.length > 20) console.error(`   … and ${problems.length - 20} more`);
    process.exit(1);
  }
  console.log(`Read ${rows.length} clean caption-cells; Validation OK: ${captions.length} captions across ${Object.keys(finalLookup).length} keys, no sibling anomalies.`);

  // 5. Save
  const output = {
    version: "v4",
    captions,
    curves: finalLookup
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Saved reference curves to ${OUT_PATH}`);

  // Verification
  console.log("Validation Check (Rank 1 vs 12 at 100%):");
  const r1 = finalLookup["1-100"];
  const r12 = finalLookup["12-100"];
  if (r1 && r12) {
    for (const cap of captions) {
      if (r1[cap] && r12[cap]) {
        console.log(`${cap}: Rank 1=${r1[cap]}, Rank 12=${r12[cap]} ${r1[cap]! > r12[cap]! ? 'OK' : 'FAIL'}`);
      }
    }
  }
}

main();
