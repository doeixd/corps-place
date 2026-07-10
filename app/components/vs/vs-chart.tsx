// <VsChart> — the presentational multi-series comparison chart (plan M2). Plots
// each resolved series against % through season (0–100), so corps/seasons/
// baselines align on one x-axis.
//
// This module is the SSR'd *shell*: it renders a fixed-height box (reserving the
// chart's space) plus the legend, and lazy-loads the recharts-heavy body
// (vs-chart-body) in the background. So recharts (~330KB) never blocks first
// paint, the legend is present immediately (no layout shift when the chart
// arrives), and the shell mirrors the placeholder pattern the charts already use
// to avoid the ResponsiveContainer SSR width warning.
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useSelector } from '@xstate/react';
import { themeStore } from '@/stores/theme-store';
import { assignVsColors } from '@/lib/vs/colors';
import type { VsResolvedSeries } from '@/lib/vs/types';
import { VsLegend, type VsLegendItem } from './chart-primitives';

// The hover-preview series is merged into the chart data under this fixed id so
// its dataKeys never collide with a real series and the tooltip can skip it.
const GHOST_ID = 'ghost';
const GHOST_FADE_MS = 240;

const VsChartBody = lazy(() => import('./vs-chart-body'));

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

  // Legend hover: highlight one series by dimming every other line/band. Owned
  // here (in the shell) so the eager legend and the lazy chart body share it.
  const [highlighted, setHighlighted] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {/* Fixed-height box reserves the chart's space during SSR + while the
          recharts body loads, so there's no layout shift. */}
      <Suspense fallback={<div className={`${height} w-full`} />}>
        <VsChartBody
          colored={colored}
          ghostColored={ghostColored}
          ghostShown={ghostShown}
          yLabel={yLabel}
          height={height}
          highlighted={highlighted}
        />
      </Suspense>
      <VsLegend items={legendItems} onRemove={onRemove} onHover={setHighlighted} />
    </div>
  );
}
