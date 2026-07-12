import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { PageShell } from '@/components/page-shell';
import { PageHeader } from '@/components/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { SignInButton } from '@/components/sign-in-button';
import { Icon, type IconComponent } from '@/components/icon';
import {
  DashboardSquare01Icon,
  RankingIcon,
  LicenseIcon,
  GiftIcon,
  Settings01Icon,
  Notification01Icon,
  NoteEditIcon,
  UserGroupIcon,
} from '@/components/icons/generated';

type AccountNavItem = { to: string; label: string; icon: IconComponent };

const ACCOUNT_NAV_ITEMS: readonly AccountNavItem[] = [
  { to: '/account', label: 'Overview', icon: DashboardSquare01Icon },
  { to: '/account/leagues', label: 'Leagues', icon: RankingIcon },
  { to: '/account/ballots', label: 'Ballots', icon: LicenseIcon },
  { to: '/account/notifications', label: 'Notifications', icon: Notification01Icon },
  { to: '/account/bookmarks', label: 'Bookmarks', icon: GiftIcon },
  { to: '/account/contributions', label: 'Contributions', icon: NoteEditIcon },
  { to: '/account/profiles', label: 'My profiles', icon: UserGroupIcon },
  { to: '/account/settings', label: 'Settings', icon: Settings01Icon },
] as const;

/**
 * Layout chrome for every `/account/*` page — mirrors AdminShell (the repo's
 * shared-component layout pattern; no route.tsx layout routes). Sub-nav is a
 * left column on md+, a horizontally-scrollable tab rail on mobile.
 */
export function AccountShell({ children }: { children: ReactNode }) {
  return (
    <PageShell>
      <PageHeader title="Your account" backTo="/" backLabel="Home" />
      <div className="flex flex-col gap-5 md:flex-row md:gap-8">
        <nav
          aria-label="Account sections"
          className="flex gap-1 overflow-x-auto md:w-52 md:shrink-0 md:flex-col md:overflow-visible"
        >
          {ACCOUNT_NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === '/account' }}
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
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </PageShell>
  );
}

/** Sign-in prompt rendered by every account tab for anonymous visitors. */
export function AccountSignedOut({ callbackURL }: { callbackURL: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 py-8">
        <h2 className="text-lg font-semibold">Sign in to see your account</h2>
        <p className="text-sm text-text-secondary">
          Your leagues, prediction ballots, notifications and settings live here once
          you&rsquo;re signed in.
        </p>
        <SignInButton callbackURL={callbackURL} />
      </CardContent>
    </Card>
  );
}
