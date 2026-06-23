import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { GLOSSARY } from '@/lib/fantasy/glossary';
import { cn } from '@/lib/utils';

/**
 * Inline glossary term (UI/UX plan §3 / UX audit P0). Renders its children (or the
 * term's label) with a dotted underline; hover/tap shows the plain-language
 * definition. An unknown term renders plainly, so it's safe to wrap anything.
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
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              'cursor-help underline decoration-dotted decoration-muted-foreground/60 underline-offset-2',
              className
            )}
          />
        }
      >
        {children ?? entry.label}
      </TooltipTrigger>
      <TooltipContent className="max-w-56">
        <span className="font-medium">{entry.label}</span>
        <span className="mt-0.5 block opacity-90">{entry.description}</span>
      </TooltipContent>
    </Tooltip>
  );
}
