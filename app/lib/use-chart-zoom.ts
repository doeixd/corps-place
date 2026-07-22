// Shared zoom/pan gesture state for recharts charts (used by the VS chart and
// the rankings bump chart). Recharts has no built-in pinch zoom, so this hook
// owns a numeric x-window [lo, hi] and translates gestures into it:
//   • touch: two-finger pinch zooms around the pinch midpoint; while zoomed a
//     one-finger drag pans. When NOT zoomed the wrapper should keep
//     `touch-action: pan-y` so normal page scrolling over the chart works — flip
//     it to `none` only while zoomed (see `touchAction` below). Double-tap resets.
//   • desktop: ctrl/cmd+wheel (= trackpad pinch) zooms around the cursor; drag
//     pans while zoomed; double-click resets (wire `onDoubleClick={reset}`).
//     Plain wheel keeps scrolling the page.
//
// The unit of the domain is caller-defined: the VS chart uses percent-through
// (0–100); the bump chart uses date INDEX (0..dates.length-1) since its x-axis
// is categorical.
import { useCallback, useEffect, useRef, useState } from 'react';

export function useChartZoom({
  min,
  max,
  minSpan,
}: {
  min: number;
  max: number;
  /** Tightest allowed window, in domain units. */
  minSpan: number;
}) {
  const [xDomain, setXDomain] = useState<[number, number] | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{ dist: number; domain: [number, number]; midFrac: number } | null>(
    null
  );
  const panStart = useRef<{ x: number; domain: [number, number] } | null>(null);
  const lastTap = useRef(0);
  const DOUBLE_TAP_MS = 300;

  const clampDomain = useCallback(
    (lo: number, hi: number): [number, number] => {
      const span = Math.min(Math.max(hi - lo, minSpan), max - min);
      const nlo = Math.max(min, Math.min(lo, max - span));
      return [nlo, nlo + span];
    },
    [min, max, minSpan]
  );

  const zoomed = xDomain !== null;
  const reset = useCallback(() => setXDomain(null), []);

  // If the domain bounds change under us (filters swapped the data), a stale
  // window can point at nothing — reset.
  useEffect(() => {
    setXDomain((cur) => (cur && (cur[1] > max || cur[0] < min) ? null : cur));
  }, [min, max]);

  // x-position → fraction of the wrapper width (close enough to plot-area
  // fraction for centering; margins/axis gutter introduce only a small skew).
  const fracOf = (clientX: number) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0.5;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const zoomAround = useCallback(
    (frac: number, scale: number, base?: [number, number]) => {
      setXDomain((cur) => {
        const [lo, hi] = base ?? cur ?? [min, max];
        const span = hi - lo;
        const next = span * scale;
        const focus = lo + span * frac;
        const d = clampDomain(focus - next * frac, focus + next * (1 - frac));
        return d[0] <= min && d[1] >= max ? null : d;
      });
    },
    [min, max, clampDomain]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        pinchStart.current = {
          dist: Math.max(12, Math.hypot(a.x - b.x, a.y - b.y)),
          domain: xDomain ?? [min, max],
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
    },
    [xDomain, min, max]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
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
    },
    [zoomAround, clampDomain]
  );

  const onPointerEnd = useCallback(
    (e: React.PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinchStart.current = null;
      if (pointers.current.size === 0) panStart.current = null;
      else if (pointers.current.size === 1 && xDomain) {
        // Pinch ended with one finger still down — hand off to panning cleanly.
        const [a] = [...pointers.current.values()];
        panStart.current = { x: a.x, domain: xDomain };
      }
    },
    [xDomain]
  );

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

  return {
    xDomain,
    zoomed,
    reset,
    wrapRef,
    /** Spread onto the wrapper div (with `style={{ touchAction }}` + `onDoubleClick={reset}`). */
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onPointerLeave: onPointerEnd,
    },
    touchAction: zoomed ? ('none' as const) : ('pan-y' as const),
  };
}

/** The overlay "Reset zoom" pill's shared classes (kept identical across charts).
 *  Position (left/right corner) is supplied by each chart — the corner that's
 *  cheap real estate differs per layout. */
export const RESET_ZOOM_CLASS =
  'absolute top-1 z-10 rounded-full border border-border bg-background/90 px-2.5 py-1 text-xs font-medium text-text-secondary shadow-sm transition-colors hover:border-primary/60 hover:text-foreground';
