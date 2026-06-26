import { Link } from '@tanstack/react-router';
import { Icon } from '@/components/icon';
import { ArrowRight01Icon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';
import type { ShowPreviewData } from '@/lib/server-fns/contrib';

/**
 * The expanded mini show-page preview rendered under a lineup row (plan §3.10 /
 * M9l). Pure client component — uniform thumbnail, concept excerpt, corps + show
 * title, and a link to the full show page. LEAK-SAFE: no server-only / DB /
 * effect-barrel imports; the preview type is type-only.
 */
export type ShowPreview = ShowPreviewData & {
  corpsName?: string;
  showTitle?: string;
};

export function LineupRowExpanded({
  preview,
  loading,
  corpsName,
  showTitle,
  slug,
  season,
}: {
  preview: ShowPreview | undefined;
  loading: boolean;
  corpsName?: string;
  showTitle?: string;
  slug: string | null;
  season: string;
}) {
  const hasShowLink = Boolean(slug);

  if (loading && !preview) {
    return (
      <div className="flex gap-4 px-1 py-3">
        <div className="size-[120px] shrink-0 animate-pulse rounded-md bg-muted" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }

  const uniformUrl = preview?.uniformImageUrl ?? null;
  const excerpt = preview?.conceptExcerpt ?? null;
  const hasContent = Boolean(uniformUrl || excerpt);

  // Tasteful empty state — invite the first contribution.
  if (!hasContent) {
    return (
      <div className="px-1 py-4 text-sm text-muted-foreground">
        No show details yet —{' '}
        {hasShowLink ? (
          <Link
            to="/shows/$slug/$season"
            params={{ slug: slug!, season }}
            className="font-medium text-primary hover:underline"
          >
            be the first to add them
          </Link>
        ) : (
          <span>be the first to add them</span>
        )}
        .
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-1 py-3 sm:flex-row">
      <div className="size-[120px] shrink-0 overflow-hidden rounded-md border border-border bg-muted">
        {uniformUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={uniformUrl}
            alt={corpsName ? `${corpsName} uniform` : 'Uniform'}
            className="size-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-xs text-muted-foreground/60">
            No image
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        {(corpsName || showTitle) && (
          <div className="space-y-0.5">
            {corpsName && <div className="text-sm font-medium text-text-primary">{corpsName}</div>}
            {showTitle && <div className="text-sm text-text-secondary">{showTitle}</div>}
          </div>
        )}
        {excerpt && <p className={cn('text-sm leading-snug text-muted-foreground')}>{excerpt}</p>}
        {hasShowLink && (
          <Link
            to="/shows/$slug/$season"
            params={{ slug: slug!, season }}
            className="inline-flex items-center gap-1 pt-1 text-sm font-medium text-primary hover:underline"
          >
            View full show page
            <Icon icon={ArrowRight01Icon} size="sm" className="size-3.5" />
          </Link>
        )}
      </div>
    </div>
  );
}
