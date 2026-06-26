import { Link } from '@tanstack/react-router';
import { Icon, type IconComponent } from '@/components/icon';
import { Logo } from '@/components/logo';
import { useBookmarks } from '@/stores/bookmark-store';
import {
  Home01Icon,
  Calendar01Icon,
  UserMultipleIcon,
  JusticeScale01Icon,
  GiftIcon,
  RankingIcon,
} from '@/components/icons/generated';
import { FANTASY_ENABLED } from '@/lib/fantasy/flag';

const NAV_ITEMS = [
  { to: '/', label: 'Home', icon: Home01Icon, exact: true },
  { to: '/events', label: 'Events', icon: Calendar01Icon, exact: false },
  { to: '/corps', label: 'Corps', icon: UserMultipleIcon, exact: false },
  { to: '/judges', label: 'Judges', icon: JusticeScale01Icon, exact: false },
  { to: '/shop', label: 'Shop', icon: GiftIcon, exact: false },
  // Fantasy DCI — only when the feature flag is on (plan §0.5 #9).
  ...(FANTASY_ENABLED
    ? [{ to: '/fantasy', label: 'Fantasy', icon: RankingIcon, exact: false } as const]
    : []),
] as const;

/** Icon with an optional bookmark-count badge overlaid (only on the Shop item). */
function NavIcon({
  icon,
  className,
  count,
}: {
  icon: IconComponent;
  className: string;
  count: number;
}) {
  return (
    <span className="relative inline-flex">
      <Icon icon={icon} className={className} />
      {count > 0 ? (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Site-wide section navigation: an Instagram-style fixed left sidebar on
 * desktop (icon rail on md, icon + label from xl) and bottom tabs on mobile.
 * The matching content offsets live in the root layout's <main>.
 */
export function SiteNav() {
  // localStorage-backed bookmark count, SSR-safe (0 on the server, hydrates on mount).
  const bookmarkCount = useBookmarks().length;
  const countFor = (to: string) => (to === '/shop' ? bookmarkCount : 0);

  return (
    <>
      {/* Desktop sidebar */}
      <nav
        aria-label="Primary"
        className="fixed inset-y-0 left-0 z-40 hidden w-side-nav flex-col border-r border-border bg-background px-3 py-5 md:flex"
      >
        <Link
          to="/"
          className="mb-6 flex items-center justify-center gap-2.5 px-2 focus-visible:outline-none xl:justify-start"
          aria-label="DrumCorps.app home"
        >
          <Logo aria-hidden="true" className="size-8 shrink-0" />
          <span className="hidden text-base font-bold text-text-primary xl:inline">
            DrumCorps.app
          </span>
        </Link>
        <div className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              activeProps={{
                className: 'font-semibold text-text-primary bg-accent [&_svg]:text-primary',
              }}
              inactiveProps={{ className: 'text-text-secondary' }}
              className="flex items-center justify-center gap-3 rounded-lg p-2 transition-colors hover:bg-accent hover:text-text-primary xl:justify-start xl:px-3"
            >
              <NavIcon icon={item.icon} className="size-6 shrink-0" count={countFor(item.to)} />
              <span className="hidden text-[15px] xl:inline">{item.label}</span>
            </Link>
          ))}
        </div>
      </nav>

      {/* Mobile bottom tabs */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 grid min-h-[var(--bottom-nav-bar)] border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
        style={{ gridTemplateColumns: `repeat(${NAV_ITEMS.length}, minmax(0, 1fr))` }}
      >
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: item.exact }}
            activeProps={{ className: 'text-primary' }}
            inactiveProps={{ className: 'text-text-secondary' }}
            className="flex flex-col items-center gap-0.5 py-2 transition-colors"
          >
            <NavIcon icon={item.icon} className="size-5" count={countFor(item.to)} />
            <span className="text-[10px] font-medium">{item.label}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
