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
}) {
  const logoSource = useCorpsLogoSource({ corpsKey, name, override: logo });
  const content = (
    <>
      <CorpsLogo
        name={name}
        logo={logoSource}
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
