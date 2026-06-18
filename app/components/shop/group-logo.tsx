import { useState } from 'react';
import { cn } from '@/lib/utils';
import { proxiedImage } from '@/lib/media';
import { CorpsLogo, corpsLogoSource } from '@/components/corps-logo';
import type { ShopLogoFields } from '@/lib/merch-types';

/**
 * A group's mark, in priority order: its corps logo (proxied/cached), else the
 * storefront logo we scraped + ingested into the media cache (vendors like
 * Funliner / Lot Riot / MBI), else an initials monogram. The store logo is served
 * from our cache (assumeCached) so it works regardless of the source host.
 */
export function GroupLogo({
  name,
  logo,
  storeLogo,
  width = 64,
  className,
}: {
  name: string;
  logo: ShopLogoFields | null;
  storeLogo: string | null;
  width?: number;
  className?: string;
}) {
  const [storeLogoFailed, setStoreLogoFailed] = useState(false);

  if (logo?.corps_logo) {
    return (
      <CorpsLogo name={name} logo={corpsLogoSource(logo)} width={width} className={className} />
    );
  }

  const src =
    storeLogo && !storeLogoFailed ? proxiedImage(storeLogo, { assumeCached: true, width }) : null;
  if (src) {
    return (
      <div
        className={cn(
          'flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted',
          className
        )}
      >
        <img
          src={src}
          alt={`${name} logo`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain p-1.5"
          onError={() => setStoreLogoFailed(true)}
        />
      </div>
    );
  }

  return <CorpsLogo name={name} logo={null} width={width} className={className} />;
}
