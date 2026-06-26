import { Link } from '@tanstack/react-router';
import { Badge, type BadgeProps } from '@/components/reui/badge';
import { Icon, type IconComponent } from '@/components/icon';
import { cn } from '@/lib/utils';
import { classShortName, divisionCategory, type DivisionCategory } from '@/lib/prediction-scenario';
import {
  Airplane01Icon,
  CubeIcon,
  FireIcon,
  GiftIcon,
  GlobalIcon,
  MusicNote03Icon,
  UserGroupIcon,
} from '@/components/icons/generated';

// Pill styling per division *category* (see `divisionCategory`), so every spelling
// of a class — "All Age Class", "All-Age - Open Class", etc. — gets one color +
// icon. Unknown categories fall back to the neutral outline globe. The pill text
// comes from `classShortName` so the short label stays defined in one place.
const CATEGORY_BADGE: Record<
  DivisionCategory,
  { variant: BadgeProps['variant']; icon?: IconComponent; className?: string }
> = {
  world: { variant: 'success-light', icon: GlobalIcon }, // green globe
  open: { variant: 'info-light', icon: CubeIcon }, // blue cube
  'all-age': { variant: 'warning-light', icon: UserGroupIcon }, // amber group
  international: {
    variant: 'destructive-light',
    icon: Airplane01Icon,
    className:
      'bg-[oklch(0.96_0.025_18)] text-[oklch(0.52_0.13_20)] dark:bg-[oklch(0.28_0.055_18)] dark:text-[oklch(0.84_0.08_20)]',
  },
  soundsport: {
    variant: 'focus-light',
    icon: MusicNote03Icon,
    className:
      'bg-[oklch(0.96_0.025_300)] text-[oklch(0.5_0.11_300)] dark:bg-[oklch(0.27_0.045_300)] dark:text-[oklch(0.82_0.08_300)]',
  },
  exhibition: {
    variant: 'outline',
    icon: GiftIcon,
    className:
      'border-transparent bg-[oklch(0.93_0_0)] text-[oklch(0.42_0_0)] dark:bg-[oklch(0.28_0_0)] dark:text-[oklch(0.82_0_0)]',
  },
  alumni: {
    variant: 'outline',
    icon: FireIcon,
    className:
      'border-transparent bg-[oklch(0.94_0.03_65)] text-[oklch(0.46_0.07_55)] dark:bg-[oklch(0.28_0.04_60)] dark:text-[oklch(0.84_0.06_65)]',
  },
  other: { variant: 'outline' },
};

// The `/corps?cls=` filter value for a division (handles spelling variants via
// `divisionCategory`, plus International). null → no filter target (don't link).
const clsFilterValue = (division: string | undefined): string | null => {
  const category = divisionCategory(division);
  if (category === 'exhibition') return 'other';
  if (category !== 'other') return category;
  return null;
};

export function ClassBadge({
  division,
  noLink,
  iconOnly,
}: {
  division: string | undefined;
  /** Render as plain text (e.g. when already nested inside another link). */
  noLink?: boolean;
  /** Show only the category icon, dropping the short label text. */
  iconOnly?: boolean;
}) {
  const { variant, icon: BadgeIcon, className } = CATEGORY_BADGE[divisionCategory(division)];

  // Icon-only pills (e.g. compact lineup cards) keep the label for a11y but hide
  // it visually. The hidden label is `sr-only` (out of flow), so we also drop the
  // icon→text `gap` and tighten padding to `px-1` — otherwise the pill keeps the
  // gap + wider padding meant for a labeled chip and looks lopsided (trailing
  // space after the icon). px-1 (4px) + the 12px icon = the 20px `min-w-5` pill,
  // so the icon centers in a snug circle.
  const iconPill = !!(iconOnly && BadgeIcon);
  const badge = (
    <Badge
      variant={variant}
      radius="full"
      className={cn('leading-none', iconPill ? 'gap-0 px-1' : 'gap-1', className)}
    >
      {BadgeIcon ? <Icon icon={BadgeIcon} size="sm" className="size-3 shrink-0" /> : null}
      {/* icon-only: pure `sr-only` (absolute, out of flow) so the icon truly
          centers — NOT `relative` too, which would keep the 1px label in flow and
          shove the icon left-of-center. Labeled: nudge the text baseline. */}
      <span className={iconPill ? 'sr-only' : 'relative top-px'}>{classShortName(division)}</span>
    </Badge>
  );

  const cls = noLink ? null : clsFilterValue(division);
  if (!cls) return badge;

  // Clicking the chip opens the corps directory filtered to this class.
  return (
    <Link
      to="/corps"
      search={{ cls }}
      aria-label={`View ${classShortName(division)} corps`}
      className="inline-flex transition-opacity hover:opacity-80"
    >
      {badge}
    </Link>
  );
}
