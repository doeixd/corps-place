// <VsChart> — the presentational multi-series comparison chart (plan M2). Plots
// each resolved series against % through season (0–100), so corps/seasons/
// baselines align on one x-axis. One or two <Line>s per series (a 2026 corps =
// actual solid + predicted dashed). Theme-aware colors via assignVsColors; SSR
// guard mirrors corps-score-chart to avoid hydration CLS.
import { useEffect, useMemo, useState } from 'react';
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
import { useSelector } from '@xstate/react';
import { cn } from '@/lib/utils';
import { themeStore } from '@/stores/theme-store';
import { assignVsColors } from '@/lib/vs/colors';
import type { VsResolvedSeries } from '@/lib/vs/types';
import { VsLegend, VsTooltip, type VsCellMeta, type VsLegendItem } from './chart-primitives';

interface MergedRow {
  pct: number;
  __meta: Record<string, VsCellMeta>;
  [dataKey: string]: number | [number, number] | Record<string, VsCellMeta>;
}

const lineKey = (seriesId: string, lineIdx: number) => `${seriesId}@@${lineIdx}`;

// The hover-preview series is merged into the chart data under this fixed id so
// its dataKeys never collide with a real series and the tooltip can skip it.
const GHOST_ID = 'ghost';
const GHOST_OPACITY = 0.4;
const GHOST_FADE_MS = 240;

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
          // The transient hover preview (id forced to 'ghost') is excluded from
          // the tooltip — it's a peek, not a committed series.
          ghost: s.id === GHOST_ID,
        };
      }
    });
  }
  return [...byPct.values()].sort((a, b) => a.pct - b.pct);
}

export function VsChart({
  series,
  onRemove,
  preview = null,
  height = 'h-80',
}: {
  series: VsResolvedSeries[];
  /** When provided, legend rows get a remove (×). */
  onRemove?: (id: string) => void;
  /** A resolved series to render as a low-opacity hover preview (the "ghost"
   *  line). Null clears it. Fades in/out with an ease-out transition. */
  preview?: VsResolvedSeries | null;
  /** Tailwind height class for the plot box (kept identical SSR + client). */
  height?: string;
}) {
  const theme = useSelector(themeStore, (s) => s.context.theme);
  const colored = useMemo(() => assignVsColors(series, theme), [series, theme]);

  // Ghost preview: keep the line mounted through a fade-out before unmounting, so
  // both appear (fade in) and disappear (fade out) animate. `ghost` holds the
  // data; `ghostShown` drives the opacity 0↔GHOST_OPACITY transition.
  const [ghost, setGhost] = useState<VsResolvedSeries | null>(null);
  const [ghostShown, setGhostShown] = useState(false);
  useEffect(() => {
    if (preview) {
      setGhost(preview);
      // Mount at opacity 0, then flip on the next frame so the transition runs.
      setGhostShown(false);
      const raf = requestAnimationFrame(() => setGhostShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setGhostShown(false);
    const t = setTimeout(() => setGhost(null), GHOST_FADE_MS + 20);
    return () => clearTimeout(t);
  }, [preview]);

  // Force the ghost's id so its dataKeys/meta are isolated; color it like a real
  // series (brand hue for corps) so the preview reads as what you'd be adding.
  const ghostColored = useMemo(
    () => (ghost ? assignVsColors([{ ...ghost, id: GHOST_ID }], theme)[0] : null),
    [ghost, theme]
  );
  const rows = useMemo(
    () => mergeRows(ghostColored ? [...colored, ghostColored] : colored),
    [colored, ghostColored]
  );

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

  // Legend hover: highlight one series by dimming every other line/band.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const dimmed = (id: string) => highlighted != null && id !== highlighted;

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
      )}
      <VsLegend items={legendItems} onRemove={onRemove} onHover={setHighlighted} />
    </div>
  );
}
