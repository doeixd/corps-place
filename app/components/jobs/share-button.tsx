import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { useState } from 'react';
import { CheckmarkCircle02Icon } from '@/components/icons/generated';

const SHARE_PLATFORMS = [
  {
    name: 'Twitter',
    url: (u: string, t: string) =>
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(t)}&url=${encodeURIComponent(u)}`,
  },
  {
    name: 'Facebook',
    url: (u: string) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}`,
  },
  {
    name: 'LinkedIn',
    url: (u: string, t: string) =>
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(u)}&title=${encodeURIComponent(t)}`,
  },
  { name: 'Copy link', copy: true },
];

export function ShareButton({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-1">
      {SHARE_PLATFORMS.map((platform) =>
        platform.copy ? (
          <Button
            key="copy"
            variant="ghost"
            size="xs"
            onClick={async () => {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="text-text-muted hover:text-text-primary"
          >
            <Icon icon={copied ? CheckmarkCircle02Icon : CheckmarkCircle02Icon} size="xs" />
            {copied ? 'Copied!' : 'Copy link'}
          </Button>
        ) : platform.url ? (
          <a
            key={platform.name}
            href={platform.url(url, title)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-muted hover:text-text-primary"
          >
            {platform.name}
          </a>
        ) : null
      )}
    </div>
  );
}
