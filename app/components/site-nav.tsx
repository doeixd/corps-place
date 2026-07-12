import { Link } from '@tanstack/react-router';
import { Icon, type IconComponent } from '@/components/icon';
import { Logo } from '@/components/logo';
import { useBookmarks } from '@/stores/bookmark-store';
import {
  Home01Icon,
  Calendar01Icon,
  UserMultipleIcon,
  Analytics01Icon,
  LicenseIcon,
  JusticeScale01Icon,
  GiftIcon,
  RankingIcon,
  Briefcase01Icon,
  Search01Icon,
  AddCircleIcon,
  DashboardSquare01Icon,
  UserCircleIcon,
} from '@/components/icons/generated';
import { FANTASY_ENABLED } from '@/lib/fantasy/flag';
import { BRAND_CONFIG, type Brand } from '@/lib/brand';
import { useBrand } from '@/lib/brand-context';

const CORPS_NAV_ITEMS = [
  { to: '/', label: 'Home', icon: Home01Icon, exact: true },
  { to: '/events', label: 'Events', icon: Calendar01Icon, exact: false },
  { to: '/scores', label: 'Scores', icon: LicenseIcon, exact: false },
  { to: '/corps', label: 'Corps', icon: UserMultipleIcon, exact: false },
  { to: '/rankings', label: 'Rankings', icon: Analytics01Icon, exact: false },
  { to: '/vs', label: 'VS', icon: JusticeScale01Icon, exact: false },
  { to: '/shop', label: 'Shop', icon: GiftIcon, exact: false },
  // Fantasy DCI — only when the feature flag is on (plan §0.5 #9).
  ...(FANTASY_ENABLED
    ? [{ to: '/fantasy', label: 'Fantasy', icon: RankingIcon, exact: false } as const]
    : []),
  // Account shows only for (probably) signed-in visitors — see signedInOnly
  // filtering below; signed-out users reach /account via the footer or any
  // sign-in button, and mobile keeps a tab slot free.
  { to: '/account', label: 'Account', icon: UserCircleIcon, exact: false, signedInOnly: true },
] as const;

// PageantryJobs gets its own sections — never the corps nav (different site).
const JOBS_NAV_ITEMS = [
  { to: '/', label: 'Home', icon: Home01Icon, exact: true },
  { to: '/jobs/board', label: 'Jobs', icon: Search01Icon, exact: false },
  { to: '/jobs/talent', label: 'Talent', icon: UserMultipleIcon, exact: false },
  { to: '/jobs/post', label: 'Post', icon: AddCircleIcon, exact: false },
  { to: '/jobs/me', label: 'Dashboard', icon: DashboardSquare01Icon, exact: false },
] as const;

type NavItem = {
  to: string;
  label: string;
  icon: IconComponent;
  exact: boolean;
  /** Omit from the mobile bottom tab bar (space-capped) — desktop shows all. */
  mobileHidden?: boolean;
  /** Show only when the session-cookie hint says the visitor is signed in. */
  signedInOnly?: boolean;
};

const NAV_ITEMS_BY_BRAND: Record<Brand, readonly NavItem[]> = {
  corps: CORPS_NAV_ITEMS,
  jobs: JOBS_NAV_ITEMS,
};

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
export function SiteNav({ signedIn = false }: { signedIn?: boolean }) {
  // Brand-aware: PageantryJobs and DrumCorps.app share the nav chrome but never
  // each other's sections, logo, or name. readBrand() is isomorphic (host-based)
  // so this resolves identically on SSR and hydration.
  const brand = useBrand();
  // The signed-in gate uses the SSR cookie hint (same value server+client, so
  // no hydration mismatch); a wrong hint only costs a nav item, never access.
  const navItems = NAV_ITEMS_BY_BRAND[brand].filter((i) => !i.signedInOnly || signedIn);
  const mobileItems = navItems.filter((i) => !i.mobileHidden);
  const identity = BRAND_CONFIG[brand];

  // localStorage-backed bookmark count, SSR-safe (0 on the server, hydrates on mount).
  const bookmarkCount = useBookmarks().length;
  const countFor = (to: string) => (to === '/shop' ? bookmarkCount : 0);

  // No manual prewarming of the nav's top-level pages: the router already preloads
  // any nav link on hover/touch-intent (`defaultPreload: 'intent'`), so eagerly
  // idle-warming Rankings/Scores/VS on every page was redundant speculative work
  // that competed with the current page's load on mobile.

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
          aria-label={`${identity.name} home`}
        >
          {brand === 'jobs' ? (
            <Icon icon={Briefcase01Icon} aria-hidden="true" className="size-8 shrink-0 text-primary" />
          ) : (
            <Logo aria-hidden="true" className="size-8 shrink-0" />
          )}
          <span className="hidden text-base font-bold text-text-primary xl:inline">
            {identity.name}
          </span>
        </Link>
        <div className="flex flex-col gap-1">
          {navItems.map((item) => (
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

      {/* Mobile bottom tabs (space-capped: items flagged mobileHidden stay desktop-only) */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-40 grid min-h-[var(--bottom-nav-bar)] border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
        style={{ gridTemplateColumns: `repeat(${mobileItems.length}, minmax(0, 1fr))` }}
      >
        {mobileItems.map((item) => (
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
