// Caption breakdown for a judge, shared by two surfaces:
//  - profile page: counted client-side from the full `assignments` array.
//  - directory cards: pre-counted pairs shipped in `summary.captionBreakdown`.
// Both feed the same slice builder so ordering (GE → Visual → Music) and colors
// stay identical. No query/endpoint/cache — pure reduce over in-memory data.

import type { JudgeAssignment, CaptionCount } from '@/lib/judge-directory';
import { byCaptionFamily, captionSwatchVar } from '@/lib/caption-family';

export type CaptionSlice = {
  caption: string;
  count: number;
  /** Share of total, 0–1. */
  pct: number;
  /** Raw CSS color (saturated family hue) for recharts/SVG fills. */
  colorVar: string;
};

/** Core: turn caption→count pairs into ordered, colored, percentaged slices. */
export const captionSlices = (counts: readonly CaptionCount[]): CaptionSlice[] => {
  // Coalesce in case the same caption appears more than once.
  const merged = new Map<string, number>();
  for (const { caption, count } of counts) {
    merged.set(caption, (merged.get(caption) ?? 0) + count);
  }
  const total = [...merged.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return [];

  return [...merged.entries()]
    .sort(([a], [b]) => byCaptionFamily(a, b))
    .map(([caption, count]) => ({
      caption,
      count,
      pct: count / total,
      colorVar: captionSwatchVar(caption),
    }));
};

/** Convenience: count a judge's assignments by `caption_name`, then slice. */
export const buildCaptionBreakdown = (assignments: readonly JudgeAssignment[]): CaptionSlice[] =>
  captionSlices(assignments.map((a) => ({ caption: a.caption_name, count: 1 })));
