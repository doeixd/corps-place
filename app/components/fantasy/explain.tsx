import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { GLOSSARY } from '@/lib/fantasy/glossary';
import { cn } from '@/lib/utils';

/**
 * Inline glossary term (UI/UX plan §3 / UX audit P0). Renders its children (or the
 * term's label) with a dotted underline; click/tap shows the plain-language
 * definition. A Popover (not a hover Tooltip) so it also works on touch devices —
 * Base UI tooltips only open on hover/focus, which mobile never fires.
 * An unknown term renders plainly, so it's safe to wrap anything.
 */
export function Explain({
  term,
  children,
  className,
}: {
  term: string;
  children?: ReactNode;
  className?: string;
}) {
  const entry = GLOSSARY[term];
  if (!entry) return <>{children ?? term}</>;
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2',
          className
        )}
      >
        {children ?? entry.label}
      </PopoverTrigger>
      <PopoverContent className="w-auto max-w-56 p-2.5 text-xs">
        <p>
          <span className="font-medium">{entry.label}</span>
          <span className="mt-0.5 block opacity-90">{entry.description}</span>
        </p>
      </PopoverContent>
    </Popover>
  );
}
