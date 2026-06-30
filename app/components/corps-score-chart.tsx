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
  Legend,
} from 'recharts';
import { useSelector } from '@xstate/react';
import { corpsPalette } from '@sdk/src/corpsColors.js';
import { themeStore } from '@/stores/theme-store';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import type { CorpsSeasonPoint, CorpsSeasonSnapshotRow } from '@/lib/corps-directory';

/**
 * Current-season score chart for a corps:
 *  - actual scores: solid line (appears as competitions are scored)
 *  - predictions:   dashed line
 *  - uncertainty:   shaded band (derived; narrows through the season)
 */

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

type Row = {
  label: string;
  date: string;
  predicted: number | null;
  actual: number | null;
  band: [number, number] | null;
};

const toRow = (p: CorpsSeasonPoint | CorpsSeasonSnapshotRow): Row => ({
  label: p.label,
  date: p.date,
  predicted: p.predicted,
  actual: p.actual,
  band: p.low != null && p.high != null ? [p.low, p.high] : null,
});

type DotProps = {
  cx?: number;
  cy?: number;
  value?: number | null;
  size?: number;
  color?: string;
};

function ActualSquareDot({ cx, cy, value, size = 7, color }: DotProps) {
  if (typeof cx !== 'number' || typeof cy !== 'number' || value == null) return null;
  const half = size / 2;
  return (
    <rect
      x={cx - half}
      y={cy - half}
      width={size}
      height={size}
      rx={1}
      fill={color ?? 'var(--color-foreground)'}
      stroke="var(--color-background)"
      strokeWidth={1.5}
    />
  );
}

type LegendPayloadItem = {
  value?: string;
  dataKey?: string;
  color?: string;
};

function ScoreLegend({ payload }: { payload?: LegendPayloadItem[] }) {
  const items = (payload ?? []).filter((item) => item.value !== 'Uncertainty');
  return (
    <div className="flex items-center justify-center gap-4 text-xs">
      {items.map((item) => {
        const isActual = item.dataKey === 'actual';
        const color = item.color ?? (isActual ? 'var(--color-foreground)' : 'var(--color-primary)');
        return (
          <div key={item.dataKey ?? item.value} className="flex items-center gap-1.5">
            <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
              <line
                x1="2"
                y1="5"
                x2="22"
                y2="5"
                stroke={color}
                strokeWidth="2"
                strokeDasharray={isActual ? undefined : '5 4'}
                strokeLinecap="round"
              />
              {isActual ? (
                <rect
                  x="9"
                  y="2"
                  width="6"
                  height="6"
                  rx="1"
                  fill={color}
                  stroke="var(--color-background)"
                  strokeWidth="1"
                />
              ) : (
                <circle
                  cx="12"
                  cy="5"
                  r="2.5"
                  fill="var(--color-background)"
                  stroke={color}
                  strokeWidth="1.5"
                />
              )}
            </svg>
            <span className="text-text-secondary">{item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

function ScoreTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload as Row;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-foreground">{row.label}</div>
      <div className="text-muted-foreground">{fmtDate(row.date)}</div>
      <div className="mt-1 space-y-0.5">
        {row.actual != null && (
          <div className="text-foreground">Actual: {row.actual.toFixed(3)}</div>
        )}
        {row.predicted != null && (
          <div className="text-primary">
            Predicted: {row.predicted.toFixed(3)}
            {row.band ? ` (${row.band[0].toFixed(1)}–${row.band[1].toFixed(1)})` : ''}
          </div>
        )}
      </div>
    </div>
  );
}

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

  // ResponsiveContainer can't measure during SSR (warns about width/height -1),
  // so only mount the chart on the client. The fixed-height box reserves space
  // to avoid layout shift on hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
      <div className="h-72 w-full">
        {mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={fmtDate}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-border)' }}
            minTickGap={20}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip content={<ScoreTooltip />} />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            content={(props) => <ScoreLegend payload={props.payload as LegendPayloadItem[]} />}
          />
          {/* Uncertainty band */}
          <Area
            name="Uncertainty"
            dataKey="band"
            stroke="none"
            fill="var(--color-primary)"
            fillOpacity={0.12}
            isAnimationActive={false}
            connectNulls
            legendType="none"
            activeDot={false}
          />
          {/* Prediction — dashed */}
          <Line
            name="Predicted"
            dataKey="predicted"
            type="monotone"
            stroke="var(--color-primary)"
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={{ r: 2.5, fill: 'var(--color-primary)' }}
            connectNulls
            isAnimationActive={false}
          />
          {/* Actual — solid */}
          <Line
            name="Actual"
            dataKey="actual"
            type="monotone"
            stroke={actualColor}
            strokeWidth={2.5}
            dot={<ActualSquareDot color={actualColor} />}
            activeDot={<ActualSquareDot size={9} color={actualColor} />}
            connectNulls
            isAnimationActive={false}
          />
            </ComposedChart>
          </ResponsiveContainer>
        ) : null}
      </div>
    </div>
  );
}
