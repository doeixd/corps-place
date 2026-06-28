import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Table } from '@/components/ui/table';
import { ClassBadge } from '@/components/class-badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  CAPTIONS,
  fmt,
  rollScenario,
  type Caption,
  type CaptionInterval,
  type RecapRow,
} from '@/lib/prediction-scenario';
import { createRng } from '@/lib/seeded-rng';

export interface PaletteRowInput {
  corpsKey: string;
  corps: string;
  division: string | null;
  caps: Record<Caption, number>;
  /** Model confidence bands per caption — drives the Monte-Carlo "Roll". */
  intervals?: Partial<Record<Caption, CaptionInterval>>;
}
/** Sparse overrides: corpsKey → caption → edited value. The URL/share unit. */
export type PaletteEdits = Record<string, Partial<Record<Caption, number>>>;

const CAPTION_NAMES: Record<Caption, string> = {
  GE1: 'General Effect 1',
  GE2: 'General Effect 2',
  VP: 'Visual Proficiency',
  VA: 'Visual Analysis',
  CG: 'Color Guard',
  MB: 'Music Brass',
  MA: 'Music Analysis',
  MP: 'Music Percussion',
};

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

const fmtCap = (n: number | undefined) =>
  typeof n === 'number' && !Number.isNaN(n) ? String(Number(n.toFixed(3))) : '';

const parseCell = (s: string): { v: number; error: boolean } => {
  if (s.trim() === '') return { v: 0, error: true };
  const v = Number(s);
  if (Number.isNaN(v) || v < 0 || v > 20) return { v: Math.max(0, Math.min(20, v || 0)), error: true };
  return { v, error: false };
};

type EditStrings = Record<string, Partial<Record<Caption, string>>>;
const storageKey = (slug: string) => `predict-palette:${slug}`;

const editsToStrings = (e: PaletteEdits | null | undefined): EditStrings => {
  const out: EditStrings = {};
  for (const ck of Object.keys(e ?? {})) {
    out[ck] = {};
    for (const c of CAPTIONS) {
      const v = e?.[ck]?.[c];
      if (typeof v === 'number') out[ck]![c] = String(v);
    }
  }
  return out;
};

/** Effective caption value as a string: an edit if present, else the model's. */
const effective = (row: PaletteRowInput, edits: EditStrings, c: Caption): string => {
  const e = edits[row.corpsKey]?.[c];
  return e !== undefined ? e : fmtCap(row.caps[c]);
};

/**
 * Editable prediction recap (the "palette"). Mirrors the prediction recap layout
 * — corps × captions grouped GE / Visual / Music — but every caption is an
 * editable field. Subtotals + Total recompute live; the ranking re-sorts on a
 * short delay (so the row you're editing never jumps out from under you) and each
 * row shows how its rank moved vs. the model's forecast. Edits persist on this
 * device and can be shared via a link.
 */
export function PalettePredictionTable({
  initial,
  eventSlug,
  initialEdits,
}: {
  initial: PaletteRowInput[];
  eventSlug: string;
  initialEdits?: PaletteEdits | null;
}) {
  const [edits, setEdits] = useState<EditStrings>(() => editsToStrings(initialEdits));

  // Hydrate from localStorage on mount when the link didn't carry a scenario.
  useEffect(() => {
    if (initialEdits && Object.keys(initialEdits).length > 0) return;
    try {
      const raw = localStorage.getItem(storageKey(eventSlug));
      if (raw) setEdits(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventSlug]);

  // Persist edits for this device. Skip the first run (mount / event change) so
  // it can't `removeItem` the saved scenario before the hydrate effect's
  // setEdits lands. The table remounts per event (keyed), so this resets cleanly.
  const skipPersist = useRef(true);
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    try {
      const k = storageKey(eventSlug);
      if (Object.keys(edits).length === 0) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(edits));
    } catch {
      /* ignore */
    }
  }, [edits, eventSlug]);

  const setCap = (corpsKey: string, cap: Caption, val: string) =>
    setEdits((e) => ({ ...e, [corpsKey]: { ...e[corpsKey], [cap]: val } }));
  const reset = () => setEdits({});

  // Roll a plausible alternate finish: sample every caption from the model's
  // confidence band, fill the editable grid, and re-rank. Each press is a fresh
  // draw (seeded by event + counter so it's reproducible); then you can tweak it.
  const [rollN, setRollN] = useState(0);
  const hasIntervals = useMemo(
    () => initial.some((r) => r.intervals && Object.keys(r.intervals).length > 0),
    [initial]
  );
  const roll = () => {
    const n = rollN + 1;
    setRollN(n);
    const rng = createRng(`${eventSlug}:${n}`);
    const base: RecapRow[] = initial.map((r) => ({
      corps_key: r.corpsKey,
      corps: r.corps,
      division: r.division ?? undefined,
      ...r.caps,
      caption_intervals: r.intervals,
    }));
    const next: EditStrings = {};
    for (const row of rollScenario(base, '0.8', rng)) {
      const ck = typeof row.corps_key === 'string' ? row.corps_key : '';
      if (!ck) continue;
      next[ck] = {};
      for (const c of CAPTIONS) {
        const v = row[c];
        if (typeof v === 'number') next[ck]![c] = String(Number(v.toFixed(3)));
      }
    }
    setEdits(next);
  };

  // The model's forecast ranking (baseline) for the Δ column.
  const predictedRank = useMemo(() => {
    const withTotal = initial.map((r) => ({ ck: r.corpsKey, total: computeTotals(r.caps).total }));
    withTotal.sort((a, b) => b.total - a.total);
    const m = new Map<string, number>();
    withTotal.forEach((r, i) => m.set(r.ck, i + 1));
    return m;
  }, [initial]);

  const computed = initial.map((r) => {
    const capStr = Object.fromEntries(
      CAPTIONS.map((c) => [c, effective(r, edits, c)])
    ) as Record<Caption, string>;
    const cells = Object.fromEntries(
      CAPTIONS.map((c) => [c, parseCell(capStr[c])])
    ) as Record<Caption, { v: number; error: boolean }>;
    const nums = Object.fromEntries(CAPTIONS.map((c) => [c, cells[c].v])) as Record<Caption, number>;
    return {
      corpsKey: r.corpsKey,
      corps: r.corps,
      division: r.division,
      capStr,
      cells,
      totals: computeTotals(nums),
      hasError: CAPTIONS.some((c) => cells[c].error),
    };
  });
  const byKey = new Map(computed.map((r) => [r.corpsKey, r]));
  const liveSorted = [...computed].sort((a, b) => b.totals.total - a.totals.total);
  const liveRank = new Map(liveSorted.map((r, i) => [r.corpsKey, i + 1]));
  const errorCount = computed.filter((c) => c.hasError).length;
  const dirty = Object.keys(edits).length > 0;

  // Re-sort the displayed rows only after edits settle (650ms), so an in-progress
  // edit doesn't make its row leap to a new position mid-keystroke.
  const liveOrder = liveSorted.map((r) => r.corpsKey).join(',');
  const [orderKeys, setOrderKeys] = useState<string[]>(() => liveSorted.map((r) => r.corpsKey));
  const orderRef = useRef(liveSorted.map((r) => r.corpsKey));
  orderRef.current = liveSorted.map((r) => r.corpsKey);
  useEffect(() => {
    const t = setTimeout(() => setOrderKeys(orderRef.current), 650);
    return () => clearTimeout(t);
  }, [liveOrder]);

  const display = orderKeys.map((k) => byKey.get(k)).filter((r): r is NonNullable<typeof r> => !!r);

  const share = () => {
    const numeric: PaletteEdits = {};
    for (const r of initial)
      for (const c of CAPTIONS) {
        const raw = edits[r.corpsKey]?.[c];
        if (raw == null || raw === '') continue;
        const v = Number(raw);
        if (Number.isNaN(v) || Math.abs(v - r.caps[c]) < 1e-9) continue;
        (numeric[r.corpsKey] ??= {})[c] = v;
      }
    const url = new URL(window.location.href);
    url.searchParams.set('event', eventSlug);
    if (Object.keys(numeric).length > 0) url.searchParams.set('edits', JSON.stringify(numeric));
    else url.searchParams.delete('edits');
    navigator.clipboard
      .writeText(url.toString())
      .then(() => toast.success('Scenario link copied to clipboard.'))
      .catch(() => toast.error('Could not copy the link.'));
  };

  const cellHeader = 'px-1.5 py-1 text-center text-xs font-medium text-text-secondary';
  const subHeader = 'px-2 py-1 text-center text-xs font-semibold text-foreground bg-muted/60';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-secondary" aria-live="polite">
          {errorCount > 0 ? (
            <span className="text-destructive">
              {errorCount} {errorCount === 1 ? 'corps has' : 'corps have'} an invalid score — each
              caption must be 0–20.
            </span>
          ) : dirty ? (
            'Edited — totals and ranks reflect your changes. The ranking re-sorts a moment after you stop typing.'
          ) : (
            'Tap any caption score and edit it to see the ranking change.'
          )}
        </p>
        <div className="flex items-center gap-2">
          {hasIntervals ? (
            <Button type="button" variant="outline" size="sm" onClick={roll} title="Sample a plausible alternate finish from the model's confidence bands">
              Roll scenario
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" disabled={!dirty} onClick={share}>
            Copy share link
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={!dirty} onClick={reset}>
            Reset
          </Button>
        </div>
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
          {display.map((r) => {
            const rank = liveRank.get(r.corpsKey) ?? 0;
            const delta = (predictedRank.get(r.corpsKey) ?? rank) - rank;
            return (
              <motion.tr
                key={r.corpsKey}
                layout="position"
                transition={{ type: 'spring', stiffness: 500, damping: 50 }}
                className="border-b border-border/60 last:border-0 hover:bg-muted/40"
              >
                <td className="px-2 py-1.5 text-center align-middle">
                  <span className="inline-flex items-center gap-1">
                    <span className="text-muted-foreground">{rank}</span>
                    <RankDelta delta={delta} />
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 align-middle font-medium text-text-primary">
                  {r.corps}
                </td>
                <td className="px-2 py-1.5 text-center align-middle">
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
              </motion.tr>
            );
          })}
        </tbody>
      </Table>

      <p className="text-xs text-text-secondary">
        ▲/▼ shows how each corps moved versus the model&apos;s forecast. Hover a caption header for
        its full name.
      </p>
    </div>
  );
}

function RankDelta({ delta }: { delta: number }) {
  if (!delta) return null;
  const up = delta > 0;
  return (
    <span
      className={cn('text-[10px] font-semibold leading-none', up ? 'text-emerald-600' : 'text-destructive')}
      aria-label={up ? `up ${delta}` : `down ${-delta}`}
    >
      {up ? '▲' : '▼'}
      {Math.abs(delta)}
    </span>
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
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2" />}>
              {cap}
            </TooltipTrigger>
            <TooltipContent>{CAPTION_NAMES[cap]}</TooltipContent>
          </Tooltip>
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
    corps: string;
    capStr: Record<Caption, string>;
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
            value={row.capStr[cap]}
            aria-invalid={row.cells[cap].error}
            aria-label={`${CAPTION_NAMES[cap]} for ${row.corps}`}
            onChange={(e) => onChange(cap, e.target.value)}
            className={cn(
              'w-14 rounded-md border bg-transparent px-1 py-1 text-center font-mono text-sm tabular-nums',
              'focus:outline-none focus:ring-2 focus:ring-primary/40',
              row.cells[cap].error ? 'border-destructive ring-1 ring-destructive/50' : 'border-border'
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
