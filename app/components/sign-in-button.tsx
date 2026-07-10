import { Button } from '@/components/ui/button';
import { track } from '@/lib/analytics/client';

/** Google sign-in that returns to `callbackURL` after the OAuth round-trip. */
export function SignInButton({
  callbackURL,
  className,
  children = 'Continue with Google',
}: {
  callbackURL: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Button
      className={className}
      onClick={async () => {
        track('sign_in_click', { to: callbackURL.slice(0, 60) });
        // Remember where to land even if the first-sign-in consent step interrupts
        // the OAuth callbackURL — the consent gate reads this after the user agrees.
        try {
          sessionStorage.setItem('post-auth-redirect', callbackURL);
        } catch {
          /* private mode / storage disabled — fall back to callbackURL only */
        }
        // Load the better-auth client only on click, not at import — a static
        // import puts ~31KB of auth client on every page that shows a sign-in
        // button (incl. logged-out /fantasy). This runs right before an OAuth
        // redirect that navigates away, so the one-time chunk fetch is invisible.
        const { signIn } = await import('@/lib/auth-client');
        void signIn.social({ provider: 'google', callbackURL });
      }}
    >
      {children}
    </Button>
  );
}
