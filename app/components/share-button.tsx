// Site-wide share button — the same pattern as the shop product page: ONE
// button that opens the native share sheet where available and copies the link
// to the clipboard otherwise. No social-platform link row.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon';
import { SentIcon, CheckmarkCircle02Icon } from '@/components/icons/generated';
import { track } from '@/lib/analytics/client';

export function ShareButton({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);

  const onShare = async () => {
    if (typeof navigator === 'undefined') return;
    try {
      if (navigator.share) {
        track('share', { via: 'native' });
        await navigator.share({ title, url });
      } else if (navigator.clipboard) {
        track('share', { via: 'copy' });
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user dismissed the share/permission prompt */
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={() => void onShare()}>
      <Icon icon={copied ? CheckmarkCircle02Icon : SentIcon} size="sm" />
      {copied ? 'Link copied!' : 'Share'}
    </Button>
  );
}
