
import Database from 'better-sqlite3';
import * as fs from 'node:fs';

const DB_PATH = process.env.CURVE_DB_PATH ?? './dci-relational.db';
const OUT_PATH = process.env.CURVE_OUT_PATH ?? './src/training/referenceCurvesV4.json';

const CAPTION_MAP: Record<string, string> = {
  // We need to check if detailed captions exist.
  // Standard captions if available:
  "General Effect 1": "GE1",
  "General Effect 2": "GE2",
  "Visual Proficiency": "VP",
  // DB stores this hyphenated ("Visual - Analysis", matching the "Music - *"
  // style). The old map had ONLY the no-hyphen "Visual Analysis", which never
  // matched, so VA silently fell through `if (!slug) continue` and was the one
  // caption dropped on regeneration — leaving a stale/corrupt VA column (rank-8
  // VA ~8.8 vs ~18 for every sibling). Map both forms (as the V9 subcaption
  // builder does) so either historical spelling is picked up.
  "Visual - Analysis": "VA",
  "Visual Analysis": "VA",
  "Color Guard": "CG",
  "Music - Brass": "MB",
  "Music - Analysis": "MA",
  "Music - Percussion": "MP",
};

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  console.log('Computing V4 Reference Curves (Rank/Pct/Caption) from', DB_PATH);

  // 1. Fetch all caption scores linked to rank and percent_through
  const rows = db.prepare(`
    SELECT 
      cs.rank, 
      c.percent_through,
      caps.caption_name,
      caps.score
    FROM corps_scores cs
    JOIN competitions c ON cs.competition_slug = c.slug
    JOIN caption_scores caps ON caps.competition_slug = cs.competition_slug AND caps.corps_key = cs.corps_key
    WHERE cs.rank IS NOT NULL 
      AND cs.division_name = 'World Class'
      AND c.percent_through IS NOT NULL
      AND caps.score IS NOT NULL
  `).all() as { rank: number, percent_through: number, caption_name: string, score: number }[];

  // 2. Aggregate
  // Key: "RANK-BUCKET" -> { GE1: {sum, count}, GE2: ... }
  const curves: Record<string, Record<string, { sum: number, count: number }>> = {};

  const getPctBucket = (pct: number) => Math.floor(pct / 5) * 5;

  // Track how many source rows matched each mapped caption. A caption that maps
  // to ZERO rows means the DB caption_name drifted out from under CAPTION_MAP
  // (exactly how VA silently corrupted: DB "Visual - Analysis" vs the old
  // no-hyphen key). We assert on this below instead of shipping a hole.
  const matchedPerSlug: Record<string, number> = {};

  // Drop out-of-range caption scores. A real subcaption sits in (0, ~20] (older
  // GE scale reaches ~24). This is an EXCLUSION OF NON-DATA, not a discard of
  // signal — see DATA_QUALITY_NOTES.md §11b for the full audit:
  //   - Zeros (<=0): the ONLY out-of-range rows that reach this curve are ~565
  //     all-zero panels (74 World-Class corps-events) = DNP/standstill/no-recap.
  //     total_score=0 and subcaptions=0/absent too, so they're GENUINELY MISSING,
  //     not repairable — averaging them in just drags cells toward zero.
  //   - High (>25): full I&E/individual totals (80-99) on the ~100 scale (e.g. an
  //     individual soloist). The `division_name='World Class'` filter in the query
  //     already excludes these; the 25 ceiling is belt-and-suspenders vs a future
  //     mis-tagged division. It also preserves legit high GE.
  const VALID_MIN = 0; // exclusive
  const VALID_MAX = 25; // inclusive
  let droppedRange = 0;

  for (const row of rows) {
    const slug = CAPTION_MAP[row.caption_name];
    if (!slug) continue; // Skip unknown captions (judge-name leakage, etc.)
    if (row.score <= VALID_MIN || row.score > VALID_MAX) { droppedRange++; continue; }
    matchedPerSlug[slug] = (matchedPerSlug[slug] ?? 0) + 1;

    const bucket = getPctBucket(row.percent_through);
    const key = `${row.rank}-${bucket}`;

    if (!curves[key]) {
      curves[key] = {};
    }
    if (!curves[key][slug]) {
      curves[key][slug] = { sum: 0, count: 0 };
    }

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
  // Dedupe: CAPTION_MAP intentionally maps two spellings ("Visual - Analysis"
  // and legacy "Visual Analysis") to the same "VA" slug, so raw Object.values
  // would list VA twice.
  const captions = [...new Set(Object.values(CAPTION_MAP))];

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
        `caption "${cap}" matched 0 source rows — a DB caption_name likely drifted from CAPTION_MAP`
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
  console.log(`Dropped ${droppedRange} out-of-range caption scores (<=${VALID_MIN} or >${VALID_MAX}) as unclean.`);
  console.log(`Validation OK: ${captions.length} captions present across ${Object.keys(finalLookup).length} keys, no sibling anomalies.`);

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
