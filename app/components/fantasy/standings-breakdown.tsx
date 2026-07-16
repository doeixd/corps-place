import { Link } from '@tanstack/react-router';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import { formatScore } from '@/lib/format';
import type { PickedCorps } from '@/lib/server-fns/fantasy';

type Contribution = { corpsKey: string; value: number; weight: number };

/** A single member's pick breakdown, stashed on the RecapRow by the standings page. */
export interface StandingsBreakdownData {
  contributions: Record<string, Contribution[]>;
  perCaption: Record<string, number>;
  ge: number;
  visual: number;
  music: number;
  total: number;
}

/**
 * One drafted corps, stacked vertically to fit a caption column: logo, truncated
 * name, its season-best value in that caption, and the pick weight when ≠1.
 * Unscored picks dim (their value is missing data, excluded from the aggregate).
 */
function PickChip({ pick, corps }: { pick: Contribution; corps?: PickedCorps }) {
  const scored = pick.value > 0;
  const name = corps?.name ?? pick.corpsKey;
  const inner = (
    <span
      className={
        'flex flex-col items-center gap-0.5' + (scored ? '' : ' opacity-50')
      }
      title={scored ? name : `${name} — not scored yet`}
    >
      <CorpsLogo
        name={name}
        logo={corps ? corpsLogoSource(corps) : null}
        width={24}
        className="size-6"
      />
      <span className="max-w-[76px] truncate text-[10px] font-normal leading-tight text-text-secondary">
        {name}
      </span>
      <span className="font-mono text-[10px] leading-tight tabular-nums">
        {scored ? formatScore(pick.value) : '—'}
        {pick.weight !== 1 ? (
          <span className="text-muted-foreground"> ×{Number(pick.weight.toFixed(2))}</span>
        ) : null}
      </span>
    </span>
  );
  if (!corps?.slug) return inner;
  return (
    <Link
      to="/corps/$slug/{-$season}"
      params={{ slug: corps.slug }}
      onClick={(e) => e.stopPropagation()} // don't re-toggle the expanded row
      className="transition-opacity hover:opacity-80"
    >
      {inner}
    </Link>
  );
}

// Raw category rollups derived from the SAME per-caption values shown in the row,
// so the detail cells always reconcile with their own formula (identical to the
// row's GE/Visual/Music columns at the default 40/30/30 category weights).
const SUBTOTALS: Record<string, { formula: string; value: (pc: Record<string, number>) => number }> = {
  GE: { formula: 'GE1 + GE2', value: (pc) => (pc.GE1 ?? 0) + (pc.GE2 ?? 0) },
  Visual: {
    formula: '(VP + VA + CG) ÷ 2',
    value: (pc) => ((pc.VP ?? 0) + (pc.VA ?? 0) + (pc.CG ?? 0)) / 2,
  },
  Music: {
    formula: '(MB + MA + MP) ÷ 2',
    value: (pc) => ((pc.MB ?? 0) + (pc.MA ?? 0) + (pc.MP ?? 0)) / 2,
  },
  total: {
    formula: 'GE + Vis + Mus',
    value: (pc) =>
      (pc.GE1 ?? 0) +
      (pc.GE2 ?? 0) +
      ((pc.VP ?? 0) + (pc.VA ?? 0) + (pc.CG ?? 0)) / 2 +
      ((pc.MB ?? 0) + (pc.MA ?? 0) + (pc.MP ?? 0)) / 2,
  },
};

/**
 * A subtotal cell in the expanded detail row (total / GE / Visual / Music
 * columns): the category rollup with the formula that produces it, sitting under
 * the column it explains. Returns null for other columns.
 */
export function StandingsSubtotalCell({
  data,
  colKey,
}: {
  data: StandingsBreakdownData;
  colKey: string;
}) {
  const sub = SUBTOTALS[colKey];
  if (!sub) return null;
  const value = sub.value(data.perCaption);
  return (
    <span className="flex flex-col items-center gap-0.5">
      <span
        className={
          'font-mono text-sm tabular-nums' + (colKey === 'total' ? ' font-bold' : '')
        }
      >
        {value > 0 ? formatScore(value) : '—'}
      </span>
      <span className="whitespace-nowrap text-[9px] leading-tight text-muted-foreground">
        = {sub.formula}
      </span>
    </span>
  );
}

/**
 * The content of ONE caption cell in an expanded standings detail row: the corps
 * the member drafted for that caption, aligned directly under the caption column
 * whose aggregate they produce. Multiple picks in one caption stack vertically.
 */
export function StandingsPickCell({
  picks,
  corpsByKey,
}: {
  picks: Contribution[] | undefined;
  corpsByKey: Record<string, PickedCorps>;
}) {
  if (!picks?.length) return <span className="text-muted-foreground/40">—</span>;
  return (
    <div className="flex flex-col items-center gap-2">
      {picks.map((pick, i) => (
        <PickChip key={`${pick.corpsKey}-${i}`} pick={pick} corps={corpsByKey[pick.corpsKey]} />
      ))}
    </div>
  );
}
