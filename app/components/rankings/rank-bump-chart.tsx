// /rankings season line chart (plan M3). One line per corps in its brand hue,
// X = competition days. Two modes:
//   • rank  — Y = finishing rank (1 at top, reversed); lines cross as corps
//             overtake each other. This is the classic "bump chart".
//   • score — Y = aggregated score (auto domain); shows how tightly corps are
//             packed and how they climb over the season.
// Capped to the top N by final rank + the hovered corps; SSR-guarded to avoid
// CLS. Shares hover state with the list.
import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import { useSelector } from '@xstate/react';
import { corpsPalette } from '@sdk/src/corpsColors.js';
import { formatScore } from '@/lib/format';
import { themeStore } from '@/stores/theme-store';
import { RANK_SERIES_CAP, type RankChartMode, type RankRow } from '@/lib/rankings/types';
import { useChartZoom, RESET_ZOOM_CLASS } from '@/lib/use-chart-zoom';

// Shared formatter + cache — toLocaleDateString builds an Intl.DateTimeFormat
// per call, and the chart formats every tick on every render (see asof-scrubber).
const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const fmtCache = new Map<string, string>();
const fmtDate = (d: string): string => {
  const cached = fmtCache.get(d);
  if (cached) return cached;
  const dt = new Date(`${d}T00:00:00Z`);
  const out = Number.isNaN(dt.getTime()) ? d : DATE_FMT.format(dt);
  fmtCache.set(d, out);
  return out;
};

interface MergedRow {
  date: string;
  [slug: string]: number | string;
}

function BumpTooltip({
  active,
  payload,
  label,
  names,
  mode,
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | null; color?: string }[];
  label?: string;
  names: Record<string, string>;
  mode: RankChartMode;
}) {
  if (!active || !payload?.length) return null;
  // Rank: lowest (best) first. Score: highest first. Either way the leader is
  // at the top of the tooltip.
  const items = payload
    .filter((p) => p.value != null && p.dataKey != null)
    .sort((a, b) =>
      mode === 'score' ? Number(b.value) - Number(a.value) : Number(a.value) - Number(b.value)
    )
    .slice(0, 10);
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-foreground">{label ? fmtDate(label) : ''}</div>
      <div className="space-y-0.5">
        {items.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: p.color }} />
            <span className="text-foreground">{names[String(p.dataKey)] ?? p.dataKey}</span>
            <span className="ml-auto pl-3 tabular-nums text-muted-foreground">
              {mode === 'score' ? formatScore(Number(p.value)) : `#${p.value}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RankBumpChart({
  rows,
  dates,
  hoveredSlug,
  onHover,
  height = 'h-80',
  mode = 'rank',
}: {
  rows: RankRow[];
  dates: string[];
  hoveredSlug?: string | null;
  onHover?: (slug: string | null) => void;
  height?: string;
  mode?: RankChartMode;
}) {
  const themeMode = useSelector(themeStore, (s) => s.context.theme) ?? 'light';

  // Top N by final rank — the stable base line set. Kept as its own memo so the
  // hover path below can return this exact ref when the hovered corps is already
  // visible, leaving the data/axis memos untouched.
  const top = useMemo(() => rows.slice(0, RANK_SERIES_CAP), [rows]);

  // Cap plotted lines: top N + the hovered corps only when it's OUTSIDE the top
  // N. When it's already visible (the hot path — hovering any drawn line) we
  // return `top` unchanged, so `allData`/`data`/`yMin,yMax` below don't recompute
  // and recharts doesn't rebuild the whole dataset on every mousemove.
  const plotted = useMemo(() => {
    if (hoveredSlug && !top.some((r) => r.corpsSlug === hoveredSlug)) {
      const extra = rows.find((r) => r.corpsSlug === hoveredSlug);
      if (extra) return [...top, extra];
    }
    return top;
  }, [top, rows, hoveredSlug]);

  const names = useMemo(
    () => Object.fromEntries(plotted.map((r) => [r.corpsSlug, r.corpsName])),
    [plotted]
  );

  const allData = useMemo<MergedRow[]>(() => {
    const byDate = new Map<string, MergedRow>(dates.map((d) => [d, { date: d }]));
    for (const r of plotted)
      for (const h of r.history) {
        const row = byDate.get(h.date);
        // history carries both rank and score per day — pick the plotted metric.
        if (row) row[r.corpsSlug] = mode === 'score' ? h.score : h.rank;
      }
    return dates.map((d) => byDate.get(d)!);
  }, [plotted, dates, mode]);

  // Zoom: the x-axis is categorical (competition dates), so the zoom window
  // lives in INDEX space — the visible slice of the date list. Same gestures as
  // the VS chart (pinch / ctrl+wheel / drag-pan / double-tap reset), page scroll
  // untouched while not zoomed.
  const { xDomain, zoomed, reset, wrapRef, handlers, touchAction } = useChartZoom({
    min: 0,
    max: Math.max(1, dates.length - 1),
    minSpan: 2,
  });
  const data = useMemo<MergedRow[]>(() => {
    if (!xDomain) return allData;
    const lo = Math.max(0, Math.floor(xDomain[0]));
    const hi = Math.min(allData.length - 1, Math.ceil(xDomain[1]));
    return allData.slice(lo, hi + 1);
  }, [allData, xDomain]);

  // Y axis follows the visible window when zoomed (tightens around whoever is on
  // screen). Rank: integer domain, 1 pinned to the top. Score: padded auto
  // domain so lines aren't glued to the frame.
  const [yMin, yMax] = useMemo(() => {
    const source = zoomed ? data : allData;
    let lo = Infinity;
    let hi = mode === 'score' ? -Infinity : 1;
    for (const row of source)
      for (const [k, v] of Object.entries(row)) {
        if (k === 'date' || typeof v !== 'number') continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    if (!Number.isFinite(lo)) return mode === 'score' ? [0, 100] : [1, 1];
    if (mode === 'score') {
      const pad = Math.max(0.5, (hi - lo) * 0.08);
      return [lo - pad, hi + pad];
    }
    return zoomed ? [Math.max(1, lo - 1), hi + 1] : [1, hi];
  }, [data, allData, zoomed, mode]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || dates.length === 0) return <div className={`${height} w-full`} />;

  return (
    <div
      ref={wrapRef}
      className={`${height} relative w-full select-none`}
      style={{ touchAction }}
      {...handlers}
      onDoubleClick={reset}
      // The chart only ever SETS hover (via each line's activeDot). Clear it when
      // the pointer leaves the chart so the highlight doesn't get stuck on — the
      // list rows already pair enter/leave, but leaving the chart into empty space
      // never touched a row. Kept after the handler spread (which has no
      // onMouseLeave) so nothing overrides it.
      onMouseLeave={() => onHover?.(null)}
    >
      {zoomed ? (
        <button type="button" onClick={reset} className={`${RESET_ZOOM_CLASS} left-2`}>
          Reset zoom
        </button>
      ) : null}
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={fmtDate}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-border)' }}
            minTickGap={24}
          />
          <YAxis
            reversed={mode === 'rank'}
            domain={[yMin, yMax]}
            allowDecimals={mode === 'score'}
            tickFormatter={mode === 'score' ? (v) => formatScore(Number(v)) : undefined}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            // The chart's `margin.left: -16` crops 16px off the axis gutter, so the
            // visible label area is width−16. Score ticks are 6–7 chars ("84.055",
            // "100.000" ≈ 42px at 11px font) — 46 left them clipped to ".055";
            // 62 gives ~46px visible. Rank ticks are 1–2 digits, 40 is plenty.
            width={mode === 'score' ? 62 : 40}
          />
          <Tooltip content={<BumpTooltip names={names} mode={mode} />} />
          {plotted.map((r) => {
            const color = corpsPalette(
              { primary: r.colorPrimary ?? undefined, secondary: r.colorSecondary ?? null },
              themeMode
            ).chart;
            const dim = hoveredSlug && hoveredSlug !== r.corpsSlug;
            return (
              <Line
                key={r.corpsSlug}
                dataKey={r.corpsSlug}
                type="monotone"
                stroke={color}
                strokeWidth={hoveredSlug === r.corpsSlug ? 3 : 2}
                strokeOpacity={dim ? 0.2 : 1}
                dot={{ r: 2, fill: color }}
                activeDot={{ r: 4, onMouseOver: () => onHover?.(r.corpsSlug) }}
                connectNulls
                isAnimationActive={false}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
