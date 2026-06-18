import { useState } from 'react';
import { Icon } from '@/components/icon';
import { UserGroupIcon } from '@/components/icons/generated';
import { ProgressiveImage } from '@/components/progressive-image';
import { cn } from '@/lib/utils';

/**
 * A judge's headshot in a circle, with a graceful fallback to a generic icon
 * when no `photoUrl` is present (the common case today) or the image fails to
 * load. Shared by the profile-page donut center and the directory card ring.
 */
export function JudgeAvatar({
  name,
  photoUrl,
  size,
  iconSize = 'xl',
  className,
}: {
  name: string;
  photoUrl: string | null | undefined;
  /** Rendered diameter in CSS px (drives the resized variant + 2x srcset). */
  size: number;
  iconSize?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = !!photoUrl && !failed;

  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden rounded-full bg-muted',
        className
      )}
      style={{ width: size, height: size }}
    >
      {showImg ? (
        <ProgressiveImage
          src={photoUrl}
          alt={`${name} headshot`}
          width={size}
          widths={[size, size * 2]}
          fit="cover"
          lazy
          assumeCached
          onError={() => setFailed(true)}
          fallback={null}
          className="h-full w-full"
        />
      ) : (
        <Icon icon={UserGroupIcon} size={iconSize} className="text-text-secondary" />
      )}
    </div>
  );
}
