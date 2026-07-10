// <VsChart> — the presentational multi-series comparison chart (plan M2). Plots
// each resolved series against % through season (0–100), so corps/seasons/
// baselines align on one x-axis. One or two <Line>s per series (a 2026 corps =
// actual solid + predicted dashed). Theme-aware colors via assignVsColors; SSR
// guard mirrors corps-score-chart to avoid hydration CLS.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// --- Zoom/pan ---------------------------------------------------------------
// Recharts has no built-in pinch zoom, so we drive the XAxis domain ourselves:
//   • touch: two-finger pinch zooms around the pinch midpoint; while zoomed a
//     one-finger drag pans. When NOT zoomed the wrapper keeps `touch-action:
//     pan-y` so normal page scrolling over the chart is untouched — it flips to
//     `none` only while zoomed (drag = pan, not scroll). Double-tap resets.
//   • desktop: ctrl/cmd+wheel (= trackpad pinch) zooms around the cursor; drag
//     pans while zoomed; double-click resets. Plain wheel keeps scrolling the
//     page. A "Reset" pill shows whenever zoomed.
const X_MIN = 0;
const X_MAX = 100;
const MIN_SPAN = 5; // don't zoom tighter than 5 percentage points
const DOUBLE_TAP_MS = 300;

const clampDomain = (lo: number, hi: number): [number, number] => {
  let span = Math.min(Math.max(hi - lo, MIN_SPAN), X_MAX - X_MIN);
  let nlo = Math.max(X_MIN, Math.min(lo, X_MAX - span));
  return [nlo, nlo + span];
};

function useChartZoom() {
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; domain: [number, number]; midFrac: number } | null>(null);
  const panStart = useRef<{ x: number; domain: [number, number] } | null>(null);
  const lastTap = useRef(0);

  const zoomed = xDomain !== null;
  const reset = useCallback(() => setXDomain(null), []);

  // x-position → fraction of the wrapper width (close enough to plot-area
  // fraction for centering; margins/axis gutter introduce only a small skew).
  const fracOf = (clientX: number) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0.5;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const zoomAround = useCallback((frac: number, scale: number, base?: [number, number]) => {
    setXDomain((cur) => {
      const [lo, hi] = base ?? cur ?? [X_MIN, X_MAX];
      const span = hi - lo;
      const next = span * scale;
      const focus = lo + span * frac;
      const d = clampDomain(focus - next * frac, focus + next * (1 - frac));
      return d[0] <= X_MIN && d[1] >= X_MAX ? null : d;
    });
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = {
        dist: Math.max(12, Math.hypot(a.x - b.x, a.y - b.y)),
        domain: xDomain ?? [X_MIN, X_MAX],
        midFrac: fracOf((a.x + b.x) / 2),
      };
      panStart.current = null;
    } else if (pointers.current.size === 1) {
      // Double-tap / double-click reset (touch has no dblclick with our handlers).
      const now = performance.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) setXDomain(null);
      lastTap.current = now;
      if (xDomain) panStart.current = { x: e.clientX, domain: xDomain };
    }
  }, [xDomain]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.max(12, Math.hypot(a.x - b.x, a.y - b.y));
      const scale = pinchStart.current.dist / dist; // fingers apart → span shrinks
      zoomAround(pinchStart.current.midFrac, scale, pinchStart.current.domain);
    } else if (pointers.current.size === 1 && panStart.current) {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r || r.width === 0) return;
      const [lo, hi] = panStart.current.domain;
      const shift = ((panStart.current.x - e.clientX) / r.width) * (hi - lo);
      setXDomain(clampDomain(lo + shift, hi + shift));
    }
  }, [zoomAround]);

  const onPointerEnd = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 0) panStart.current = null;
    else if (pointers.current.size === 1 && xDomain) {
      // Pinch ended with one finger still down — hand off to panning cleanly.
      const [a] = [...pointers.current.values()];
      panStart.current = { x: a.x, domain: xDomain };
    }
  }, [xDomain]);

  // Wheel zoom must preventDefault (stop page scroll/browser zoom), which React's
  // synthetic wheel can't (passive) — attach natively.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel keeps scrolling the page
      e.preventDefault();
      zoomAround(fracOf(e.clientX), Math.exp(e.deltaY * 0.002));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround]);

  return { xDomain, zoomed, reset, wrapRef, onPointerDown, onPointerMove, onPointerEnd };
}

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
  yLabel,
  height = 'h-80',
}: {
  series: VsResolvedSeries[];
  /** When provided, legend rows get a remove (×). */
  onRemove?: (id: string) => void;
  /** A resolved series to render as a low-opacity hover preview (the "ghost"
   *  line). Null clears it. Fades in/out with an ease-out transition. */
  preview?: VsResolvedSeries | null;
  /** Optional Y-axis caption label (e.g. "General Effect"); omitted for Total. */
  yLabel?: string;
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

  const { xDomain, zoomed, reset, wrapRef, onPointerDown, onPointerMove, onPointerEnd } =
    useChartZoom();

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
    <div className="space-y-3">
      {!mounted ? (
        <div className={`${height} w-full`} />
      ) : (
        <div
          ref={wrapRef}
          className={`${height} relative w-full select-none`}
          // Not zoomed: pan-y lets the page scroll normally over the chart while
          // two-finger pinches still reach our pointer handlers. Zoomed: none, so
          // a one-finger drag pans the window instead of scrolling the page.
          style={{ touchAction: zoomed ? 'none' : 'pan-y' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
          onPointerLeave={onPointerEnd}
          onDoubleClick={reset}
        >
          {zoomed ? (
            <button
              type="button"
              onClick={reset}
              className="absolute right-2 top-1 z-10 rounded-full border border-border bg-background/90 px-2.5 py-1 text-xs font-medium text-text-secondary shadow-sm transition-colors hover:border-primary/60 hover:text-foreground"
            >
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
      )}
      <VsLegend items={legendItems} onRemove={onRemove} onHover={setHighlighted} />
    </div>
  );
}
