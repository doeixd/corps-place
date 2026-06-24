import { Link } from '@tanstack/react-router';
import { Icon, type IconComponent } from '@/components/icon';
import {
  DashboardSquare01Icon,
  WorkflowSquare01Icon,
  NoteEditIcon,
  UserGroupIcon,
  RankingIcon,
  Analytics01Icon,
  UserMultipleIcon,
  CustomerSupportIcon,
  LicenseIcon,
} from '@/components/icons/generated';
import { FANTASY_ENABLED } from '@/lib/fantasy/flag';

// Pure, client-safe role rank — do NOT import from `@/lib/authz` here: that module
// imports the better-auth server (`./auth`) and would leak server-only code into the
// client bundle (the node:fs blank-screen class of bug). The console's real gate is
// the per-route loader + per-server-fn `requireCapability`; this only hides links.
type AdminRole = 'moderator' | 'admin';
const RANK: Record<string, number> = { user: 1, trusted: 2, moderator: 3, admin: 4 };
const atLeast = (role: string, min: AdminRole) => (RANK[role] ?? 0) >= RANK[min];

type AdminNavItem = { to: string; label: string; icon: IconComponent; min: AdminRole };

const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { to: '/admin', label: 'Overview', icon: DashboardSquare01Icon, min: 'moderator' },
  { to: '/admin/jobs', label: 'Jobs & scripts', icon: WorkflowSquare01Icon, min: 'admin' },
  { to: '/admin/content', label: 'Content', icon: NoteEditIcon, min: 'moderator' },
  { to: '/admin/identity', label: 'Identity', icon: UserGroupIcon, min: 'moderator' },
  ...(FANTASY_ENABLED
    ? [
        {
          to: '/admin/fantasy/leagues',
          label: 'Fantasy',
          icon: RankingIcon,
          min: 'moderator',
        } as const,
        {
          to: '/admin/fantasy/test-lab',
          label: 'Test Lab',
          icon: RankingIcon,
          min: 'admin',
        } as const,
      ]
    : []),
  { to: '/admin/system', label: 'System', icon: Analytics01Icon, min: 'moderator' },
  { to: '/admin/users', label: 'Users', icon: UserMultipleIcon, min: 'admin' },
  { to: '/admin/support', label: 'Support', icon: CustomerSupportIcon, min: 'moderator' },
  { to: '/admin/audit', label: 'Audit', icon: LicenseIcon, min: 'moderator' },
] as const;

/**
 * Secondary navigation for the admin console (ADMIN_PAGE_PLAN §1). Items are
 * filtered to what the viewer's role can reach. Renders as a left column on md+
 * and a horizontally-scrollable tab rail on mobile. Lives INSIDE the app's main
 * content area (the global SiteNav rail is still present), so it's a sub-nav.
 */
export function AdminNav({ role }: { role: string }) {
  const items = ADMIN_NAV_ITEMS.filter((i) => atLeast(role, i.min));
  return (
    <nav
      aria-label="Admin sections"
      className="flex gap-1 overflow-x-auto md:w-52 md:shrink-0 md:flex-col md:overflow-visible"
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: item.to === '/admin' }}
          activeProps={{
            className: 'bg-accent font-semibold text-text-primary [&_svg]:text-primary',
          }}
          inactiveProps={{ className: 'text-text-secondary' }}
          className="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-text-primary"
        >
          <Icon icon={item.icon} size="md" className="shrink-0" />
          <span className="whitespace-nowrap">{item.label}</span>
        </Link>
      ))}
    </nav>
  );
}
