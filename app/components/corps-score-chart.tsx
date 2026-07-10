import { lazy, Suspense, useMemo, useState } from 'react';
import { useSelector } from '@xstate/react';
import { corpsPalette } from '@sdk/src/corpsColors.js';
import { themeStore } from '@/stores/theme-store';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import type { CorpsSeasonPoint, CorpsSeasonSnapshotRow } from '@/lib/corps-directory';
import { fmtDate, toRow, type Row } from './corps-score-chart-shared';

/**
 * Current-season score chart for a corps:
 *  - actual scores: solid line (appears as competitions are scored)
 *  - predictions:   dashed line
 *  - uncertainty:   shaded band (derived; narrows through the season)
 *
 * This is the SSR'd shell: it renders the "as of" picker and a fixed-height box
 * that reserves the chart's space, then lazy-loads the recharts body
 * (corps-score-chart-body) in the background. recharts (~330KB) never blocks
 * first paint and the reserved box means no layout shift when it arrives.
 */

const CorpsScoreChartBody = lazy(() => import('./corps-score-chart-body'));

export function CorpsScoreChart({
  data,
  snapshots,
  colors,
}: {
  data: readonly CorpsSeasonPoint[];
  /** "Prediction as of ___" history — the season timeline per snapshot date.
   *  When ≥2 dates exist, a popover slider lets you replay past forecasts. */
  snapshots?: readonly CorpsSeasonSnapshotRow[];
  /** Corps brand colors ('#rrggbb'); the "Actual" series takes the corps's hue. */
  colors?: { primary: string | null; secondary?: string | null };
}) {
  const theme = useSelector(themeStore, (s) => s.context.theme);
  // Mode-aware accent derived from the brand hex (contrast-adjusted by
  // corpsPalette); without a stored color, keep the neutral foreground.
  const actualColor = colors?.primary
    ? corpsPalette({ primary: colors.primary, secondary: colors.secondary ?? undefined }, theme)
        .chart
    : 'var(--color-foreground)';

  // The distinct snapshot dates (ascending) and the timeline rows for each.
  const snapshotDates = useMemo(() => {
    const set = new Set<string>();
    for (const s of snapshots ?? []) set.add(s.snapshot_at);
    return Array.from(set).sort();
  }, [snapshots]);
  const rowsByDate = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const s of snapshots ?? []) {
      const arr = m.get(s.snapshot_at);
      if (arr) arr.push(toRow(s));
      else m.set(s.snapshot_at, [toRow(s)]);
    }
    return m;
  }, [snapshots]);
  const hasHistory = snapshotDates.length >= 2;

  // `null` = follow the latest snapshot (default, and stays latest across nav);
  // an explicit pick from the slider overrides until reset.
  const [pickedIdx, setPickedIdx] = useState<number | null>(null);
  const latestIdx = Math.max(0, snapshotDates.length - 1);
  const idx = pickedIdx == null ? latestIdx : Math.min(pickedIdx, latestIdx);
  const isLatest = idx >= latestIdx;
  const activeDate = snapshotDates[idx];

  // The line the chart draws: the selected snapshot's timeline when history is
  // available (its latest is parity-equal to `data`), else the loader's points.
  const rows = useMemo<Row[]>(
    () => (hasHistory ? (rowsByDate.get(activeDate) ?? []) : data.map(toRow)),
    [hasHistory, rowsByDate, activeDate, data]
  );

  return (
    <div className="w-full">
      {hasHistory && (
        <div className="mb-1 flex justify-end">
          <Popover>
            <PopoverTrigger className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-primary/60 hover:text-foreground">
              <span className="text-text-muted">Forecast</span>
              <span className="font-medium">
                {isLatest ? 'latest' : `as of ${fmtDate(activeDate)}`}
              </span>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 gap-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-foreground">Prediction as of</span>
                <span className="text-xs text-text-secondary">
                  {fmtDate(activeDate)}
                  {isLatest ? ' · latest' : ''}
                </span>
              </div>
              <Slider
                min={0}
                max={latestIdx}
                value={[idx]}
                onValueChange={(v) => {
                  const next = Array.isArray(v) ? v[0] : v;
                  setPickedIdx(typeof next === 'number' ? next : null);
                }}
              />
              <div className="flex justify-between text-[10px] text-text-muted">
                <span>{fmtDate(snapshotDates[0])}</span>
                <span>{fmtDate(snapshotDates[latestIdx])}</span>
              </div>
              {!isLatest && (
                <button
                  type="button"
                  onClick={() => setPickedIdx(null)}
                  className="self-end text-xs text-primary hover:underline"
                >
                  Reset to latest
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      )}
      {/* Fixed-height box reserves the chart's space during SSR + while the
          recharts body loads, so there's no layout shift. */}
      <div className="h-72 w-full">
        <Suspense fallback={null}>
          <CorpsScoreChartBody rows={rows} actualColor={actualColor} />
        </Suspense>
      </div>
    </div>
  );
}
