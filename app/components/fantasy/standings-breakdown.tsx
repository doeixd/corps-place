import { CorpsNameCell } from '@/components/corps-name-cell';
import { CAPTION_KEYS, CAPTION_CATEGORY, type CaptionKey } from '@/lib/fantasy/captions';
import { formatScore } from '@/lib/format';
import type { PickedCorps } from '@/lib/server-fns/fantasy';

type Contribution = { corpsKey: string; value: number; weight: number };

/** A single member's pick breakdown, as rendered inside an expanded standings row. */
export interface StandingsBreakdownData {
  contributions: Record<string, Contribution[]>;
  perCaption: Record<string, number>;
  ge: number;
  visual: number;
  music: number;
  total: number;
}

const CAPTION_LABEL: Record<CaptionKey, string> = {
  GE1: 'GE 1',
  GE2: 'GE 2',
  VP: 'Visual Proficiency',
  VA: 'Visual Analysis',
  CG: 'Color Guard',
  MB: 'Music Brass',
  MA: 'Music Analysis',
  MP: 'Music Percussion',
};

const CATEGORIES: Array<{
  key: 'ge' | 'visual' | 'music';
  label: string;
  formula: string;
  captions: CaptionKey[];
}> = (
  [
    { key: 'ge', label: 'General Effect', formula: 'GE1 + GE2' },
    { key: 'visual', label: 'Visual', formula: '(VP + VA + CG) ÷ 2' },
    { key: 'music', label: 'Music', formula: '(MB + MA + MP) ÷ 2' },
  ] as const
).map((c) => ({ ...c, captions: CAPTION_KEYS.filter((k) => CAPTION_CATEGORY[k] === c.key) }));

// The category subtotal shown here is derived from the SAME per-caption values
// displayed below it — `GE1 + GE2` for GE, `(…)/2` for Visual/Music — so the
// panel always reconciles with its own formula. At the default 40/30/30 weights
// this equals the standings table's GE/Visual/Music columns exactly; only a
// league with custom category weights would see the table's (weighted) column
// diverge from this raw caption math.
const rawSubtotal = (perCaption: Record<string, number>, cat: (typeof CATEGORIES)[number]) => {
  const sum = cat.captions.reduce((s, k) => s + (perCaption[k] ?? 0), 0);
  return cat.key === 'ge' ? sum : sum / 2;
};

/** One drafted corps: logo + name, its season-best caption value, and its weight. */
function CorpsContribution({ pick, corps }: { pick: Contribution; corps?: PickedCorps }) {
  const scored = pick.value > 0;
  const name = corps?.name ?? pick.corpsKey;
  return (
    <div className="flex items-center gap-2 py-0.5 text-sm">
      <span className="min-w-0 flex-1">
        <CorpsNameCell
          name={name}
          slug={corps?.slug ?? null}
          corpsKey={pick.corpsKey}
          logoClassName="size-4 sm:size-4"
          logoWidth={16}
          className={scored ? 'font-medium' : 'font-medium text-muted-foreground'}
        />
      </span>
      {pick.weight !== 1 ? (
        // Reverse-weights are fractions like 1.5384615384615383 — show a compact
        // "×1.54" (trailing zeros trimmed: ×2, ×1.5), never the raw float.
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          ×{Number(pick.weight.toFixed(2))}
        </span>
      ) : null}
      <span className="w-14 shrink-0 text-right font-mono tabular-nums">
        {scored ? (
          formatScore(pick.value)
        ) : (
          <span className="text-muted-foreground/60 text-xs italic">not scored</span>
        )}
      </span>
    </div>
  );
}

/**
 * The expanded content for a standings row: the member's drafted corps grouped
 * General Effect / Visual / Music → caption → corps, showing each pick's
 * season-best caption value and weight, the per-caption aggregate, the category
 * subtotals (with the real DCI category formula), and the total — so a player can
 * see exactly how their roster adds up. All values are the authoritative ones from
 * `computeRosterScore` (carried in the standings payload), not recomputed here.
 */
export function StandingsBreakdown({
  data,
  corpsByKey,
}: {
  data: StandingsBreakdownData;
  corpsByKey: Record<string, PickedCorps>;
}) {
  const hasAnyPick = CAPTION_KEYS.some((k) => (data.contributions[k]?.length ?? 0) > 0);

  if (!hasAnyPick) {
    return (
      <div className="px-4 py-4 text-sm text-muted-foreground">
        No picks yet — this roster fills in as the draft completes.
      </div>
    );
  }

  return (
    <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
      {CATEGORIES.map((cat) => (
        <div key={cat.key} className="space-y-2">
          <div className="flex items-baseline justify-between border-b border-border/60 pb-1">
            <span className="text-sm font-semibold text-text-primary">{cat.label}</span>
            <span className="font-mono text-sm font-bold tabular-nums">
              {rawSubtotal(data.perCaption, cat) > 0
                ? formatScore(rawSubtotal(data.perCaption, cat))
                : '—'}
            </span>
          </div>
          <div className="space-y-2">
            {cat.captions.map((k) => {
              const picks = data.contributions[k] ?? [];
              return (
                <div key={k}>
                  <div className="flex items-baseline justify-between text-[11px] uppercase tracking-wide text-muted-foreground">
                    <span>{CAPTION_LABEL[k]}</span>
                    <span className="font-mono tabular-nums">
                      {/* In recap mode a 0 aggregate means "no drafted corps has
                          scored this caption yet" (scored values are >0), so show a
                          dash — matching the main table — not a literal 0.000. */}
                      {picks.length && data.perCaption[k] ? formatScore(data.perCaption[k]) : '—'}
                    </span>
                  </div>
                  {picks.length ? (
                    picks.map((pick, i) => (
                      <CorpsContribution key={`${pick.corpsKey}-${i}`} pick={pick} corps={corpsByKey[pick.corpsKey]} />
                    ))
                  ) : (
                    <div className="py-0.5 text-xs italic text-muted-foreground/60">No pick</div>
                  )}
                </div>
              );
            })}
            <div className="pt-1 text-[11px] text-muted-foreground/70">= {cat.formula}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
