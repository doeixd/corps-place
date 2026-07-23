// Recharts for the /accuracy page — daily MAE line (with model-era markers),
// lead-time MAE bars, and a signed-error histogram. Mirrors the axis/grid/tooltip
// conventions in components/rankings/rank-bump-chart.tsx and components/vs/*.
// Chrome colors are `var(--color-…)` string literals (auto-swap in dark mode);
// series use semantic tokens. Lazy-loaded so recharts (~330KB) stays off the
// critical path. All series `isAnimationActive={false}`; charts mount-gate to a
// fixed-height placeholder to avoid CLS.
import { useEffect, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import type {
  AccuracyDaily,
  AccuracyLead,
  AccuracyBin,
} from '@sdk/src/readModel/builders/predictionAccuracy.js';

const fmtDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

const TooltipShell = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
    <div className="mb-1 font-medium text-foreground">{title}</div>
    <div className="space-y-0.5 tabular-nums text-muted-foreground">{children}</div>
  </div>
);

// ── Daily MAE line with model-era flip markers ───────────────────────────────
function DailyTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as AccuracyDaily;
  return (
    <TooltipShell title={fmtDate(p.date)}>
      <div>MAE {p.mae.toFixed(2)} pts</div>
      <div>
        Bias {p.bias > 0 ? '+' : ''}
        {p.bias.toFixed(2)} pts
      </div>
      <div>{p.n} corps scored</div>
    </TooltipShell>
  );
}

export function DailyMaeChart({
  daily,
  eras,
}: {
  daily: AccuracyDaily[];
  eras: { key: string; label: string; flipDate: string | null }[];
}) {
  const mounted = useMounted();
  if (!mounted || daily.length === 0) return <div className="h-64 w-full" />;
  const maxMae = Math.max(...daily.map((d) => d.mae), 1);
  const flips = eras.filter((e) => e.flipDate && daily.some((d) => d.date >= e.flipDate!));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={daily} margin={{ top: 12, right: 16, bottom: 4, left: -16 }}>
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
            domain={[0, Math.ceil((maxMae + 0.5) * 2) / 2]}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={40}
            label={{
              value: 'MAE (pts)',
              angle: -90,
              position: 'insideLeft',
              fontSize: 11,
              fill: 'var(--color-muted-foreground)',
              style: { textAnchor: 'middle' },
            }}
          />
          {flips.map((e) => (
            <ReferenceLine
              key={e.key}
              x={e.flipDate as string}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.6}
              label={{
                value: 'model upgrade',
                position: 'insideTopRight',
                fontSize: 9,
                fill: 'var(--color-muted-foreground)',
              }}
            />
          ))}
          <Tooltip content={<DailyTooltip />} />
          <Line
            dataKey="mae"
            type="monotone"
            stroke="var(--color-primary)"
            strokeWidth={2}
            dot={{ r: 2, fill: 'var(--color-primary)' }}
            activeDot={{ r: 4 }}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Lead-time MAE bars ───────────────────────────────────────────────────────
function LeadTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as AccuracyLead;
  return (
    <TooltipShell title={`${p.bucket} before show`}>
      <div>MAE {p.mae.toFixed(2)} pts</div>
      <div>{p.n.toLocaleString()} forecasts</div>
    </TooltipShell>
  );
}

export function LeadTimeChart({ leadTime }: { leadTime: AccuracyLead[] }) {
  const mounted = useMounted();
  if (!mounted || leadTime.length === 0) return <div className="h-56 w-full" />;
  const maxMae = Math.max(...leadTime.map((d) => d.mae), 1);
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={leadTime} margin={{ top: 8, right: 16, bottom: 4, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="bucket"
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-border)' }}
          />
          <YAxis
            domain={[0, Math.ceil((maxMae + 0.3) * 2) / 2]}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            content={<LeadTooltip />}
            cursor={{ fill: 'var(--color-muted)', opacity: 0.3 }}
          />
          <Bar
            dataKey="mae"
            fill="var(--color-primary)"
            radius={[3, 3, 0, 0]}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── Signed-error histogram (two-tone by direction) ───────────────────────────
function HistTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as AccuracyBin;
  return (
    <TooltipShell
      title={`${p.binLo > 0 ? '+' : ''}${p.binLo} to ${p.binHi > 0 ? '+' : ''}${p.binHi} pts`}
    >
      <div>{p.count.toLocaleString()} corps-events</div>
      <div>{p.center < 0 ? 'over-predicted' : 'under-predicted'}</div>
    </TooltipShell>
  );
}

export function ErrorHistogram({ histogram }: { histogram: AccuracyBin[] }) {
  const mounted = useMounted();
  if (!mounted || histogram.length === 0) return <div className="h-56 w-full" />;
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={histogram}
          margin={{ top: 8, right: 16, bottom: 16, left: -16 }}
          barCategoryGap={1}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="center"
            type="number"
            domain={['dataMin - 0.5', 'dataMax + 0.5']}
            tickFormatter={(v) => (v > 0 ? `+${v}` : `${v}`)}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-border)' }}
            label={{
              value: 'predicted − actual (pts)',
              position: 'insideBottom',
              offset: -6,
              fontSize: 11,
              fill: 'var(--color-muted-foreground)',
            }}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <ReferenceLine x={0} stroke="var(--color-muted-foreground)" strokeOpacity={0.5} />
          <Tooltip
            content={<HistTooltip />}
            cursor={{ fill: 'var(--color-muted)', opacity: 0.3 }}
          />
          <Bar dataKey="count" isAnimationActive={false}>
            {histogram.map((b) => (
              <Cell
                key={b.binLo}
                fill={b.center < 0 ? 'var(--diff-negative)' : 'var(--diff-positive)'}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
