import { Card, CardContent } from '@/components/ui/card';
import { Icon, type IconComponent } from '@/components/icon';
import { SignInButton } from '@/components/sign-in-button';
import { readBrand } from '@/lib/brand';

const MAIN_ORIGIN = 'https://drumcorps.app';

/**
 * Auth gate for the jobs section. Accounts live on DrumCorps.app (a single
 * registrable domain can't share a session cookie with pageantryjobs.com), so on
 * the jobs brand we send signed-out users to the main domain to sign in and use
 * account features; on the corps brand we start Google OAuth in place.
 */
export function JobsSignInGate({
  icon,
  title,
  path,
}: {
  icon: IconComponent;
  title: string;
  /** App path to return to / continue at, e.g. "/jobs/post". */
  path: string;
}) {
  const brand = readBrand();
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <Icon icon={icon} size="xl" className="text-text-muted" />
        <div className="space-y-1">
          <p className="font-medium text-text-primary">{title}</p>
          <p className="max-w-sm text-sm text-text-secondary">
            {brand === 'jobs'
              ? 'Posting jobs and managing your profile happen on DrumCorps.app, where your account lives. Continue there to sign in.'
              : 'Sign in to continue.'}
          </p>
        </div>
        {brand === 'jobs' ? (
          <a
            href={`${MAIN_ORIGIN}${path}`}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80"
          >
            Continue on DrumCorps.app
          </a>
        ) : (
          <SignInButton callbackURL={path}>Continue with Google</SignInButton>
        )}
      </CardContent>
    </Card>
  );
}
