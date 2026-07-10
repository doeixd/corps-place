// The recharts-rendering half of <CorpsScoreChart>, split out so recharts
// (~330KB) can be lazy-loaded: the chart shell (with its as-of picker) SSRs and
// reserves the fixed-height box, then this body streams in the background — no
// layout shift, no recharts on first paint.
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
import { fmtDate, type Row } from './corps-score-chart-shared';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export default function CorpsScoreChartBody({
  rows,
  actualColor,
}: {
  rows: Row[];
  actualColor: string;
}) {
  return (
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
  );
}
