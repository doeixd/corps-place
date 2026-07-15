import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
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

/** Adapt a member's history series to the RankRow shape the bump chart reads. */
const toRankRow = (s: Series): RankRow => {
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
    colorPrimary: s.color,
    colorSecondary: null,
  };
};

/**
 * The season-progress chart at the top of the standings page: each active member
 * is a line, tracking their league rank (default) or fantasy score across the
 * season. Renders nothing until at least two dated points exist (a one-point
 * chart is meaningless early season).
 */
export function StandingsChart({ slug }: { slug: string }) {
  const [history, setHistory] = useState<History | null>(null);
  const [mode, setMode] = useState<RankChartMode>('rank');
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
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
  }, [slug]);

  const rows = useMemo(() => (history ? history.series.map(toRankRow) : []), [history]);

  // Hide until there's a real trend to show (≥2 dates and ≥1 member).
  if (!history || history.dates.length < 2 || rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <h2 className="text-lg font-medium text-text-primary">Season progress</h2>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          aria-label="Chart view"
          value={[mode]}
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
            mode={mode}
            hoveredSlug={hovered}
            onHover={setHovered}
          />
        </Suspense>
      </CardContent>
    </Card>
  );
}
