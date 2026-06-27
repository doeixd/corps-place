import { Card, CardContent } from '@/components/ui/card';
import { Icon, type IconComponent } from '@/components/icon';
import { SignInButton } from '@/components/sign-in-button';

/**
 * Auth gate for the jobs section. With per-host auth, pageantryjobs.com gets its
 * own session, so sign-in happens in place (Google OAuth) on either brand — no
 * cross-domain hand-off.
 */
export function JobsSignInGate({
  icon,
  title,
  path,
}: {
  icon: IconComponent;
  title: string;
  /** App path to return to after sign-in, e.g. "/jobs/post". */
  path: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <Icon icon={icon} size="xl" className="text-text-muted" />
        <div className="space-y-1">
          <p className="font-medium text-text-primary">{title}</p>
          <p className="max-w-sm text-sm text-text-secondary">Sign in to continue.</p>
        </div>
        <SignInButton callbackURL={path}>Continue with Google</SignInButton>
      </CardContent>
    </Card>
  );
}
