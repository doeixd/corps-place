import { Link } from '@tanstack/react-router';
import { StatusCard } from '@/components/status-card';
import { Button } from '@/components/ui/button';

/** App-wide 404 shown by the router for any unmatched path. */
export function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-8">
      <StatusCard
        tone="info"
        title="Page not found"
        description="The page you're looking for doesn't exist or has moved."
        action={<Button render={<Link to="/" />}>Back to home</Button>}
      />
    </div>
  );
}
