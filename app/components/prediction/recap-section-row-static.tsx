import { Icon, type IconComponent } from '@/components/icon';
import { CubeIcon, GlobalIcon, UserGroupIcon } from '@/components/icons/generated';
import type { RecapGroupKey } from '@/lib/prediction-scenario';

// Inlined (not imported from recap-section-row) so this module never pulls in
// motion/react — the whole point of the static twin.
const GROUP_ICONS: Partial<Record<RecapGroupKey, IconComponent>> = {
  world: GlobalIcon,
  open: CubeIcon,
  'all-age': UserGroupIcon,
};

// Static (no-motion) twin of RecapSectionRow, for read-only recap tables (the
// /scores index + show pages) where the compact/full morph animation isn't used
// and shedding motion/react from the bundle matters more. Markup/styling is kept
// byte-identical to the animated version minus the motion wrapper.
export function RecapSectionRowStatic({
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
    <tr data-slot="table-row" className="bg-muted/40 hover:bg-muted/40">
      <td
        className="sticky-col sticky left-0 z-10 inline-flex w-[48px] min-w-[48px] max-w-[48px] items-center gap-1.5 whitespace-nowrap py-3 pl-[22px] pr-1 text-xs font-medium text-muted-foreground !border-b-0 !bg-transparent sm:w-[64px] sm:min-w-[64px] sm:max-w-[64px] sm:pl-[26px] sm:pr-2"
        style={{ textBoxTrim: 'trim-both', alignItems: 'center' }}
      >
        {groupIcon && <Icon icon={groupIcon} size="sm" className="size-3 translate-y-0" />}
        {label}
      </td>
      <td className="sticky-col sticky-col-edge sticky left-[48px] z-10 py-3 !border-b-0 !bg-transparent sm:left-[64px]" />
      <td colSpan={trailingColSpan} className="py-3" />
    </tr>
  );
}
