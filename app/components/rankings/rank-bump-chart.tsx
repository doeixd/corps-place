// /rankings bump chart (plan M3). Y = finishing rank (1 at top, reversed), X =
// competition days; one line per corps in its brand hue. Lines cross as corps
// overtake each other. Capped to the top N + the hovered corps; SSR-guarded to
// avoid CLS. Shares hover state with the list.
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
import { themeStore } from '@/stores/theme-store';
import { RANK_SERIES_CAP, type RankRow } from '@/lib/rankings/types';

const fmtDate = (d: string) => {
  const dt = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(dt.getTime())
    ? d
    : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
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
}: {
  active?: boolean;
  payload?: { dataKey?: string | number; value?: number | null; color?: string }[];
  label?: string;
  names: Record<string, string>;
}) {
  if (!active || !payload?.length) return null;
  const items = payload
    .filter((p) => p.value != null && p.dataKey != null)
    .sort((a, b) => Number(a.value) - Number(b.value))
    .slice(0, 10);
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-foreground">{label ? fmtDate(label) : ''}</div>
      <div className="space-y-0.5">
        {items.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: p.color }} />
            <span className="text-foreground">{names[String(p.dataKey)] ?? p.dataKey}</span>
            <span className="ml-auto pl-3 tabular-nums text-muted-foreground">#{p.value}</span>
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
}: {
  rows: RankRow[];
  dates: string[];
  hoveredSlug?: string | null;
  onHover?: (slug: string | null) => void;
  height?: string;
}) {
  const mode = useSelector(themeStore, (s) => s.context.theme) ?? 'light';

  // Cap plotted lines: top N by final rank + the hovered corps if outside it.
  const plotted = useMemo(() => {
    const top = rows.slice(0, RANK_SERIES_CAP);
    if (hoveredSlug && !top.some((r) => r.corpsSlug === hoveredSlug)) {
      const extra = rows.find((r) => r.corpsSlug === hoveredSlug);
      if (extra) return [...top, extra];
    }
    return top;
  }, [rows, hoveredSlug]);

  const names = useMemo(
    () => Object.fromEntries(plotted.map((r) => [r.corpsSlug, r.corpsName])),
    [plotted]
  );

  const data = useMemo<MergedRow[]>(() => {
    const byDate = new Map<string, MergedRow>(dates.map((d) => [d, { date: d }]));
    for (const r of plotted)
      for (const h of r.history) {
        const row = byDate.get(h.date);
        if (row) row[r.corpsSlug] = h.rank;
      }
    return dates.map((d) => byDate.get(d)!);
  }, [plotted, dates]);

  const maxRank = useMemo(
    () => Math.max(1, ...plotted.flatMap((r) => r.history.map((h) => h.rank))),
    [plotted]
  );

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted || dates.length === 0) return <div className={`${height} w-full`} />;

  return (
    <div className={`${height} w-full`}>
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
            reversed
            domain={[1, maxRank]}
            allowDecimals={false}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip content={<BumpTooltip names={names} />} />
          {plotted.map((r) => {
            const color = corpsPalette(
              { primary: r.colorPrimary ?? undefined, secondary: r.colorSecondary ?? null },
              mode
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
