import { cn } from '@/lib/utils';

/**
 * Shared "data may contain errors" note. Defaults to a bottom-of-page footer
 * (`mt-8`); pass `className` to place it elsewhere — e.g. at the TOP of long /
 * virtualized lists where a footer would never be scrolled into view.
 */
export function DataDisclaimer({ className = 'mt-8' }: { className?: string }) {
  return (
    <p className={cn('text-center text-xs text-muted-foreground', className)}>
      Data sourced from publicly available information online and may contain errors.
    </p>
  );
}
