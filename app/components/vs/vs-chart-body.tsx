// The recharts-rendering half of <VsChart>, split into its own module so it can
// be lazy-loaded: recharts (~330KB) then loads in the background after the chart
// shell (fixed-height box + legend) has already SSR'd, so there's no layout
// shift and the page paints without waiting on the chart library.
import { useMemo } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { cn } from '@/lib/utils';
import type { VsResolvedSeries } from '@/lib/vs/types';
import { VsTooltip, type VsCellMeta } from './chart-primitives';
import { useChartZoom, RESET_ZOOM_CLASS } from '@/lib/use-chart-zoom';

interface MergedRow {
  pct: number;
  __meta: Record<string, VsCellMeta>;
  [dataKey: string]: number | [number, number] | Record<string, VsCellMeta>;
}

const lineKey = (seriesId: string, lineIdx: number) => `${seriesId}@@${lineIdx}`;

const GHOST_ID = 'ghost';
const GHOST_OPACITY = 0.4;

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
        if (p.low != null && p.high != null) row[`${key}__band`] = [p.low, p.high];
        row.__meta[key] = {
          seriesId: s.id,
          seriesLabel: s.label,
          color: s.color,
          dashed: line.style === 'dashed',
          date: p.date,
          eventLabel: p.eventLabel,
          ghost: s.id === GHOST_ID,
        };
      }
    });
  }
  return [...byPct.values()].sort((a, b) => a.pct - b.pct);
}

export default function VsChartBody({
  colored,
  ghostColored,
  ghostShown,
  yLabel,
  height,
  highlighted,
}: {
  colored: VsResolvedSeries[];
  ghostColored: VsResolvedSeries | null;
  ghostShown: boolean;
  yLabel?: string;
  height: string;
  highlighted: string | null;
}) {
  const rows = useMemo(
    () => mergeRows(ghostColored ? [...colored, ghostColored] : colored),
    [colored, ghostColored]
  );
  const dimmed = (id: string) => highlighted != null && id !== highlighted;

  const { xDomain, zoomed, reset, wrapRef, handlers, touchAction } = useChartZoom({
    min: 0,
    max: 100,
    minSpan: 5,
  });

  // Y domain follows the visible x-window so zooming in actually spreads the
  // lines vertically (recharts' 'auto' considers ALL data, not the window).
  const yDomain = useMemo<[number | string, number | string]>(() => {
    if (!xDomain) return ['auto', 'auto'];
    const [lo, hi] = xDomain;
    let min = Infinity;
    let max = -Infinity;
    for (const row of rows) {
      if (row.pct < lo || row.pct > hi) continue;
      for (const [k, v] of Object.entries(row)) {
        if (k === 'pct' || k === '__meta') continue;
        if (typeof v === 'number') {
          min = Math.min(min, v);
          max = Math.max(max, v);
        } else if (Array.isArray(v)) {
          min = Math.min(min, v[0]);
          max = Math.max(max, v[1]);
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return ['auto', 'auto'];
    const pad = Math.max((max - min) * 0.08, 0.5);
    return [Math.floor((min - pad) * 10) / 10, Math.ceil((max + pad) * 10) / 10];
  }, [rows, xDomain]);

  return (
    <div
      ref={wrapRef}
      className={`${height} relative w-full select-none`}
      style={{ touchAction }}
      {...handlers}
      onDoubleClick={reset}
    >
      {zoomed ? (
        <button type="button" onClick={reset} className={`${RESET_ZOOM_CLASS} right-2`}>
          Reset zoom
        </button>
      ) : null}
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 8, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="pct"
            type="number"
            domain={xDomain ?? [0, 100]}
            allowDataOverflow
            ticks={xDomain ? undefined : [0, 25, 50, 75, 100]}
            tickFormatter={(v: number) => `${Math.round(v)}%`}
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
            domain={yDomain}
            allowDataOverflow
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={yLabel ? 52 : 40}
            label={
              yLabel
                ? {
                    value: yLabel,
                    angle: -90,
                    position: 'insideLeft',
                    fontSize: 11,
                    fill: 'var(--color-muted-foreground)',
                    style: { textAnchor: 'middle' },
                  }
                : undefined
            }
          />
          <Tooltip content={<VsTooltip />} />
          {/* Uncertainty bands first (behind the lines). */}
          {colored.flatMap((s) =>
            s.lines.flatMap((line, li) =>
              line.points.some((p) => p.low != null && p.high != null)
                ? [
                    <Area
                      key={`${lineKey(s.id, li)}__band`}
                      dataKey={`${lineKey(s.id, li)}__band`}
                      stroke="none"
                      fill={s.color}
                      fillOpacity={0.12}
                      connectNulls
                      legendType="none"
                      activeDot={false}
                      className={cn('vs-series', dimmed(s.id) && 'vs-series--dim')}
                      isAnimationActive={false}
                    />,
                  ]
                : []
            )
          )}
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
                className={cn('vs-series', dimmed(s.id) && 'vs-series--dim')}
                isAnimationActive={false}
              />
            ))
          )}
          {/* Hover preview ("ghost") line — low opacity, fades in/out. */}
          {ghostColored?.lines.map((line, li) => (
            <Line
              key={lineKey(GHOST_ID, li)}
              dataKey={lineKey(GHOST_ID, li)}
              type="monotone"
              stroke={ghostColored.color}
              strokeWidth={line.style === 'dashed' ? 2 : 2.5}
              strokeDasharray={line.style === 'dashed' ? '5 4' : undefined}
              strokeOpacity={ghostShown ? GHOST_OPACITY : 0}
              dot={false}
              activeDot={false}
              connectNulls
              legendType="none"
              className="vs-ghost-line"
              isAnimationActive={false}
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
