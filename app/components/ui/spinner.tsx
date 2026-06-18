import { cn } from '@/lib/utils';
import { Loading03Icon } from '@/components/icons/generated';

function Spinner({ className, ...props }: React.ComponentProps<'svg'>) {
  return (
    <Loading03Icon
      role="status"
      aria-label="Loading"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  );
}

export { Spinner };
