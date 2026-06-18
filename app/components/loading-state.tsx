import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/**
 * A centered spinner + optional label for in-flight async UI. Keep this as the
 * single loading affordance so loading states read consistently across pages.
 */
export function LoadingState({
  label = 'Loading…',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 py-12 text-text-secondary',
        className
      )}
      role="status"
      aria-live="polite"
    >
      <Spinner className="size-6 text-primary" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
