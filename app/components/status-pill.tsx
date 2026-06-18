import { Badge } from '@/components/reui/badge';
import { Icon, type IconComponent } from '@/components/icon';
import { cn } from '@/lib/utils';
import { CheckmarkCircle02Icon, CircleIcon } from '@/components/icons/generated';

/**
 * A boolean status pill used across the event directory + prediction pages to
 * surface readiness flags (lineup, judges, scores, prediction). Active is a
 * super-subtle near-white grey pill; inactive is the same shape with a
 * transparent fill and a hairline border. Keeping the fill neutral lets the
 * chips stay subordinate to the event title. Pass `icon` for a label-specific
 * glyph (falls back to a check/circle). The glyph is neutral grey at rest; pass
 * `iconClassName` with a `group-hover:` theme tint (e.g. `group-hover:text-info`)
 * to have its color fade in when the pill is hovered.
 */
export function StatusPill({
  label,
  active,
  icon,
  iconClassName,
}: {
  label: string;
  active: boolean;
  icon?: IconComponent;
  iconClassName?: string;
}) {
  return (
    <Badge
      variant={active ? 'secondary' : 'outline'}
      size="sm"
      radius="full"
      className={cn('group', active && 'bg-muted/50 text-text-secondary', 'pl-1.5 pr-[7px]')}
    >
      <Icon
        icon={icon ?? (active ? CheckmarkCircle02Icon : CircleIcon)}
        size="sm"
        className={cn(
          'size-3.5 transition-colors',
          active ? 'text-muted-foreground' : 'text-text-muted',
          iconClassName
        )}
      />
      {label}
    </Badge>
  );
}
