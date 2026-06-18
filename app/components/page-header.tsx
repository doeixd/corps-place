import { Show } from 'jotai-solid-api';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { BackLink } from '@/components/back-link';

/**
 * Page header with an optional back link, title/subtitle, and an actions slot
 * (typically a Button Group). Used at the top of the directory + prediction
 * pages so headers stay structurally consistent.
 */
export function PageHeader({
  title,
  eyebrow,
  subtitle,
  backTo,
  backParams,
  backLabel = 'Back',
  actions,
  extras,
  titleClassName,
  className,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  backTo?: string;
  /** Path params for the back link (forwarded to TanStack Router's `Link`). */
  backParams?: Record<string, string>;
  /**
   * Label for the parent fallback link. When the user reached this page via an
   * in-app navigation, the back control instead reads "Back" and pops history.
   */
  backLabel?: string;
  actions?: ReactNode;
  /** Optional full-width row rendered below the title/actions row (e.g. status chips). */
  extras?: ReactNode;
  /** Extra classes for the `<h1>` (e.g. `text-2.5xl` to bump the heading size). */
  titleClassName?: string;
  className?: string;
}) {
  return (
    <header className={cn('mb-6 space-y-3', className)}>
      <Show when={backTo}>
        {(to) => <BackLink to={to} params={backParams} label={backLabel} />}
      </Show>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Show when={eyebrow}>
            {(e) => <p className="text-xs uppercase tracking-wide text-text-secondary">{e}</p>}
          </Show>
          <h1 className={cn('text-2xl font-bold text-text-primary', titleClassName)}>{title}</h1>
          <Show when={subtitle}>{(s) => <p className="text-text-secondary">{s}</p>}</Show>
        </div>
        <Show when={actions}>
          <div className="flex items-center gap-2">{actions}</div>
        </Show>
      </div>
      <Show when={extras}>
        <div className="flex flex-wrap items-center gap-1.5">{extras}</div>
      </Show>
    </header>
  );
}
