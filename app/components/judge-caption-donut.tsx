import { useEffect, useMemo, useState, useCallback } from 'react';
import { PieChart, Pie, Cell, Tooltip } from 'recharts';
import { buildCaptionBreakdown, type CaptionSlice } from '@/lib/judge-caption-breakdown';
import type { JudgeAssignment } from '@/lib/judge-directory';
import { CaptionChip } from '@/components/caption-chip';
import { JudgeAvatar } from '@/components/judge-avatar';

const SIZE = 168;
const OUTER = 84;
// A thicker ring gives a much larger touch target so segments are easy to tap
// on mobile (the old 10px ring was nearly impossible to hit).
const INNER = 64;
// The photo fills the hole, leaving a small gap to the (now thicker) ring.
const PHOTO = INNER * 2 - 12;

function DonutTooltip({ active, payload }: { active?: boolean; payload?: any[] }) {
  if (!active || !payload?.length) return null;
  const slice = payload[0].payload as CaptionSlice;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-foreground">{slice.caption}</div>
      <div className="text-muted-foreground">
        {slice.count} assignment{slice.count !== 1 ? 's' : ''} · {(slice.pct * 100).toFixed(0)}%
      </div>
    </div>
  );
}

/**
 * A donut of a judge's assignment breakdown by caption, wrapped around their
 * profile photo (or a fallback icon). Segment colors match the caption chips;
 * hover reveals the caption, count, and share. Counted client-side from
 * `assignments` — no query/endpoint/cache.
 */
export function JudgeCaptionDonut({
  name,
  photoUrl,
  assignments,
}: {
  name: string;
  photoUrl: string | null;
  assignments: readonly JudgeAssignment[];
}) {
  const slices = useMemo(() => buildCaptionBreakdown(assignments), [assignments]);

  // recharts can't measure/render meaningfully during SSR; render the photo +
  // a static ring first, then mount the chart on the client (no layout shift).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Mobile-friendly tap-to-reveal: tapping a segment shows the tooltip;
  // tapping again (or tapping the same segment) dismisses it.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const handlePieClick = useCallback((_data: unknown, index: number) => {
    setActiveIndex((prev) => (prev === index ? null : index));
  }, []);

  return (
    <div
      className="relative shrink-0"
      style={{ width: SIZE, height: SIZE }}
      // Dismiss the tap tooltip when tapping the background (outside any segment).
      onClick={(e) => {
        if (e.target === e.currentTarget) setActiveIndex(null);
      }}
    >
      {/* Ring */}
      {mounted && slices.length > 0 ? (
        <PieChart width={SIZE} height={SIZE} className="cursor-pointer">
          <Pie
            data={slices as CaptionSlice[]}
            dataKey="count"
            nameKey="caption"
            cx="50%"
            cy="50%"
            innerRadius={INNER}
            outerRadius={OUTER}
            paddingAngle={slices.length > 1 ? 1.5 : 0}
            stroke="var(--color-background)"
            strokeWidth={2}
            isAnimationActive={false}
            startAngle={90}
            endAngle={-270}
            onClick={handlePieClick}
          >
            {slices.map((s) => (
              <Cell key={s.caption} fill={s.colorVar} />
            ))}
          </Pie>
          {/* recharts Tooltip handles desktop hover; on mobile/touch it never
              fires, so the tap-driven tooltip is rendered outside the chart below. */}
          <Tooltip
            content={<DonutTooltip />}
            allowEscapeViewBox={{ x: true, y: true }}
            wrapperStyle={{ zIndex: 50 }}
          />
        </PieChart>
      ) : (
        // SSR / no-data placeholder ring.
        <div
          className="absolute inset-0 rounded-full border-[6px] border-muted"
          aria-hidden="true"
        />
      )}

      {/* Tap-driven tooltip: rendered outside the PieChart so it isn't clipped
          by the SVG viewBox and works independently of recharts' hover-only
          activation. Shown only when a segment is tapped on touch devices;
          desktop hover still uses recharts' built-in Tooltip. */}
      {activeIndex !== null && slices[activeIndex] ? (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-3 py-2 text-center text-xs shadow-md">
          <div className="font-medium text-foreground">{slices[activeIndex].caption}</div>
          <div className="text-muted-foreground">
            {slices[activeIndex].count} assignment
            {slices[activeIndex].count !== 1 ? 's' : ''} ·{' '}
            {(slices[activeIndex].pct * 100).toFixed(0)}%
          </div>
        </div>
      ) : null}

      {/* Centered photo / fallback, sits in the hole and ignores pointer events
          so the ring underneath stays hoverable / tappable. */}
      <JudgeAvatar
        name={name}
        photoUrl={photoUrl}
        size={PHOTO}
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      />
    </div>
  );
}

/** Small color-coded legend listing each caption + count, reusing chip colors. */
export function JudgeCaptionLegend({ assignments }: { assignments: readonly JudgeAssignment[] }) {
  const slices = useMemo(() => buildCaptionBreakdown(assignments), [assignments]);
  if (slices.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {slices.map((s) => (
        <CaptionChip key={s.caption} caption={`${s.caption} · ${s.count}`} />
      ))}
    </div>
  );
}
