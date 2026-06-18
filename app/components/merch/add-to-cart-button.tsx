// Presentation-only (MERCH_PLAN §25): renders "Add to cart" for prefill products
// or "Buy on website" for link-only products. Emits onAdd; owns no cart state.
import * as Match from 'effect/Match';
import { Button, buttonVariants } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { AddCircleIcon, LinkSquare02Icon } from '@/components/icons/generated';
import { cn } from '@/lib/utils';

export function AddToCartButton({
  capability,
  productUrl,
  onAdd,
  size = 'sm',
  className,
}: {
  capability: 'prefill' | 'link';
  productUrl: string;
  onAdd: () => void;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
}) {
  return Match.value(capability).pipe(
    Match.when('prefill', () => (
      <Button type="button" size={size} className={className} onClick={onAdd}>
        <Icon icon={AddCircleIcon} size="sm" />
        Add to cart
      </Button>
    )),
    Match.orElse(() => (
      <a
        href={productUrl}
        target="_blank"
        rel="noreferrer"
        className={cn(buttonVariants({ variant: 'outline', size }), className)}
      >
        <Icon icon={LinkSquare02Icon} size="sm" />
        Buy on website
      </a>
    ))
  );
}
