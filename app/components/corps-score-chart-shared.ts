// Shared (recharts-free) helpers for the corps score chart, so the SSR'd shell
// (corps-score-chart.tsx) and the lazy recharts body (corps-score-chart-body.tsx)
// can both use them without either pulling recharts into the other's chunk.
import type { CorpsSeasonPoint, CorpsSeasonSnapshotRow } from '@/lib/corps-directory';

export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export type Row = {
  label: string;
  date: string;
  predicted: number | null;
  actual: number | null;
  band: [number, number] | null;
};

export const toRow = (p: CorpsSeasonPoint | CorpsSeasonSnapshotRow): Row => ({
  label: p.label,
  date: p.date,
  predicted: p.predicted,
  actual: p.actual,
  band: p.low != null && p.high != null ? [p.low, p.high] : null,
});
