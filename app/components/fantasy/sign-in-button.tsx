import { Button } from '@/components/ui/button';
import { signIn } from '@/lib/auth-client';

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
      onClick={() => void signIn.social({ provider: 'google', callbackURL })}
    >
      {children}
    </Button>
  );
}
