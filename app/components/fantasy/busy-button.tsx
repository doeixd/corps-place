import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

/**
 * A Button that shows a leading spinner and disables itself while `busy`.
 * Standardizes the loading affordance across the fantasy action buttons.
 */
export function BusyButton({
  busy,
  disabled,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { busy?: boolean }) {
  return (
    <Button disabled={busy || disabled} {...props}>
      {busy ? <Spinner className="size-3.5" /> : null}
      {children}
    </Button>
  );
}
