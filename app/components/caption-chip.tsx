import { Icon } from '@/components/icon';
import { cn } from '@/lib/utils';
import { captionFamilyMeta } from '@/lib/caption-family';

/**
 * A colored pill for a judged caption, tinted by its scoring family (General
 * Effect = amber, Visual = green, Music = blue/purple) with a family icon.
 */
export function CaptionChip({
  caption,
  className,
  showIcon = true,
}: {
  caption: string;
  className?: string;
  showIcon?: boolean;
}) {
  const meta = captionFamilyMeta(caption);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
        meta.chipClass,
        className
      )}
    >
      {showIcon ? <Icon icon={meta.icon} size="xs" /> : null}
      {caption}
    </span>
  );
}
