import { Button } from '@/components/ui/button';
import { signIn } from '@/lib/auth-client';
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
      onClick={() => {
        track('sign_in_click', { to: callbackURL.slice(0, 60) });
        // Remember where to land even if the first-sign-in consent step interrupts
        // the OAuth callbackURL — the consent gate reads this after the user agrees.
        try {
          sessionStorage.setItem('post-auth-redirect', callbackURL);
        } catch {
          /* private mode / storage disabled — fall back to callbackURL only */
        }
        void signIn.social({ provider: 'google', callbackURL });
      }}
    >
      {children}
    </Button>
  );
}
