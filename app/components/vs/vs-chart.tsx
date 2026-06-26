// <VsChart> — the presentational multi-series comparison chart (plan M2). Plots
// each resolved series against % through season (0–100), so corps/seasons/
// baselines align on one x-axis. One or two <Line>s per series (a 2026 corps =
// actual solid + predicted dashed). Theme-aware colors via assignVsColors; SSR
// guard mirrors corps-score-chart to avoid hydration CLS.
import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useSelector } from '@xstate/react';
import { themeStore } from '@/stores/theme-store';
import { assignVsColors } from '@/lib/vs/colors';
import type { VsResolvedSeries } from '@/lib/vs/types';
import { VsLegend, VsTooltip, type VsCellMeta, type VsLegendItem } from './chart-primitives';

interface MergedRow {
  pct: number;
  __meta: Record<string, VsCellMeta>;
  [dataKey: string]: number | Record<string, VsCellMeta>;
}

const lineKey = (seriesId: string, lineIdx: number) => `${seriesId}@@${lineIdx}`;

/** Merge every series' points into rows keyed by pct; each (series,line) gets a
 *  dataKey column, with per-cell metadata for the tooltip. Gaps stay undefined
 *  (Recharts `connectNulls` bridges within a line; absent points never read 0). */
function mergeRows(series: VsResolvedSeries[]): MergedRow[] {
  const byPct = new Map<number, MergedRow>();
  const rowFor = (pct: number): MergedRow => {
    let r = byPct.get(pct);
    if (!r) {
      r = { pct, __meta: {} };
      byPct.set(pct, r);
    }
    return r;
  };
  for (const s of series) {
    s.lines.forEach((line, li) => {
      const key = lineKey(s.id, li);
      for (const p of line.points) {
        const row = rowFor(p.pct);
        row[key] = p.value;
        row.__meta[key] = {
          seriesId: s.id,
          seriesLabel: s.label,
          color: s.color,
          dashed: line.style === 'dashed',
          date: p.date,
          eventLabel: p.eventLabel,
        };
      }
    });
  }
  return [...byPct.values()].sort((a, b) => a.pct - b.pct);
}

export function VsChart({
  series,
  onRemove,
  height = 'h-80',
}: {
  series: VsResolvedSeries[];
  /** When provided, legend rows get a remove (×). */
  onRemove?: (id: string) => void;
  /** Tailwind height class for the plot box (kept identical SSR + client). */
  height?: string;
}) {
  const theme = useSelector(themeStore, (s) => s.context.theme);
  const colored = useMemo(() => assignVsColors(series, theme), [series, theme]);
  const rows = useMemo(() => mergeRows(colored), [colored]);

  const legendItems = useMemo<VsLegendItem[]>(
    () =>
      colored.map((s) => ({
        id: s.id,
        label: s.label,
        color: s.color,
        hasDashed: s.lines.some((l) => l.style === 'dashed'),
      })),
    [colored]
  );

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="space-y-3">
      {!mounted ? (
        <div className={`${height} w-full`} />
      ) : (
        <div className={`${height} w-full`}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 8, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="pct"
                type="number"
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                tickLine={false}
                axisLine={{ stroke: 'var(--color-border)' }}
                label={{
                  value: 'Season progress',
                  position: 'insideBottom',
                  offset: -4,
                  fontSize: 11,
                  fill: 'var(--color-muted-foreground)',
                }}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Tooltip content={<VsTooltip />} />
              {colored.flatMap((s) =>
                s.lines.map((line, li) => (
                  <Line
                    key={lineKey(s.id, li)}
                    name={s.label}
                    dataKey={lineKey(s.id, li)}
                    type="monotone"
                    stroke={s.color}
                    strokeWidth={line.style === 'dashed' ? 2 : 2.5}
                    strokeDasharray={line.style === 'dashed' ? '5 4' : undefined}
                    dot={{ r: 2, fill: s.color }}
                    activeDot={{ r: 4 }}
                    connectNulls
                    isAnimationActive={false}
                  />
                ))
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
      <VsLegend items={legendItems} onRemove={onRemove} />
    </div>
  );
}
