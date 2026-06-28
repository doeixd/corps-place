import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { Table } from '@/components/ui/table';
import { ClassBadge } from '@/components/class-badge';
import { Button } from '@/components/ui/button';
import { CAPTIONS, fmt, type Caption } from '@/lib/prediction-scenario';

export interface PaletteRowInput {
  corpsKey: string;
  corps: string;
  division: string | null;
  caps: Record<Caption, number>;
}

// DCI sheet: GE = GE1+GE2 (/40); Visual = (VP+VA+CG)/2 (/30); Music = (MB+MA+MP)/2
// (/30); Total = GE+Visual+Music (/100). Verified against stored predictions.
const CATEGORIES = [
  { label: 'General Effect', sub: 'GE' as const, captions: ['GE1', 'GE2'] as Caption[] },
  { label: 'Visual', sub: 'Visual' as const, captions: ['VP', 'VA', 'CG'] as Caption[] },
  { label: 'Music', sub: 'Music' as const, captions: ['MB', 'MA', 'MP'] as Caption[] },
];

const computeTotals = (c: Record<Caption, number>) => {
  const GE = c.GE1 + c.GE2;
  const Visual = (c.VP + c.VA + c.CG) / 2;
  const Music = (c.MB + c.MA + c.MP) / 2;
  return { GE, Visual, Music, total: GE + Visual + Music };
};

type CapStrings = Record<Caption, string>;
interface EditRow {
  corpsKey: string;
  corps: string;
  division: string | null;
  caps: CapStrings;
}

const fmtCap = (n: number | undefined) =>
  typeof n === 'number' && !Number.isNaN(n) ? String(Number(n.toFixed(3))) : '';
const toEdit = (r: PaletteRowInput): EditRow => ({
  corpsKey: r.corpsKey,
  corps: r.corps,
  division: r.division,
  caps: Object.fromEntries(CAPTIONS.map((c) => [c, fmtCap(r.caps[c])])) as CapStrings,
});

/** Parse one caption cell; flags blank / non-numeric / out-of-[0,20] as an error. */
const parseCell = (s: string): { v: number; error: boolean } => {
  if (s.trim() === '') return { v: 0, error: true };
  const v = Number(s);
  if (Number.isNaN(v) || v < 0 || v > 20) return { v: Math.max(0, Math.min(20, v || 0)), error: true };
  return { v, error: false };
};

/**
 * Editable prediction recap (the "palette"). Mirrors the prediction recap layout
 * — corps × captions grouped GE / Visual / Music — but every caption is an
 * editable number field. Category subtotals and Total recompute live, rows
 * re-sort by Total and re-rank, and invalid cells (blank or outside 0–20) flag
 * inline. Entirely client-side; "Reset" restores the model's forecast.
 */
export function PalettePredictionTable({ initial }: { initial: PaletteRowInput[] }) {
  const baseline = useMemo(() => initial.map(toEdit), [initial]);
  const [rows, setRows] = useState<EditRow[]>(baseline);
  const dirty = useMemo(() => JSON.stringify(rows) !== JSON.stringify(baseline), [rows, baseline]);

  const setCap = (corpsKey: string, cap: Caption, val: string) =>
    setRows((rs) =>
      rs.map((r) => (r.corpsKey === corpsKey ? { ...r, caps: { ...r.caps, [cap]: val } } : r))
    );

  const computed = rows.map((r) => {
    const cells = Object.fromEntries(CAPTIONS.map((c) => [c, parseCell(r.caps[c])])) as Record<
      Caption,
      { v: number; error: boolean }
    >;
    const nums = Object.fromEntries(CAPTIONS.map((c) => [c, cells[c].v])) as Record<Caption, number>;
    return {
      ...r,
      cells,
      totals: computeTotals(nums),
      hasError: CAPTIONS.some((c) => cells[c].error),
    };
  });
  const sorted = [...computed].sort((a, b) => b.totals.total - a.totals.total);
  const errorCount = computed.filter((c) => c.hasError).length;

  const cellHeader = 'px-1.5 py-1 text-center text-xs font-medium text-text-secondary';
  const subHeader = 'px-2 py-1 text-center text-xs font-semibold text-foreground bg-muted/60';

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-secondary">
          {errorCount > 0 ? (
            <span className="text-destructive">
              {errorCount} corps {errorCount === 1 ? 'has' : 'have'} an invalid score (each caption
              must be 0–20).
            </span>
          ) : dirty ? (
            'Edited — totals and ranks reflect your changes.'
          ) : (
            'Edit any caption to see the ranking change.'
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!dirty}
          onClick={() => setRows(baseline)}
        >
          Reset
        </Button>
      </div>

      <Table
        className="w-max min-w-full border-collapse text-sm tabular-nums"
        containerClassName="overflow-x-auto rounded-xl border border-border"
      >
        <thead className="text-text-secondary">
          <tr className="border-b border-border">
            <th rowSpan={2} className={cn(cellHeader, 'px-2')}>
              #
            </th>
            <th rowSpan={2} className="px-3 py-1 text-left text-xs font-medium">
              Corps
            </th>
            <th rowSpan={2} className={cellHeader}>
              Class
            </th>
            {CATEGORIES.map((cat) => (
              <th
                key={cat.label}
                colSpan={cat.captions.length + 1}
                className="border-l border-border bg-muted/70 px-2 py-1.5 text-center text-xs font-semibold text-foreground"
              >
                {cat.label}
              </th>
            ))}
            <th
              rowSpan={2}
              className="border-l border-border bg-foreground/5 px-2 py-1 text-center text-xs font-bold text-text-primary"
            >
              Total
            </th>
          </tr>
          <tr className="border-b border-border">
            {CATEGORIES.map((cat) => (
              <CategoryHead key={cat.label} cat={cat} cellHeader={cellHeader} subHeader={subHeader} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.corpsKey} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
              <td className="px-2 py-1.5 text-center text-muted-foreground">{i + 1}</td>
              <td className="whitespace-nowrap px-3 py-1.5 font-medium text-text-primary">
                {r.corps}
              </td>
              <td className="px-2 py-1.5 text-center">
                <ClassBadge division={r.division ?? undefined} />
              </td>
              {CATEGORIES.map((cat) => (
                <CategoryCells
                  key={cat.label}
                  cat={cat}
                  row={r}
                  onChange={(cap, val) => setCap(r.corpsKey, cap, val)}
                />
              ))}
              <td className="border-l border-border bg-foreground/5 px-2 py-1.5 text-center font-mono font-bold text-text-primary">
                {fmt(r.totals.total, 3)}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function CategoryHead({
  cat,
  cellHeader,
  subHeader,
}: {
  cat: (typeof CATEGORIES)[number];
  cellHeader: string;
  subHeader: string;
}) {
  return (
    <>
      {cat.captions.map((cap, i) => (
        <th key={cap} className={cn(cellHeader, i === 0 && 'border-l border-border')}>
          {cap}
        </th>
      ))}
      <th className={subHeader}>{cat.sub}</th>
    </>
  );
}

function CategoryCells({
  cat,
  row,
  onChange,
}: {
  cat: (typeof CATEGORIES)[number];
  row: {
    caps: CapStrings;
    cells: Record<Caption, { v: number; error: boolean }>;
    totals: { GE: number; Visual: number; Music: number };
  };
  onChange: (cap: Caption, val: string) => void;
}) {
  return (
    <>
      {cat.captions.map((cap, i) => (
        <td key={cap} className={cn('px-1 py-1', i === 0 && 'border-l border-border')}>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={20}
            step={0.05}
            value={row.caps[cap]}
            aria-invalid={row.cells[cap].error}
            aria-label={cap}
            onChange={(e) => onChange(cap, e.target.value)}
            className={cn(
              'w-14 rounded-md border bg-transparent px-1 py-1 text-center font-mono text-sm tabular-nums',
              'focus:outline-none focus:ring-2 focus:ring-primary/40',
              row.cells[cap].error
                ? 'border-destructive ring-1 ring-destructive/50'
                : 'border-border'
            )}
          />
        </td>
      ))}
      <td className="bg-muted/60 px-2 py-1.5 text-center font-mono font-semibold text-text-primary">
        {fmt(row.totals[cat.sub], 3)}
      </td>
    </>
  );
}
