import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { Alert02Icon, InboxIcon, InformationCircleIcon } from '@/components/icons/generated';

type StatusTone = 'error' | 'empty' | 'info';

const TONE: Record<StatusTone, { icon: typeof Alert02Icon; color: string }> = {
  error: { icon: Alert02Icon, color: 'text-destructive' },
  empty: { icon: InboxIcon, color: 'text-text-muted' },
  info: { icon: InformationCircleIcon, color: 'text-info' },
};

/**
 * Card used for terminal non-content states (error / empty / informational).
 * Pair with `LoadingState` for the in-flight case.
 */
export function StatusCard({
  tone = 'info',
  title,
  description,
  action,
  className,
}: {
  tone?: StatusTone;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const { icon, color } = TONE[tone];
  return (
    <Card className={cn('mx-auto max-w-md text-center', className)}>
      <CardContent className="flex flex-col items-center gap-3 py-10">
        <Icon icon={icon} size="xl" className={color} />
        <div className="space-y-1">
          <p className="font-semibold text-text-primary">{title}</p>
          {description ? <p className="text-sm text-text-secondary">{description}</p> : null}
        </div>
        {action}
      </CardContent>
    </Card>
  );
}
