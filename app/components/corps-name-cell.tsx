import { Link } from '@tanstack/react-router';
import { CorpsLogo, type LogoSource } from '@/components/corps-logo';
import { useCorpsLogoSource } from '@/components/corps-registry';
import { cn } from '@/lib/utils';

/**
 * A corps identity cell: logo + name, vertically centered. When a `slug` is
 * known it links to the corps profile (and underlines the name on hover);
 * otherwise it renders as plain text. Flexible for any table/list — the logo
 * size and wrapper classes can be tuned per use.
 */
export function CorpsNameCell({
  name,
  slug,
  corpsKey,
  logo,
  className,
  logoClassName,
  logoWidth = 24,
}: {
  name: string;
  slug?: string | null;
  /** Identifies the corps for logo resolution via the surrounding registry. */
  corpsKey?: string | null;
  /**
   * Optional logo override: a plain URL or `{ light, dark }`. When omitted, the
   * logo is resolved from the `CorpsRegistryProvider` by `corpsKey`/`name`.
   */
  logo?: LogoSource;
  className?: string;
  logoClassName?: string;
  /**
   * Rendered logo tile width in CSS px — drives the resized variant + 2x srcset,
   * so the proxy only serves an appropriately small image. Defaults to 24 (the
   * default `sm:size-6` tile); pass a smaller value when the tile is smaller
   * (e.g. 16 for a `size-4` tile) to avoid over-fetching.
   */
  logoWidth?: number;
}) {
  const logoSource = useCorpsLogoSource({ corpsKey, name, override: logo });
  const content = (
    <>
      <CorpsLogo
        name={name}
        logo={logoSource}
        width={logoWidth}
        className={cn('size-5 shrink-0 sm:size-6', logoClassName)}
      />
      <span className="truncate group-hover/corps:underline">{name}</span>
    </>
  );

  // Non-linked fallback keeps identical layout so columns stay aligned.
  if (!slug) {
    return <span className={cn('flex min-w-0 items-center gap-2', className)}>{content}</span>;
  }

  return (
    <Link
      to="/corps/$slug/{-$season}"
      params={{ slug }}
      className={cn(
        'group/corps flex min-w-0 items-center gap-2 transition-colors hover:text-primary',
        className
      )}
    >
      {content}
    </Link>
  );
}
