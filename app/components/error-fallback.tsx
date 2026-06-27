import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { useEffect } from 'react';
import { StatusCard } from '@/components/status-card';
import { Button } from '@/components/ui/button';

/**
 * App-wide error screen for any uncaught route render/loader error. Wired as the
 * router's `defaultErrorComponent`, so instead of TanStack's raw error dump the
 * user gets a branded, recoverable screen: "Try again" re-runs the boundary +
 * invalidates loaders; "Back to home" navigates away from the broken route.
 */
export function RouteErrorFallback({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  useEffect(() => {
    console.error('[route] uncaught error:', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-8">
      <StatusCard
        tone="error"
        title="Something went wrong"
        description="An unexpected error interrupted this page. You can retry, or head back home."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => {
                reset();
                void router.invalidate();
              }}
            >
              Try again
            </Button>
            <Button variant="outline" size="sm" render={<Link to="/" />}>
              Back to home
            </Button>
          </div>
        }
      />
    </div>
  );
}
