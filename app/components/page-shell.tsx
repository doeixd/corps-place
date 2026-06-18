import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function PageShell({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mx-auto max-w-[1300px] p-3 sm:p-6 md:p-8', className)} {...props} />;
}
