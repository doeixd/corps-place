
import Database from 'better-sqlite3';
import * as fs from 'node:fs';

const DB_PATH = './dci-relational.db';
const OUT_PATH = './src/training/referenceCurvesV4.json';

const CAPTION_MAP: Record<string, string> = {
  // We need to check if detailed captions exist.
  // Standard captions if available:
  "General Effect 1": "GE1",
  "General Effect 2": "GE2",
  "Visual Proficiency": "VP",
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

  for (const row of rows) {
    const slug = CAPTION_MAP[row.caption_name];
    if (!slug) continue; // Skip unknown captions

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
  const captions = Object.values(CAPTION_MAP);

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
