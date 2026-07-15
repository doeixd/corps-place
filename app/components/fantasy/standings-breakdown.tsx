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
}> = [
  { key: 'ge', label: 'General Effect', formula: 'GE1 + GE2', captions: [] },
  { key: 'visual', label: 'Visual', formula: '(VP + VA + CG) ÷ 2', captions: [] },
  { key: 'music', label: 'Music', formula: '(MB + MA + MP) ÷ 2', captions: [] },
];
for (const k of CAPTION_KEYS) CATEGORIES.find((c) => c.key === CAPTION_CATEGORY[k])!.captions.push(k);

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
        <span className="shrink-0 font-mono text-xs text-muted-foreground">×{String(pick.weight)}</span>
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
  const category = { ge: data.ge, visual: data.visual, music: data.music } as const;
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
              {formatScore(category[cat.key])}
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
                      {picks.length ? formatScore(data.perCaption[k] ?? 0) : '—'}
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
