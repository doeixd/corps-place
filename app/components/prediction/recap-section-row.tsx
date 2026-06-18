import { motion } from 'motion/react';
import { Icon, type IconComponent } from '@/components/icon';
import { CubeIcon, GlobalIcon, UserGroupIcon } from '@/components/icons/generated';
import type { RecapGroupKey } from '@/lib/prediction-scenario';

// Per-class-group icon, keyed off the recap group. Shared by the compact and
// full recap tables so their division-group divider rows are identical.
export const GROUP_ICONS: Partial<Record<RecapGroupKey, IconComponent>> = {
  world: GlobalIcon,
  open: CubeIcon,
  'all-age': UserGroupIcon,
};

/**
 * A class-group divider row ("World Class", "Open Class", …) for the recap
 * tables. The icon + label live in the frozen Rank cell (kept transparent so it
 * blends into the band) and overflow across the row. The `layoutId` is shared by
 * the compact and full tables so the divider morphs in place when the user
 * toggles between them.
 *
 * `trailingColSpan` covers every column to the right of the two frozen columns
 * (Rank + Corps): the compact table passes `1 + SCORE_COLUMNS.length`, the full
 * table passes its `totalCols - 2`.
 */
export function RecapSectionRow({
  sectionKey,
  label,
  trailingColSpan,
}: {
  sectionKey: RecapGroupKey;
  label: string;
  trailingColSpan: number;
}) {
  const groupIcon = GROUP_ICONS[sectionKey];
  return (
    <motion.tr
      layoutId={`recap-group-${sectionKey}`}
      layout="position"
      transition={{ type: 'spring', stiffness: 500, damping: 50, mass: 1 }}
      data-slot="table-row"
      className="bg-muted/40 hover:bg-muted/40"
    >
      <td
        className="sticky-col sticky left-0 z-10 inline-flex w-[48px] min-w-[48px] max-w-[48px] items-center gap-1.5 whitespace-nowrap py-3 pl-[22px] pr-1 text-xs font-medium text-muted-foreground !border-b-0 !bg-transparent sm:w-[64px] sm:min-w-[64px] sm:max-w-[64px] sm:pl-[26px] sm:pr-2"
        style={{ textBoxTrim: 'trim-both', alignItems: 'center' }}
      >
        {groupIcon && <Icon icon={groupIcon} size="sm" className="size-3 translate-y-0" />}
        {label}
      </td>
      <td className="sticky-col sticky-col-edge sticky left-[48px] z-10 py-3 !border-b-0 !bg-transparent sm:left-[64px]" />
      <td colSpan={trailingColSpan} className="py-3" />
    </motion.tr>
  );
}
