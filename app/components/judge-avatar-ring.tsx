import { captionSlices } from '@/lib/judge-caption-breakdown';
import type { CaptionCount } from '@/lib/judge-directory';
import { JudgeAvatar } from '@/components/judge-avatar';

/**
 * A judge's avatar wrapped in a thin caption-breakdown ring — the compact,
 * card-sized counterpart to the profile page's recharts donut. Pure SVG (no
 * chart lib, no tooltip): a directory can render hundreds of these, so it must
 * stay cheap and SSR-safe. Segment colors match the caption chips.
 *
 * `breakdown` is the judge's all-time per-caption counts (from the read-model);
 * an empty/undefined breakdown renders a plain avatar (no ring).
 */
export function JudgeAvatarRing({
  name,
  photoUrl,
  breakdown,
  size = 48,
  thickness = 4,
  gap = 3,
}: {
  name: string;
  photoUrl: string | null | undefined;
  breakdown: readonly CaptionCount[] | undefined;
  /** Avatar diameter in px. */
  size?: number;
  /** Ring stroke width in px. */
  thickness?: number;
  /** Gap between avatar edge and ring in px. */
  gap?: number;
}) {
  const slices = captionSlices(breakdown ?? []);

  // Plain avatar when there's nothing to chart.
  if (slices.length === 0) {
    return <JudgeAvatar name={name} photoUrl={photoUrl} size={size} iconSize="md" />;
  }

  const box = size + 2 * (thickness + gap);
  const center = box / 2;
  const radius = center - thickness / 2; // stroke is centered on the path
  // pathLength normalizes the circumference to 100 so dash values are percents.
  let offset = 0;

  return (
    <div className="relative shrink-0" style={{ width: box, height: box }}>
      <svg
        width={box}
        height={box}
        viewBox={`0 0 ${box} ${box}`}
        // Start segments at 12 o'clock and run clockwise.
        style={{ transform: 'rotate(-90deg)' }}
        aria-hidden="true"
      >
        {slices.map((s) => {
          const seg = s.pct * 100;
          // 1px visual gap between segments when there's more than one.
          const dashGap = slices.length > 1 ? 1 : 0;
          const dash = Math.max(seg - dashGap, 0.5);
          const circle = (
            <circle
              key={s.caption}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={s.colorVar}
              strokeWidth={thickness}
              pathLength={100}
              strokeDasharray={`${dash} ${100 - dash}`}
              strokeDashoffset={-offset}
            />
          );
          offset += seg;
          return circle;
        })}
      </svg>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <JudgeAvatar name={name} photoUrl={photoUrl} size={size} iconSize="md" />
      </div>
    </div>
  );
}
