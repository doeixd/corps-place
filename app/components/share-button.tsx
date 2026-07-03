// Site-wide share row (generalized from jobs/share-button — platform links +
// copy-link, nothing brand-specific). On devices with the Web Share API a
// native "Share" button leads; the platform links remain for desktop.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { CheckmarkCircle02Icon } from '@/components/icons/generated';
import { track } from '@/lib/analytics/client';

const SHARE_PLATFORMS: { name: string; url?: (u: string, t: string) => string; copy?: boolean }[] = [
  {
    name: 'Twitter',
    url: (u, t) =>
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(u)}`,
  },
  {
    name: 'Facebook',
    url: (u) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}`,
  },
  {
    name: 'Reddit',
    url: (u, t) =>
      `https://www.reddit.com/submit?url=${encodeURIComponent(u)}&title=${encodeURIComponent(t)}`,
  },
  { name: 'Copy link', copy: true },
];

export function ShareButton({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div className="flex flex-wrap items-center gap-1">
      {canNativeShare ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            track('share', { via: 'native' });
            void navigator.share({ url, title }).catch(() => {});
          }}
        >
          Share
        </Button>
      ) : null}
      {SHARE_PLATFORMS.map((platform) =>
        platform.copy ? (
          <Button
            key="copy"
            variant="ghost"
            size="xs"
            onClick={async () => {
              track('share', { via: 'copy' });
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="text-text-muted hover:text-text-primary"
          >
            <Icon icon={CheckmarkCircle02Icon} size="xs" />
            {copied ? 'Copied!' : 'Copy link'}
          </Button>
        ) : platform.url ? (
          <a
            key={platform.name}
            href={platform.url(url, title)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => track('share', { via: platform.name.toLowerCase() })}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-muted hover:text-text-primary"
          >
            {platform.name}
          </a>
        ) : null
      )}
    </div>
  );
}
