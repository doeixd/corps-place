import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { getStandingsHistory } from '@/lib/server-fns/fantasy';
import type { RankRow, RankChartMode } from '@/lib/rankings/types';

// Reuse the rankings bump chart (recharts, ~330KB) — lazy + client-only so it
// never touches the SSR payload. We fetch the history client-side too, so this
// whole feature adds nothing to first paint.
const RankBumpChart = lazy(() =>
  import('@/components/rankings/rank-bump-chart').then((m) => ({ default: m.RankBumpChart }))
);

type History = Awaited<ReturnType<typeof getStandingsHistory>>;
type Series = History['series'][number];

// Categorical fallback palette. Members choose their own corps color, so unlike
// /rankings (distinct brand hues) we can get nulls and duplicates — which would
// collapse into indistinguishable lines. Each series keeps its own color only if
// it's set and not already taken; otherwise it gets the next distinct hue here.
const FALLBACK_COLORS = [
  '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2',
  '#ca8a04', '#db2777', '#4f46e5', '#65a30d', '#0d9488', '#e11d48',
  '#7c3aed', '#0284c7', '#d97706', '#059669', '#c026d3', '#475569',
];

function withDistinctColors(series: Series[]): Array<{ s: Series; color: string }> {
  const used = new Set<string>();
  let fi = 0;
  return series.map((s) => {
    let color = s.color ? s.color.toLowerCase() : null;
    if (!color || used.has(color)) {
      while (fi < FALLBACK_COLORS.length && used.has(FALLBACK_COLORS[fi]!)) fi++;
      color = fi < FALLBACK_COLORS.length ? FALLBACK_COLORS[fi++]! : (color ?? '#888888');
    }
    used.add(color);
    return { s, color };
  });
}

/** Adapt a member's history series to the RankRow shape the bump chart reads. */
const toRankRow = ({ s, color }: { s: Series; color: string }): RankRow => {
  const last = s.points[s.points.length - 1];
  return {
    corpsSlug: s.userId,
    corpsName: s.name,
    division: '',
    score: last?.score ?? 0,
    rank: last?.rank ?? 0,
    lastPerformedDate: '',
    daysSinceLast: 0,
    scoreDelta: null,
    partial: false,
    history: s.points,
    colorPrimary: color,
    colorSecondary: null,
  };
};

/**
 * The season-progress chart at the top of the standings page: each active member
 * is a line, tracking their league rank or fantasy score across the season.
 * Renders nothing until there's a real race to show (≥2 members and ≥2 dates).
 * `refreshKey` (the live standings' last-updated stamp) re-pulls the series after
 * a recompute so the chart doesn't drift from the live table below it.
 */
export function StandingsChart({
  slug,
  refreshKey,
  enabled = true,
}: {
  slug: string;
  refreshKey?: string | null;
  /** Skip the history fetch when the caller already knows there's no race to
      show (e.g. a one-member league) — avoids a wasted query per visit. */
  enabled?: boolean;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [mode, setMode] = useState<RankChartMode | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const modeDecided = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getStandingsHistory({ data: { slug } })
      .then((h) => {
        if (alive) setHistory(h);
      })
      .catch(() => {
        /* enhancement only — leave the chart hidden on failure */
      });
    return () => {
      alive = false;
    };
  }, [slug, refreshKey, enabled]);

  // Rank is a weak story for a tiny league (just #1↔#2), so default to score
  // there; larger leagues get the classic bump chart. Decided once; the user's
  // toggle then wins.
  useEffect(() => {
    if (history && !modeDecided.current) {
      modeDecided.current = true;
      setMode(history.series.length <= 2 ? 'score' : 'rank');
    }
  }, [history]);

  const colored = useMemo(
    () => (history ? withDistinctColors(history.series) : []),
    [history]
  );
  const rows = useMemo(() => colored.map(toRankRow), [colored]);

  // A standings race needs ≥2 members and ≥2 dated points to be worth showing.
  if (!history || history.dates.length < 2 || rows.length < 2) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <h2 className="text-lg font-medium text-text-primary">Season progress</h2>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Chart view"
          value={[mode ?? 'rank']}
          onValueChange={(v) => {
            const next = v[0] as RankChartMode | undefined;
            if (next) setMode(next);
          }}
        >
          <ToggleGroupItem value="rank">Rank</ToggleGroupItem>
          <ToggleGroupItem value="score">Score</ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<div className="h-80 w-full" />}>
          <RankBumpChart
            rows={rows}
            dates={history.dates}
            mode={mode ?? 'rank'}
            hoveredSlug={hovered}
            onHover={setHovered}
          />
        </Suspense>
      </CardContent>
    </Card>
  );
}
