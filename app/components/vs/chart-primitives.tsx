// Shared VS chart presentation bits — an N-series legend and hover tooltip,
// lifted/generalized from corps-score-chart.tsx so the single-corps card and the
// multi-series <VsChart> render identically. Pure presentational; no data access.
import { Icon } from '@/components/icon';
import { Cancel01Icon } from '@/components/icons/generated';

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** Per-datakey metadata carried on each merged chart row (see vs-chart.tsx). */
export interface VsCellMeta {
  seriesId: string;
  seriesLabel: string;
  color: string;
  dashed: boolean;
  date?: string;
  eventLabel?: string;
  /** The transient hover-preview line — excluded from the tooltip. */
  ghost?: boolean;
}

export interface VsLegendItem {
  id: string;
  label: string;
  color: string;
  /** Whether this series has a dashed (predicted) component — drawn into swatch. */
  hasDashed?: boolean;
}

/** A short line swatch in the series color (with a dashed tail when the series
 *  carries a predicted line). */
function Swatch({ color, hasDashed }: { color: string; hasDashed?: boolean }) {
  return (
    <svg width="24" height="10" viewBox="0 0 24 10" aria-hidden="true">
      <line x1="2" y1="5" x2={hasDashed ? 13 : 22} y2="5" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
      {hasDashed ? (
        <line
          x1="13"
          y1="5"
          x2="22"
          y2="5"
          stroke={color}
          strokeWidth="2.5"
          strokeDasharray="4 3"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

/** Interactive legend: a swatch + label per series, with an optional remove (×). */
export function VsLegend({
  items,
  onRemove,
}: {
  items: VsLegendItem[];
  onRemove?: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs">
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-1.5">
          <Swatch color={item.color} hasDashed={item.hasDashed} />
          <span className="text-text-secondary">{item.label}</span>
          {onRemove ? (
            <button
              type="button"
              onClick={() => onRemove(item.id)}
              aria-label={`Remove ${item.label}`}
              className="ml-0.5 inline-flex size-4 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
            >
              <Icon icon={Cancel01Icon} className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number | null;
  payload?: { pct?: number; __meta?: Record<string, VsCellMeta> };
}

/** Hover tooltip: lists every series' value at the hovered pct, with the real
 *  date/event when the series is date-bearing. */
export function VsTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadEntry[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const meta = row?.__meta ?? {};
  // One row per non-null entry, de-duped by series (a 2026 corps has 2 lines but
  // we show whichever has a value at this pct).
  const seen = new Set<string>();
  const lines = payload
    .filter((e) => e.value != null && e.dataKey != null)
    .map((e) => ({ entry: e, m: meta[String(e.dataKey)] }))
    .filter(({ m }) => m && !m.ghost && !seen.has(m.seriesId) && seen.add(m.seriesId));

  if (lines.length === 0) return null;
  const pct = row?.pct;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      {typeof pct === 'number' ? (
        <div className="mb-1 font-medium text-foreground">{Math.round(pct)}% through season</div>
      ) : null}
      <div className="space-y-0.5">
        {lines.map(({ entry, m }) => (
          <div key={m.seriesId} className="flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: m.color }} />
            <span className="text-foreground">{m.seriesLabel}</span>
            <span className="ml-auto pl-3 tabular-nums text-foreground">
              {Number(entry.value).toFixed(3)}
            </span>
            {m.date ? <span className="text-muted-foreground">· {fmtDate(m.date)}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
